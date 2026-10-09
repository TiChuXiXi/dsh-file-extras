/**
 * dsh-file-extras 自检：不开 DSH、不开浏览器，直接用假的 ctx / req / res 驱动 host 半区的路由。
 *
 * 覆盖的是 host 侧最容易被写错、又最难在浏览器里看出问题的那几段：
 *   · stat 的 大小 / mtime / 一级子项数量；
 *   · 工作区包含判定（区外路径、`..` 穿越、软链接逃逸都要被拒）；
 *   · 上传的原始字节落盘 + 重名自动加序号（绝不覆盖）；
 *   · 下载的 Content-Disposition / Content-Length / 字节一致性；
 *   · RPC 信封（rpcId 回显、失败码）。
 *
 * 跑法：node scripts/selftest.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { apply } from '../index.js'

const CHANNEL = '/dsh-file-extras'

/* ------------------------------------------------------------ 假 ctx / req / res */

let routeHandler = null
let rejection = undefined

apply({
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routeHandler = route.handler
          return () => { routeHandler = null }
        },
      }
    }
    if (name === 'connection') return { requestRejection: () => rejection }
    return undefined
  },
  effect(setup) { return setup() },
})

assert.ok(routeHandler !== null, '前缀路由没有注册')

/** 收集假响应的状态、响应头与响应体。 */
function makeResponse() {
  const chunks = []
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  response.status = 0
  response.headers = {}
  response.writeHead = (status, headers) => {
    response.status = status
    response.headers = headers ?? {}
    return response
  }
  const originalEnd = response.end.bind(response)
  response.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk))
    originalEnd()
    return response
  }
  response.text = () => Buffer.concat(chunks).toString('utf8')
  response.body = () => Buffer.concat(chunks)
  return response
}

/** 造一个够用的 IncomingMessage：可异步迭代 + method/url/headers。 */
async function* bodyOf(payload) {
  if (payload === undefined || payload === null || payload.length === 0) return
  yield Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
}

async function call(method, path, payload) {
  const response = makeResponse()
  // 先把 finish 的等待挂上：下载端点是在响应写完之后才 resolve 的，
  // 事后再 on('finish') 会永远等不到。
  const finished = new Promise((settle) => {
    if (response.writableFinished) settle()
    else response.on('finish', settle)
  })
  const request = bodyOf(payload)
  request.method = method
  request.url = path
  request.headers = { host: '127.0.0.1:3080' }
  await routeHandler(request, response)
  await finished
  return response
}

/** 发一条 RPC。 */
async function rpc(endpoint, payload, rpcId = `test-${endpoint}`) {
  const response = await call('POST', `${CHANNEL}/${endpoint}`, JSON.stringify({
    type: 'client-request',
    rpcId,
    method: endpoint,
    payload,
  }))
  const envelope = JSON.parse(response.text())
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, rpcId, 'rpcId 没有回显')
  return envelope.result
}

/* ------------------------------------------------------------------- 用例 */

const workspace = await mkdtemp(join(tmpdir(), 'dsh-fx-'))
const outside = await mkdtemp(join(tmpdir(), 'dsh-fx-outside-'))
let failures = 0

async function test(title, body) {
  try {
    await body()
    console.log(`  ok  ${title}`)
  } catch (cause) {
    failures += 1
    console.error(`FAIL  ${title}\n      ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

try {
  await writeFile(join(workspace, 'hello.txt'), 'hello world')
  await mkdir(join(workspace, 'sub'))
  await writeFile(join(workspace, 'sub', 'a.txt'), 'a')
  await writeFile(join(workspace, 'sub', 'b.txt'), 'bb')
  await mkdir(join(workspace, 'sub', 'deep'))
  const stamp = new Date('2026-03-04T05:06:07Z')
  await utimes(join(workspace, 'hello.txt'), stamp, stamp)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  try {
    await symlink(outside, join(workspace, 'escape'), 'junction')
  } catch {
    // Windows 上非开发者模式可能建不了链接：跳过逃逸用例而不是让自检整体失败。
  }

  console.log('stat')

  await test('文件：给出字节数、mtime、类型', async () => {
    const result = await rpc('stat', { root: workspace, paths: [join(workspace, 'hello.txt')] })
    assert.equal(result.ok, true, JSON.stringify(result))
    const entry = result.value.entries[0]
    assert.equal(entry.type, 'file')
    assert.equal(entry.size, 11)
    assert.equal(Math.round(entry.mtimeMs), stamp.getTime())
  })

  await test('目录：子项数量只数第一级，不递归', async () => {
    const result = await rpc('stat', { root: workspace, paths: [join(workspace, 'sub'), workspace] })
    assert.equal(result.ok, true, JSON.stringify(result))
    const [sub, root] = result.value.entries
    assert.equal(sub.type, 'directory')
    assert.equal(sub.childCount, 3, 'sub 下应有 a.txt / b.txt / deep 三项')
    assert.equal(root.childCount, 3, '工作区根下应有 hello.txt / sub / escape 三项')
    assert.equal(typeof sub.mtimeMs, 'number')
    assert.equal(typeof root.mtimeMs, 'number')
  })

  await test('不存在的路径回 missing，不抛整单失败', async () => {
    const result = await rpc('stat', { root: workspace, paths: [join(workspace, 'nope.txt')] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.entries[0].error, 'missing')
  })

  await test('工作区外的路径被拒', async () => {
    const result = await rpc('stat', { root: workspace, paths: [join(outside, 'secret.txt'), join(workspace, '..', 'x')] })
    assert.equal(result.ok, true, JSON.stringify(result))
    for (const entry of result.value.entries) {
      assert.equal(entry.error, 'file-extras/outside-workspace', JSON.stringify(entry))
    }
  })

  await test('软链接指向工作区外也被拒', async () => {
    const result = await rpc('stat', { root: workspace, paths: [join(workspace, 'escape', 'secret.txt')] })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (result.value.entries[0].error === 'missing') return // 没建出链接：视为跳过
    assert.equal(result.value.entries[0].error, 'file-extras/outside-workspace')
  })

  await test('盘符根被拒绝当工作区根', async () => {
    const driveRoot = `${workspace.slice(0, 2)}\\`
    const result = await rpc('stat', { root: driveRoot, paths: [join(workspace, 'hello.txt')] })
    assert.equal(result.ok, false, '盘符根必须被拒')
    assert.equal(result.error.code, 'file-extras/outside-workspace')
  })

  console.log('upload')

  await test('上传：字节原样落盘', async () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(join(workspace, 'sub'))}&name=${encodeURIComponent('bin.dat')}`, bytes)
    const body = JSON.parse(response.text())
    assert.equal(body.ok, true, response.text())
    assert.equal(body.value.name, 'bin.dat')
    assert.equal(body.value.renamed, false)
    assert.deepEqual(await readFile(join(workspace, 'sub', 'bin.dat')), bytes)
  })

  await test('上传重名：自动加序号，原文件不动', async () => {
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(join(workspace, 'sub'))}&name=${encodeURIComponent('bin.dat')}`, Buffer.from('second'))
    const body = JSON.parse(response.text())
    assert.equal(body.ok, true, response.text())
    assert.equal(body.value.name, 'bin (1).dat')
    assert.equal(body.value.renamed, true)
    assert.equal(await readFile(join(workspace, 'sub', 'bin (1).dat'), 'utf8'), 'second')
    assert.deepEqual(await readFile(join(workspace, 'sub', 'bin.dat')), Buffer.from([0, 1, 2, 253, 254, 255]))
  })

  await test('上传：带路径分隔符的文件名被压成单段', async () => {
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(workspace)}&name=${encodeURIComponent('..\\..\\evil.txt')}`, Buffer.from('x'))
    const body = JSON.parse(response.text())
    assert.equal(body.ok, true, response.text())
    assert.equal(body.value.name, 'evil.txt')
    assert.ok((await stat(join(workspace, 'evil.txt'))).isFile())
    await assert.rejects(stat(join(tmpdir(), 'evil.txt')))
  })

  await test('上传目标在工作区外被拒', async () => {
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(outside)}&name=${encodeURIComponent('x.txt')}`, Buffer.from('x'))
    const body = JSON.parse(response.text())
    assert.equal(body.ok, false, response.text())
    assert.equal(body.error.code, 'file-extras/outside-workspace')
  })

  console.log('download')

  await test('下载：响应头与字节都对得上', async () => {
    const target = join(workspace, 'hello.txt')
    const response = await call('GET', `${CHANNEL}/download?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent(target)}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-length'], '11')
    assert.match(response.headers['content-disposition'], /^attachment; filename="hello\.txt"; filename\*=UTF-8''hello\.txt$/)
    assert.equal(response.text(), 'hello world')
  })

  await test('下载：区外文件被拒', async () => {
    const response = await call('GET', `${CHANNEL}/download?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(outside, 'secret.txt'))}`)
    assert.equal(response.status, 403, `状态码应为 403，实际 ${response.status}`)
    const body = JSON.parse(response.text())
    assert.equal(body.ok, false, response.text())
    assert.equal(body.error.code, 'file-extras/outside-workspace')
  })

  await test('下载：目录被拒', async () => {
    const response = await call('GET', `${CHANNEL}/download?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, 'sub'))}`)
    assert.equal(response.status, 400, `状态码应为 400，实际 ${response.status}`)
    const body = JSON.parse(response.text())
    assert.equal(body.ok, false, response.text())
    assert.equal(body.error.code, 'file-extras/not-regular-file')
  })

  await test('下载：不存在的文件回 404', async () => {
    const response = await call('GET', `${CHANNEL}/download?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, 'gone.txt'))}`)
    assert.equal(response.status, 404, `状态码应为 404，实际 ${response.status}`)
    const body = JSON.parse(response.text())
    assert.equal(body.error.code, 'file-extras/not-found')
  })

  await test('上传失败也回错误状态码（不是 200 + 错误信封）', async () => {
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(outside)}&name=${encodeURIComponent('x.txt')}`, Buffer.from('x'))
    assert.equal(response.status, 403, `状态码应为 403，实际 ${response.status}`)
    const body = JSON.parse(response.text())
    assert.equal(body.ok, false, response.text())
  })

  console.log('通道')

  await test('未知端点回错码而不是崩掉', async () => {
    const result = await rpc('nope', {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'file-extras/unknown-endpoint')
  })

  await test('信任栅栏拒绝时直接回状态码', async () => {
    rejection = 403
    const response = await call('GET', `${CHANNEL}/download?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent(join(workspace, 'hello.txt'))}`)
    rejection = undefined
    assert.equal(response.status, 403)
    assert.equal(response.text(), 'forbidden')
  })
} finally {
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
