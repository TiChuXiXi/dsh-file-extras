/**
 * dsh-file-extras —— host 半区（跑在 DSH host 进程）。
 *
 * 官方「工作区文件」树（@deepseek-ai/dsh-client-ui-sidebar-files）走的是 workspaceFiles Remote
 * 命名空间，它的类型面里**只有 size，没有修改时间**（WorkspaceDirectoryListing.entries[].size /
 * WorkspaceFileStat.bytes），`version` 是不透明令牌、契约上明令「never parsed」。所以浏览器半区
 * 拿不到 mtime，需要本半区补上：
 *
 *   1. RPC `stat`    —— 批量取 大小 / 修改时间 / **一级**子项数量（不递归，readdir 一层即止）；
 *   2. GET  download —— 按路径回字节 + Content-Disposition，浏览器侧 fetch→Blob→落盘；
 *   3. POST upload   —— 收原始字节写进目标目录，重名自动加序号，**绝不覆盖**已有文件。
 *
 * 依赖策略（照抄 dsh-git-vcs 踩过的坑）：只用 `inject: ['webServer','connection']` 两个硬依赖，
 * 文件系统走 node:fs —— `ctx.fs` 与 workspaceFiles 一样不暴露 mtime。
 *
 * 为什么自己注册 webServer 前缀路由，而不用 `connection.rpc.handle(channel, handler)`：
 * web-app 的 `connection` 行只 inject 了 [webRuntime]，那个 API 会把路由注册到 connection 服务
 * 自己 ctx 的 webServer 上，第三方调用必然炸 `cannot get property "webServer" without inject`。
 * 所以自己挂一条 prefix 路由，并复用 connection 公开的 `requestRejection()` 做信任栅栏
 * （Host/Origin + 浏览器签名 cookie 认证），线格式与 Connection RPC 逐字一致，浏览器侧照旧用
 * `ctx.connection.rpc.call('/dsh-file-extras', endpoint, payload)`。
 *
 * 路径安全：浏览器半区把文件树的 `data-files-root` 作为 root 传上来，本半区
 *   ① 要求绝对路径、拒绝 NUL、拒绝盘符/文件系统根（防止「声明 root=C:\ 就能读全盘」）；
 *   ② 对 root 与每个候选路径都做 realpath，再用分隔符前缀比对包含关系——软链接指向工作区外
 *      也会被挡住（纯字符串前缀比对比不了这一层）。
 */

import { createReadStream } from 'node:fs'
import { readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, parse as parsePath, resolve as resolvePath, sep } from 'node:path'

/** loader 行标识。 */
export const name = 'file-extras'

/**
 * 硬依赖：没有 webServer 挂不上路由，没有 connection 过不了信任栅栏。
 * 行级 inject 也要在 cordis.patch.yml 里写一份 —— loader 是按**行**激活的，
 * 模块里 export 的 inject 管不到那一行。
 */
export const inject = ['webServer', 'connection']

/** 浏览器半区调用的 RPC 通道（前缀路由，同一前缀下还挂 download / upload 两条裸路由）。 */
const CHANNEL = '/dsh-file-extras'

/** 一次 stat 请求最多带多少个路径（文件树一屏几百行也够）。 */
const MAX_PATHS_PER_REQUEST = 500

/** 单次上传的字节上限（整个 body 会读进内存再落盘）。 */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

/** 单次下载的文件字节上限（浏览器侧走 Blob，超过就没意义了）。 */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/** 目标目录里重名时最多试到第几号（`name (1).ext` … `name (999).ext`）。 */
const MAX_RENAME_ATTEMPTS = 999

/** 端点自己的错误类型：`code` 直接进 RPC 失败体，浏览器侧按 code 分支。 */
class FileExtrasError extends Error {
  /**
   * @param {string} code - 稳定的错误码，形如 `file-extras/bad-request`。
   * @param {string} message - 给人看的一句话。
   * @param {object} [details] - 结构化补充（进 RPC 失败的 details 字段）。
   */
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** 把任意异常压成可读字符串。 */
function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Windows 盘符 / POSIX 根：`C:\`、`\\server\share`、`/`。 */
function isFilesystemRoot(path) {
  return parsePath(path).root === path
}

/** 大小写敏感度跟随平台：Windows 路径比较一律折成小写。 */
function foldCase(text) {
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/** `child` 是否就是 `parent` 或它的后代（两者都应是已 realpath 的绝对路径）。 */
function isInside(parent, child) {
  const a = foldCase(parent)
  const b = foldCase(child)
  if (a === b) return true
  const prefix = a.endsWith(sep) ? a : a + sep
  return b.startsWith(prefix)
}

/** 把一段查询串解析成普通对象。 */
function queryOf(url) {
  const out = {}
  for (const [key, value] of url.searchParams) out[key] = value
  return out
}

/**
 * 一次性读出请求体（带上限）。
 * @param {import('node:http').IncomingMessage} request - 原始请求。
 * @param {number} limit - 允许的最大字节数。
 * @returns {Promise<Buffer>} 完整请求体。
 */
async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) {
      throw new FileExtrasError('file-extras/too-large', `上传内容超过上限 ${Math.round(limit / 1024 / 1024)} MiB`, { limit })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 写一个 JSON 响应。 */
function respondJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * 工作区根与包含关系的裁判。
 *
 * 每个请求独立构造：root 由浏览器半区从文件树的 `data-files-root` 取出传上来，所以必须
 * 逐请求校验，不能缓存成进程级白名单（同一个 host 上会有多个会话、多个工作区）。
 */
class Confinement {
  /**
   * @param {string} rawRoot - 客户端声明的工作区根。
   */
  constructor(rawRoot) {
    this.rawRoot = rawRoot
    this.realRoot = ''
  }

  /**
   * 校验 root 本身：绝对路径、存在、是目录、不是盘符/文件系统根。
   * @returns {Promise<string>} realpath 之后的根。
   */
  async open() {
    const raw = this.rawRoot
    if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) {
      throw new FileExtrasError('file-extras/bad-request', '缺少 root（工作区根路径）')
    }
    if (!isAbsolute(raw)) {
      throw new FileExtrasError('file-extras/bad-request', `root 必须是绝对路径：${raw}`)
    }
    const normalized = resolvePath(raw)
    if (isFilesystemRoot(normalized)) {
      throw new FileExtrasError('file-extras/outside-workspace', `拒绝把文件系统根当成工作区根：${normalized}`)
    }
    this.realRoot = await realpath(normalized).catch(() => normalized)
    if (isFilesystemRoot(this.realRoot)) {
      throw new FileExtrasError('file-extras/outside-workspace', `拒绝把文件系统根当成工作区根：${this.realRoot}`)
    }
    return this.realRoot
  }

  /**
   * 校验一个候选路径必须落在 root 之内，并返回它的真实路径。
   * @param {string} candidate - 绝对路径。
   * @returns {Promise<string>} realpath 之后的绝对路径。
   */
  async check(candidate) {
    if (this.realRoot === '') await this.open()
    if (typeof candidate !== 'string' || candidate === '' || candidate.includes('\0')) {
      throw new FileExtrasError('file-extras/bad-request', '路径非法')
    }
    if (!isAbsolute(candidate)) {
      throw new FileExtrasError('file-extras/bad-request', `路径必须是绝对路径：${candidate}`)
    }
    const real = await realpath(resolvePath(candidate)).catch(() => resolvePath(candidate))
    if (!isInside(this.realRoot, real)) {
      throw new FileExtrasError('file-extras/outside-workspace', `路径不在工作区内：${real}`, { root: this.realRoot })
    }
    return real
  }
}

/**
 * 把客户端给的显示名压成一个安全的单段文件名。
 * @param {string} rawName - 浏览器上传时带的名字。
 * @returns {string} 不含分隔符、`.`/`..` 的文件名。
 */
function safeFileName(rawName) {
  if (typeof rawName !== 'string' || rawName === '' || rawName.includes('\0')) {
    throw new FileExtrasError('file-extras/bad-request', '缺少上传文件名')
  }
  // 浏览器给的是 basename，但对端可以伪造：先把两种分隔符都归一，再取最后一段。
  const leaf = rawName.replace(/\\/g, '/').split('/').pop() ?? ''
  const name = leaf.trim()
  if (name === '' || name === '.' || name === '..') {
    throw new FileExtrasError('file-extras/bad-request', `上传文件名非法：${rawName}`)
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new FileExtrasError('file-extras/bad-request', '上传文件名过长')
  }
  return name
}

/**
 * 在目标目录里挑一个不冲突的文件名：原名可用就用原名，否则 `base (n).ext` 递增。
 * 刻意不覆盖：上传同名文件应当是「多一份」，不是「毁掉原来那份」。
 * @param {string} directory - 已校验的真实目录路径。
 * @param {string} name - 期望的文件名。
 * @returns {Promise<string>} 可用的文件名。
 */
async function pickFreeName(directory, name) {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  if ((await stat(join(directory, name)).catch(() => undefined)) === undefined) return name
  for (let index = 1; index <= MAX_RENAME_ATTEMPTS; index += 1) {
    const candidate = `${stem} (${index})${extension}`
    if ((await stat(join(directory, candidate)).catch(() => undefined)) === undefined) return candidate
  }
  throw new FileExtrasError('file-extras/name-conflict', `同名文件太多，无法为 ${name} 找到可用文件名`)
}

/** 下载响应头里的 ASCII 兜底名：非 ASCII 一律换成 `_`。 */
function asciiFallbackName(name) {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return cleaned === '' ? 'download' : cleaned
}

/**
 * 错误码 → HTTP 状态码。
 *
 * 只给 **download / upload** 这两条裸路由用：它们是字节通道，浏览器侧按 `response.ok` 判成败，
 * 所以失败必须是真正的错误状态。RPC 端点相反 —— 信封失败也要回 200，因为
 * `ctx.connection.rpc.call` 把非 2xx 一律当**传输失败**抛异常，读不到信封里的错误码。
 */
function statusForCode(code) {
  switch (code) {
    case 'file-extras/outside-workspace': return 403
    case 'file-extras/not-regular-file':
    case 'file-extras/not-a-directory':
    case 'file-extras/bad-request': return 400
    case 'file-extras/name-conflict': return 409
    case 'file-extras/too-large': return 413
    case 'file-extras/not-found': return 404
    default: return 500
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host 根 context。
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || connection === undefined) {
    console.warn('[dsh-file-extras] ctx.webServer / ctx.connection 缺席：路由未注册。')
    return
  }

  /** RPC 端点表：方法名 → 处理函数。 */
  const endpoints = {
    /**
     * 批量取元数据。
     * payload: { root: string, paths: string[] }
     * value:   { root: string, entries: Entry[] }
     */
    async stat(payload) {
      const rawPaths = payload?.paths
      if (!Array.isArray(rawPaths)) {
        throw new FileExtrasError('file-extras/bad-request', 'paths 必须是数组')
      }
      if (rawPaths.length > MAX_PATHS_PER_REQUEST) {
        throw new FileExtrasError('file-extras/bad-request', `一次最多查询 ${MAX_PATHS_PER_REQUEST} 个路径`)
      }
      const confinement = new Confinement(payload?.root)
      const root = await confinement.open()
      const entries = await Promise.all(rawPaths.map(async (path) => {
        if (typeof path !== 'string' || path === '') return { path: String(path), error: 'bad-request' }
        let real
        try {
          real = await confinement.check(path)
        } catch (cause) {
          return { path, error: cause instanceof FileExtrasError ? cause.code : 'unavailable' }
        }
        try {
          // 跟随软链接取类型，与文件树自己的判定口径一致（它用的是 listing 的 destination type）。
          const info = await stat(real)
          const entry = { path, mtimeMs: info.mtimeMs }
          if (info.isDirectory()) {
            entry.type = 'directory'
            try {
              // 只数第一级子级，不递归——这正是需求里「内部子文件和子文件夹的数量」。
              entry.childCount = (await readdir(real)).length
            } catch {
              entry.childCount = undefined
            }
          } else if (info.isFile()) {
            entry.type = 'file'
            entry.size = info.size
          } else {
            entry.type = 'other'
          }
          return entry
        } catch (cause) {
          const code = cause?.code === 'ENOENT' ? 'missing' : 'unavailable'
          return { path, error: code }
        }
      }))
      return { root, entries }
    },
  }

  /**
   * GET <CHANNEL>/download?root=…&path=…
   * 直接流式回文件字节，不经过 RPC（JSON 里塞 base64 会白白放大 33%）。
   */
  async function handleDownload(request, response, url) {
    const query = queryOf(url)
    const confinement = new Confinement(query.root)
    await confinement.open()
    const real = await confinement.check(query.path)
    const info = await stat(real)
    if (!info.isFile()) {
      throw new FileExtrasError('file-extras/not-regular-file', `不是普通文件：${real}`)
    }
    if (info.size > MAX_DOWNLOAD_BYTES) {
      throw new FileExtrasError('file-extras/too-large', `文件超过下载上限 ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MiB`, { size: info.size })
    }
    const filename = basename(real)
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(info.size),
      'content-disposition': `attachment; filename="${asciiFallbackName(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
    })
    await new Promise((settle, fail) => {
      const stream = createReadStream(real)
      stream.on('error', fail)
      stream.on('end', () => settle())
      response.on('close', () => stream.destroy())
      stream.pipe(response)
    })
  }

  /**
   * POST <CHANNEL>/upload?root=…&dir=…&name=…（body = 原始字节）
   * 写成功回 { ok: true, value: { path, name, size, renamed } }。
   */
  async function handleUpload(request, response, url) {
    const query = queryOf(url)
    const confinement = new Confinement(query.root)
    await confinement.open()
    const directory = await confinement.check(query.dir)
    const directoryInfo = await stat(directory)
    if (!directoryInfo.isDirectory()) {
      throw new FileExtrasError('file-extras/not-a-directory', `上传目标不是目录：${directory}`)
    }
    const wanted = safeFileName(query.name)
    const buffer = await readBody(request, MAX_UPLOAD_BYTES)
    const finalName = await pickFreeName(directory, wanted)
    const target = join(directory, finalName)
    // 二次确认：拼出来的目标必须仍在工作区内（`pickFreeName` 只会加后缀，这里是兜底断言）。
    if (!isInside(confinement.realRoot, resolvePath(target))) {
      throw new FileExtrasError('file-extras/outside-workspace', `目标路径不在工作区内：${target}`)
    }
    await writeFile(target, buffer)
    return {
      ok: true,
      value: { path: target, name: finalName, size: buffer.length, renamed: finalName !== wanted },
    }
  }

  /**
   * 前缀路由的总入口：先过信任栅栏，再按子路径分发。
   * @param {import('node:http').IncomingMessage} request - 原始请求。
   * @param {import('node:http').ServerResponse} response - 原始响应。
   */
  async function handleRoute(request, response) {
    const rejection = connection.requestRejection(request)
    if (rejection !== undefined) {
      response.writeHead(rejection)
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const url = new URL(request.url ?? CHANNEL, 'http://localhost')
    const sub = url.pathname.slice(CHANNEL.length).replace(/^\/+/, '')
    const isRpc = request.method === 'POST' && sub !== 'upload'
    try {
      if (request.method === 'GET' && sub === 'download') {
        await handleDownload(request, response, url)
        return
      }
      if (request.method === 'POST' && sub === 'upload') {
        const result = await handleUpload(request, response, url)
        respondJson(response, 200, result)
        return
      }
      if (request.method === 'POST') {
        respondJson(response, 200, await handleRpc(request, sub))
        return
      }
      respondJson(response, 405, { ok: false, error: { code: 'file-extras/method-not-allowed', message: `不支持的方法：${request.method} ${url.pathname}`, details: {} } })
    } catch (cause) {
      const code = cause instanceof FileExtrasError
        ? cause.code
        : (cause?.code === 'ENOENT' ? 'file-extras/not-found' : 'file-extras/internal')
      const message = messageOf(cause)
      if (response.headersSent) {
        // 下载流已经开始：只能断掉连接，让浏览器侧看到不完整响应。
        console.warn(`[dsh-file-extras] ${url.pathname} 响应途中失败：${message}`)
        response.destroy()
        return
      }
      console.warn(`[dsh-file-extras] ${url.pathname} 失败：${message}`)
      // RPC 必须保 200（非 2xx 会被 rpc.call 当成传输失败，读不到信封里的错误码）；
      // 下载/上传是字节通道，失败就用真正的错误状态，客户端按 response.ok 判。
      respondJson(response, isRpc ? 200 : statusForCode(code), {
        ok: false,
        error: { code, message, details: cause instanceof FileExtrasError ? cause.details : {} },
      })
    }
  }

  /**
   * 一条 Connection RPC：线格式与官方逐字一致。
   * 请求  { type:"client-request", rpcId, method, payload }
   * 响应  { type:"server-response", rpcId, result: { ok:true, value } | { ok:false, error } }
   * @param {import('node:http').IncomingMessage} request - 原始请求。
   * @param {string} fallbackMethod - URL 末段，请求体解析失败时用作诊断。
   * @returns {Promise<object>} 完整的 server-response 信封。
   */
  async function handleRpc(request, fallbackMethod) {
    let message = null
    try {
      const raw = await readBody(request, MAX_UPLOAD_BYTES)
      message = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'))
    } catch (cause) {
      return {
        type: 'server-response',
        rpcId: 'invalid-request',
        result: { ok: false, error: { code: 'file-extras/bad-request', message: messageOf(cause), details: {} } },
      }
    }
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    const method = typeof message?.method === 'string' && message.method !== '' ? message.method : fallbackMethod
    const payload = message?.payload !== null && typeof message?.payload === 'object' ? message.payload : {}
    const endpoint = endpoints[method]
    if (endpoint === undefined) {
      return {
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code: 'file-extras/unknown-endpoint', message: `未知端点：${String(method)}`, details: {} } },
      }
    }
    try {
      return { type: 'server-response', rpcId, result: { ok: true, value: await endpoint(payload) } }
    } catch (cause) {
      const code = cause instanceof FileExtrasError ? cause.code : 'file-extras/internal'
      const message2 = messageOf(cause)
      console.warn(`[dsh-file-extras] 端点 ${method} 失败：${message2}`)
      return {
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code, message: message2, details: cause instanceof FileExtrasError ? cause.details : {} } },
      }
    }
  }

  ctx.effect(() => webServer.register({ kind: 'prefix', path: CHANNEL, handler: handleRoute }), 'dsh-file-extras: rpc + bytes channel')
  console.log(`[dsh-file-extras] 通道已注册：${CHANNEL}（RPC stat / GET download / POST upload）`)
}
