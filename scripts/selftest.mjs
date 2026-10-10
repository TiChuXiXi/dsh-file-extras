/**
 * dsh-file-extras 自检：不开 DSH、不开浏览器，直接用假的 ctx / req / res 驱动 host 半区的路由。
 *
 * 覆盖的是 host 侧最容易被写错、又最难在浏览器里看出问题的那几段：
 *   · stat 的 大小 / mtime / 一级子项数量；
 *   · 工作区包含判定（区外路径、`..` 穿越、软链接逃逸都要被拒）；
 *   · 上传的原始字节落盘 + 重名自动加序号（绝不覆盖）；
 *   · 下载的 Content-Disposition / Content-Length / 字节一致性；
 *   · history 只回真实用户指令（系统注入的 user/message 必须被挡住）；
 *   · 文件驱动的斜杠命令：frontmatter / $ARGUMENTS / 重名跳过；
 *   · RPC 信封（rpcId 回显、失败码）。
 *
 * 跑法：node scripts/selftest.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { apply } from '../index.js'
import { buildPrompt, commandNameFromFile, discoverCommandFiles, parseCommandFile, renderPrompt } from '../lib/commands-md.js'
import { moveToTrash } from '../lib/trash.js'
import { addedTrashEntries, purgeTrash, snapshotTrash } from './trash-bin.mjs'

const CHANNEL = '/dsh-file-extras'

/* ------------------------------------------------------------ 假 ctx / req / res */

/**
 * 命令目录走 `$DSH_HOME`：自检**不碰**用户真实的 `~/.dsh/commands`。
 * 必须在 apply() 之前设好 —— 插件启动时就会扫一遍目录。
 */
const fakeDshHome = await mkdtemp(join(tmpdir(), 'dsh-fx-home-'))
const fakeCommandDir = join(fakeDshHome, 'commands')
await mkdir(fakeCommandDir, { recursive: true })
await writeFile(join(fakeCommandDir, 'greet.md'), '---\ndescription: 打个招呼\ninput-hint: <名字>\n---\n\n你好，$ARGUMENTS\n')
await writeFile(join(fakeCommandDir, 'plain.md'), '没有任何 frontmatter 的正文')
await writeFile(join(fakeCommandDir, 'goal.md'), '与 app 级命令重名，必须被跳过')
await writeFile(join(fakeCommandDir, 'Bad Name.md'), '文件名不合命令文法，必须被跳过')
await writeFile(join(fakeCommandDir, 'notes.txt'), '不是 .md，必须被跳过')
process.env.DSH_HOME = fakeDshHome

let routeHandler = null
let rejection = undefined

/** 假命令注册表：`goal` 先占位，用来验证重名只跳过这一条。 */
const registered = new Map()
registered.set('goal', { name: 'goal' })

/** 假 sessionQuery：事件日志由用例按需填充。 */
let sessionEvents = []
let sessionQueryPresent = true
let sessionQueryThrows = false

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
    if (name === 'commands') {
      return {
        register(definition) {
          if (registered.has(definition.name)) {
            throw new TypeError(`command name "${definition.name}" 已经被占用`)
          }
          registered.set(definition.name, definition)
          return () => { registered.delete(definition.name) }
        },
      }
    }
    if (name === 'sessionQuery') {
      if (!sessionQueryPresent) return undefined
      return {
        async readSession() {
          if (sessionQueryThrows) throw new Error('会话日志读不了')
          return { events: sessionEvents }
        },
      }
    }
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
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  // 大 body 分片吐出：真正的上传是流式落盘的，一次 yield 整个 buffer 测不出这一点。
  const CHUNK = 64 * 1024
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    yield buffer.subarray(offset, Math.min(offset + CHUNK, buffer.length))
  }
}

async function call(method, path, payload, headers) {
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
  request.headers = { host: '127.0.0.1:3080', ...(headers ?? {}) }
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

/** 轮询等一个条件成立（插件扫命令目录是异步的，没有可 await 的句柄）。 */
async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((settle) => setTimeout(settle, 25))
  }
  throw new Error(`等待超时：${label}`)
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

  await test('上传：大文件流式落盘且字节逐字节一致', async () => {
    // 24 MiB，分 64 KiB 片喂进去 —— 走的是 pipeline(request → 计数 → createWriteStream)。
    const big = Buffer.alloc(24 * 1024 * 1024)
    for (let index = 0; index < big.length; index += 1) big[index] = (index * 31 + 7) & 0xff
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(workspace)}&name=${encodeURIComponent('big.bin')}`, big)
    const body = JSON.parse(response.text())
    assert.equal(body.ok, true, response.text())
    assert.equal(body.value.size, big.length)
    const written = await readFile(join(workspace, 'big.bin'))
    assert.equal(written.length, big.length)
    assert.equal(createHash('sha256').update(written).digest('hex'), createHash('sha256').update(big).digest('hex'))
  })

  await test('上传：声明超限时用 content-length 提前挡掉（连 body 都不读）', async () => {
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(workspace)}&name=${encodeURIComponent('huge.bin')}`, Buffer.from('x'), { 'content-length': String(8 * 1024 * 1024 * 1024) })
    assert.equal(response.status, 413, `状态码应为 413，实际 ${response.status}`)
    const body = JSON.parse(response.text())
    assert.equal(body.error.code, 'file-extras/too-large')
    await assert.rejects(stat(join(workspace, 'huge.bin')))
  })

  await test('上传：成功与失败都不在工作区留下 .part- 临时文件', async () => {
    const leftovers = (await readdir(workspace, { recursive: true })).filter((name) => String(name).includes('.part-'))
    assert.deepEqual(leftovers, [])
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

  await test('下载：大文件流式回传、不设大小上限、字节一致', async () => {
    // 上一个用例写进去的 24 MiB：确认没有 MIN(512MiB) 那类上限，也没有被截断。
    const target = join(workspace, 'big.bin')
    const response = await call('GET', `${CHANNEL}/download?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent(target)}`)
    assert.equal(response.status, 200, `状态码应为 200，实际 ${response.status}`)
    const size = Number(response.headers['content-length'])
    assert.equal(size, 24 * 1024 * 1024)
    const got = response.body()
    assert.equal(got.length, size)
    assert.equal(createHash('sha256').update(got).digest('hex'), createHash('sha256').update(await readFile(target)).digest('hex'))
  })

  await test('上传失败也回错误状态码（不是 200 + 错误信封）', async () => {
    const response = await call('POST', `${CHANNEL}/upload?root=${encodeURIComponent(workspace)}&dir=${encodeURIComponent(outside)}&name=${encodeURIComponent('x.txt')}`, Buffer.from('x'))
    assert.equal(response.status, 403, `状态码应为 403，实际 ${response.status}`)
    const body = JSON.parse(response.text())
    assert.equal(body.ok, false, response.text())
  })

  console.log('remove')

  /** 回收站快照：这一段测试会往回收站扔东西，结束时按差集清干净。 */
  const trashBefore = await snapshotTrash(workspace)

  await test('删除：默认走回收站（文件），mode 标成 trash', async () => {
    const target = join(workspace, 'doomed.txt')
    await writeFile(target, 'bye')
    const result = await rpc('remove', { root: workspace, paths: [target] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.mode, 'trash')
    assert.equal(result.value.removed, 1)
    assert.deepEqual(result.value.results, [{ path: target, ok: true, type: 'file', mode: 'trash' }])
    await assert.rejects(stat(target))
  })

  await test('删除：默认走回收站（文件夹连同全部内容）', async () => {
    const folder = join(workspace, 'trash-me')
    await mkdir(join(folder, 'deep', 'deeper'), { recursive: true })
    await writeFile(join(folder, 'deep', 'deeper', 'x.txt'), 'x')
    const result = await rpc('remove', { root: workspace, paths: [folder] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.mode, 'trash')
    assert.deepEqual(result.value.results, [{ path: folder, ok: true, type: 'directory', mode: 'trash' }])
    await assert.rejects(stat(folder))
  })

  await test('删除：确实进了回收站（回收站里多出成对的 $I/$R 条目）', async () => {
    const added = await addedTrashEntries(workspace, trashBefore)
    const metadata = added.filter((name) => name.startsWith('$I'))
    const payload = added.filter((name) => name.startsWith('$R'))
    assert.ok(metadata.length >= 2, `应有至少 2 条 $I 记录，实际 ${JSON.stringify(added)}`)
    assert.ok(payload.length >= 2, `应有至少 2 条 $R 数据，实际 ${JSON.stringify(added)}`)
    assert.equal(metadata.length, payload.length, '$I 与 $R 必须成对')
  })

  await test('删除：permanent=true 走 fs.rm，mode 标成 permanent，不进回收站', async () => {
    const target = join(workspace, 'really-gone.txt')
    await writeFile(target, 'x')
    const before = await addedTrashEntries(workspace, trashBefore)
    const result = await rpc('remove', { root: workspace, paths: [target], permanent: true })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.mode, 'permanent')
    assert.deepEqual(result.value.results, [{ path: target, ok: true, type: 'file', mode: 'permanent' }])
    await assert.rejects(stat(target))
    assert.deepEqual(await addedTrashEntries(workspace, trashBefore), before, '永久删除不该往回收站里放东西')
  })

  await test('删除：软链接永远走永久删除，不进回收站（DeleteDirectory 会顺着联接点递归）', async () => {
    const link = join(workspace, 'escape')
    if ((await stat(link).catch(() => undefined)) === undefined) return // 没建出链接：跳过
    const result = await rpc('remove', { root: workspace, paths: [link] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.removed, 1)
    assert.equal(result.value.mode, 'trash', '请求本身仍是回收站模式')
    assert.deepEqual(result.value.results, [{ path: link, ok: true, type: 'link', mode: 'permanent' }])
    await assert.rejects(stat(link))
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret', '链接的目标不该被动过')
  })

  await test('删除：拒绝对工作区根下手', async () => {
    const result = await rpc('remove', { root: workspace, paths: [workspace], permanent: true })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.removed, 0)
    assert.equal(result.value.results[0].error, 'file-extras/delete-root')
    assert.ok((await stat(workspace)).isDirectory(), '工作区根必须还在')
  })

  await test('删除：区外路径被拒且文件还在', async () => {
    const victim = join(outside, 'secret.txt')
    const result = await rpc('remove', { root: workspace, paths: [victim, join(workspace, '..', 'nope.txt')], permanent: true })
    assert.equal(result.ok, true, JSON.stringify(result))
    for (const item of result.value.results) assert.equal(item.error, 'file-extras/outside-workspace', JSON.stringify(item))
    assert.equal(await readFile(victim, 'utf8'), 'secret')
  })

  await test('删除：一批里失败的只影响它自己', async () => {
    const good = join(workspace, 'keep-me-out-of-it.txt')
    await writeFile(good, 'a')
    const result = await rpc('remove', { root: workspace, paths: [join(workspace, 'never-existed.txt'), good], permanent: true })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.removed, 1)
    assert.equal(result.value.results[0].error, 'file-extras/not-found')
    assert.equal(result.value.results[1].ok, true)
    await assert.rejects(stat(good))
  })

  await test('删除：空数组被拒', async () => {
    const result = await rpc('remove', { root: workspace, paths: [] })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'file-extras/bad-request')
  })

  await test('删除：测试产生的回收站条目已清干净', async () => {
    const removed = await purgeTrash(workspace, trashBefore)
    assert.ok(removed >= 4, `应清掉至少 4 个条目文件（2 对 $I/$R），实际 ${removed}`)
    assert.deepEqual(await addedTrashEntries(workspace, trashBefore), [])
  })

  console.log('trash（跨平台后端）')

  /** 三套后端的自检场地：家目录 / XDG_DATA_HOME 都指向临时目录。 */
  const fake = join(workspace, 'fake-home')
  const fakeHome = join(fake, 'home')
  const fakeData = join(fake, 'data')
  await mkdir(fakeHome, { recursive: true })

  await test('回收站/Linux：按 freedesktop 规范落 files/ 与 info/*.trashinfo', async () => {
    const file = join(fake, 'linux-file.txt')
    const folder = join(fake, 'linux-folder')
    await writeFile(file, 'linux')
    await mkdir(join(folder, 'inner'), { recursive: true })
    await writeFile(join(folder, 'inner', 'deep.txt'), 'deep')
    const results = await moveToTrash(
      [{ path: file, kind: 'file' }, { path: folder, kind: 'directory' }],
      { platform: 'linux', home: fakeHome, dataHome: fakeData, uid: 1000 },
    )
    assert.deepEqual([...results.values()], [{ ok: true, mode: 'trash' }, { ok: true, mode: 'trash' }], JSON.stringify([...results]))
    const filesDir = join(fakeData, 'Trash', 'files')
    const infoDir = join(fakeData, 'Trash', 'info')
    assert.equal(await readFile(join(filesDir, 'linux-file.txt'), 'utf8'), 'linux', '数据要落在 Trash/files 里')
    assert.equal(await readFile(join(filesDir, 'linux-folder', 'inner', 'deep.txt'), 'utf8'), 'deep', '目录要整棵搬过去')
    const info = await readFile(join(infoDir, 'linux-file.txt.trashinfo'), 'utf8')
    assert.match(info, /^\[Trash Info\]\n/, `trashinfo 头不对：${JSON.stringify(info)}`)
    const original = /^Path=(.*)$/m.exec(info)?.[1] ?? ''
    assert.equal(decodeURIComponent(original), file, 'Path= 必须能还原出原始绝对路径')
    assert.match(info, /^DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/m, `DeletionDate 格式不对：${JSON.stringify(info)}`)
    await assert.rejects(stat(file))
    await assert.rejects(stat(folder))
  })

  await test('回收站/Linux：同名条目自动让位成 <名字>.2，两个 .trashinfo 都在', async () => {
    const first = join(fake, 'clash', 'same.txt')
    const second = join(fake, 'clash2', 'same.txt')
    await mkdir(join(fake, 'clash'), { recursive: true })
    await mkdir(join(fake, 'clash2'), { recursive: true })
    await writeFile(first, 'one')
    await writeFile(second, 'two')
    await moveToTrash([{ path: first, kind: 'file' }], { platform: 'linux', home: fakeHome, dataHome: fakeData, uid: 1000 })
    await moveToTrash([{ path: second, kind: 'file' }], { platform: 'linux', home: fakeHome, dataHome: fakeData, uid: 1000 })
    const filesDir = join(fakeData, 'Trash', 'files')
    const infoDir = join(fakeData, 'Trash', 'info')
    assert.equal(await readFile(join(filesDir, 'same.txt'), 'utf8'), 'one')
    assert.equal(await readFile(join(filesDir, 'same.txt.2'), 'utf8'), 'two')
    assert.equal(await readFile(join(infoDir, 'same.txt.trashinfo'), 'utf8').then((text) => decodeURIComponent(/^Path=(.*)$/m.exec(text)[1])), first)
    assert.equal(await readFile(join(infoDir, 'same.txt.2.trashinfo'), 'utf8').then((text) => decodeURIComponent(/^Path=(.*)$/m.exec(text)[1])), second)
  })

  await test('回收站/macOS：同卷进 ~/.Trash，同名同样让位', async () => {
    const one = join(fake, 'mac-one.txt')
    const two = join(fake, 'mac-two.txt')
    await writeFile(one, 'mac1')
    await writeFile(two, 'mac2')
    await moveToTrash([{ path: one, kind: 'file' }], { platform: 'darwin', home: fakeHome, uid: 501 })
    await moveToTrash([{ path: two, kind: 'file' }], { platform: 'darwin', home: fakeHome, uid: 501 })
    // 名字不同，两个都该直接躺在 ~/.Trash 里
    assert.equal(await readFile(join(fakeHome, '.Trash', 'mac-one.txt'), 'utf8'), 'mac1')
    assert.equal(await readFile(join(fakeHome, '.Trash', 'mac-two.txt'), 'utf8'), 'mac2')
    // 再扔一个同名的，验证让位
    await writeFile(one, 'mac1-again')
    await moveToTrash([{ path: one, kind: 'file' }], { platform: 'darwin', home: fakeHome, uid: 501 })
    assert.equal(await readFile(join(fakeHome, '.Trash', 'mac-one.txt.2'), 'utf8'), 'mac1-again')
  })

  await test('回收站：没有后端的平台必须报 trash-unavailable，而不是退回永久删除', async () => {
    const victim = join(fake, 'unsupported.txt')
    await writeFile(victim, 'x')
    await assert.rejects(
      moveToTrash([{ path: victim, kind: 'file' }], { platform: 'freebsd' }),
      (cause) => cause.code === 'file-extras/trash-unavailable',
    )
    assert.equal(await readFile(victim, 'utf8'), 'x', '报错时文件必须原封不动')
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

  console.log('history（↑/↓ 历史指令回填的数据源）')

  await test('只回真实用户指令，系统注入的 user/message 全部挡掉', async () => {
    sessionEvents = [
      { seq: 1, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] } },
      { seq: 2, time: 1100, type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md 全文' }] } },
      { seq: 3, time: 1200, type: 'user/message', data: { source: { kind: 'skill-invocation' }, content: [{ type: 'text', text: '<skill_content>' }] } },
      { seq: 4, time: 1300, type: 'assistant/message', data: { content: [{ type: 'text', text: '模型回复' }] } },
      { seq: 5, time: 1400, type: 'user/message', data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: '定时提醒' }] } },
      { seq: 6, time: 1500, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] } },
      { seq: 7, time: 1600, type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: 'goal 续跑' }] } },
    ]
    const result = await rpc('history', { sessionId: 'sess-1' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.items.map((item) => item.text), ['第一条', '第二条'])
    assert.deepEqual(result.value.items.map((item) => item.seq), [1, 6])
    assert.equal(result.value.total, 2)
    assert.equal(result.value.sessionId, 'sess-1')
  })

  await test('连续重复的指令去重，非文本块留占位符', async () => {
    sessionEvents = [
      { seq: 1, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再来一次' }] } },
      { seq: 2, time: 1100, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再来一次' }] } },
      { seq: 3, time: 1200, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] } },
      { seq: 4, time: 1300, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] } },
      { seq: 5, time: 1400, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '图文混排' }, { type: 'image', attachment: {} }, { type: 'file', attachment: { name: 'a.txt' } }] } },
    ]
    const result = await rpc('history', { sessionId: 'sess-1' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.items.map((item) => item.text), ['再来一次', '[图片]', '图文混排 [图片] [文件 a.txt]'])
  })

  await test('sessionId 非法 / sessionQuery 缺席 / 日志读不了，三种失败各有各的码', async () => {
    const bad = await rpc('history', { sessionId: '' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'file-extras/bad-request')

    sessionQueryPresent = false
    const missing = await rpc('history', { sessionId: 'sess-1' })
    sessionQueryPresent = true
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'file-extras/history-unavailable')

    sessionQueryThrows = true
    const broken = await rpc('history', { sessionId: 'sess-1' })
    sessionQueryThrows = false
    assert.equal(broken.ok, false)
    assert.equal(broken.error.code, 'file-extras/not-found')
  })

  console.log('斜杠命令（~/.dsh/commands/*.md）')

  await test('frontmatter：读 description / input-hint，容忍引号、注释与其它键', async () => {
    const parsed = parseCommandFile('---\nname: save\ndescription: "保存进度" # 注释\ninput-hint: <可选说明>\nempty:\n---\n\n正文第一行\n正文第二行\n')
    assert.equal(parsed.frontmatter.description, '保存进度')
    assert.equal(parsed.frontmatter['input-hint'], '<可选说明>')
    assert.equal(parsed.frontmatter.name, 'save')
    assert.equal(parsed.frontmatter.empty, undefined, '空值不该进 frontmatter')
    assert.equal(parsed.body, '正文第一行\n正文第二行')
  })

  await test('没有 frontmatter 时整个文件都是正文，BOM 不影响', async () => {
    assert.deepEqual(parseCommandFile('就是一段话'), { frontmatter: {}, body: '就是一段话' })
    assert.equal(parseCommandFile('\uFEFF---\ndescription: x\n---\n正文').body, '正文')
  })

  await test('命令名文法与注册表逐字一致：save1 合法，Bad Name / 数字开头不合法', () => {
    assert.equal(commandNameFromFile('save.md'), 'save')
    assert.equal(commandNameFromFile('save1.md'), 'save1')
    assert.equal(commandNameFromFile('dsh-restart.md'), 'dsh-restart')
    assert.equal(commandNameFromFile('my_cmd.md'), 'my_cmd')
    assert.equal(commandNameFromFile('Bad Name.md'), undefined)
    assert.equal(commandNameFromFile('1st.md'), undefined)
    assert.equal(commandNameFromFile('notes.txt'), undefined)
    assert.equal(commandNameFromFile('.md'), undefined)
  })

  await test('$ARGUMENTS 替换成原始参数；没有占位符时正文原样', () => {
    assert.equal(buildPrompt('审查 $ARGUMENTS 这段', '  src/a.ts  '), '审查 src/a.ts 这段')
    assert.equal(buildPrompt('没有占位符', '参数被丢掉'), '没有占位符')
    assert.equal(buildPrompt('$ARGUMENTS 和 $ARGUMENTS', 'x'), 'x 和 x')
  })

  await test('扫描：排序、跳过非法名与非 .md，description 缺失时给默认值', () => {
    const found = discoverCommandFiles({ userDir: fakeCommandDir, maxBytes: 1024 * 1024 })
    assert.deepEqual(found.map((item) => item.name), ['goal', 'greet', 'plain'])
    const greet = found.find((item) => item.name === 'greet')
    assert.equal(greet.description, '打个招呼')
    assert.equal(greet.inputHint, '<名字>')
    assert.equal(found.find((item) => item.name === 'plain').description, '运行 /plain')
    // 目录不存在不是错误
    assert.deepEqual(discoverCommandFiles({ userDir: join(fakeCommandDir, 'nope') }), [])
  })

  await test('renderPrompt 每次重新读盘，改文件立即生效', async () => {
    const file = join(fakeCommandDir, 'greet.md')
    assert.equal(renderPrompt(file, 1024 * 1024, '世界'), '你好，世界')
    await writeFile(file, '改过了：$ARGUMENTS')
    assert.equal(renderPrompt(file, 1024 * 1024, '世界'), '改过了：世界')
    // renderPrompt 是同步函数，超限时**同步抛**，所以用 throws 而不是 rejects。
    assert.throws(() => renderPrompt(file, 4, 'x'), /超过 4 字节上限/)
    await writeFile(file, '---\ndescription: 打个招呼\ninput-hint: <名字>\n---\n\n你好，$ARGUMENTS\n')
  })

  await test('插件启动即注册：合法文件进注册表，重名 / 非法名不进', async () => {
    await waitFor(() => registered.has('greet') && registered.has('plain'), '斜杠命令注册完成')
    assert.equal(registered.has('goal'), true, 'goal 是预先占位的 app 级命令，不能被顶掉')
    assert.equal(registered.get('goal').description, undefined, 'goal 必须还是原来那一个')
    assert.deepEqual([...registered.keys()].sort(), ['goal', 'greet', 'plain'])
    assert.equal(registered.get('greet').input.hint, '<名字>')
    assert.equal(registered.get('plain').input, undefined)
  })

  await test('handler：正文渲染后作为一条普通用户消息交给 agent', async () => {
    const definition = registered.get('greet')
    const sent = []
    const result = await definition.handler({
      agent: { followup: (message) => sent.push(message) },
      rawInput: ' 张三',
      signal: new AbortController().signal,
    })
    if (result.kind === 'error' && result.text.includes('无法加载 @deepseek-ai/dsh-llm')) {
      // 工作区没挂 node_modules 时解析不到 DSH 自己的包（装到 profile 之后才在 node_modules 链上）。
      // 这本身也是要断言的行为：拿不到依赖就回 error，绝不抛异常、也不自己拼一个假消息。
      console.log('      （当前工作区解析不到 @deepseek-ai/dsh-llm，只断言降级行为）')
      return
    }
    assert.equal(result.kind, 'success', result.text)
    assert.equal(result.text, '已执行 /greet')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].role, 'user', '必须是 user 角色，不能走 inject')
    assert.equal(sent[0].source.kind, 'user', 'source.kind 必须是 user —— history 就靠它区分人工输入')
    assert.equal(sent[0].content[0].text, '你好，张三')
  })

  await test('handler：正文为空 / 文件被删，回 error 而不是抛异常', async () => {
    const definition = registered.get('plain')
    const file = join(fakeCommandDir, 'plain.md')
    await writeFile(file, '   ')
    const empty = await definition.handler({ agent: { followup() {} }, rawInput: '', signal: new AbortController().signal })
    assert.equal(empty.kind, 'error')
    await rm(file, { force: true })
    const gone = await definition.handler({ agent: { followup() {} }, rawInput: '', signal: new AbortController().signal })
    assert.equal(gone.kind, 'error')
    assert.match(gone.text, /ENOENT|no such file/i)
  })
} finally {
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
  await rm(fakeDshHome, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
