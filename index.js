/**
 * dsh-file-extras —— host 半区（跑在 DSH host 进程）。
 *
 * 官方「工作区文件」树（@deepseek-ai/dsh-client-ui-sidebar-files）走的是 workspaceFiles Remote
 * 命名空间，它的类型面里**只有 size，没有修改时间**（WorkspaceDirectoryListing.entries[].size /
 * WorkspaceFileStat.bytes），`version` 是不透明令牌、契约上明令「never parsed」。所以浏览器半区
 * 拿不到 mtime，需要本半区补上：
 *
 *   1. RPC `stat`    —— 批量取 大小 / 修改时间 / **一级**子项数量（不递归，readdir 一层即止）；
 *   2. GET  download —— 流式回字节 + Content-Disposition，**不设大小上限**：字节从磁盘直接进
 *      socket，客户端那边是浏览器原生下载，两端都不经过内存，大文件立即开始；
 *   3. POST upload   —— 流式收原始字节，先写同目录 `.part-<uuid>` 再原子 rename；
 *      重名自动加序号，**绝不覆盖**已有文件；
 *   4. RPC `remove`  —— 删除（文件夹连同其全部内容）。**默认走回收站**（Shell 的 SHFileOperation，
 *      可还原），`permanent: true` 才走 fs.rm。逐条独立结算；拒绝工作区根、拒绝区外路径，
 *      软链接只删链接本身、绝不跟随。浏览器侧负责二次确认，并用一个默认不勾的复选框把
 *      「移到回收站」和「永久删除」两条路分开。
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

import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, resolve as resolvePath, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { moveToTrash } from './lib/trash.js'

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

/**
 * 单次上传的字节上限。
 *
 * 上传是**流式**落盘的（边收边写临时文件），所以这个数字不是内存约束，只是拦住失控请求；
 * 给得足够宽，免得用户传个大包时撞上一个莫名其妙的墙。
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

/** 单条 RPC 请求体的上限（只有 JSON 信封，几百个路径也就几十 KB）。 */
const MAX_RPC_BYTES = 32 * 1024 * 1024

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
 * 一次性读出请求体（带上限）。只给 RPC 的 JSON 信封用 —— 上传走流式，不经过这里。
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
      throw new FileExtrasError('file-extras/too-large', `请求体超过上限 ${Math.round(limit / 1024 / 1024)} MiB`, { limit })
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

  /**
   * 删除专用的校验：按**目录项本身**判定包含关系，而不是跟随软链接之后的真实路径。
   *
   * `check()` 会 realpath，于是「工作区里一个指向区外的软链接」会被判成区外而拒绝删除 ——
   * 可我们恰恰需要能删掉这种链接本身。这里改成解析**父目录**的 realpath 再拼上末段：
   * 软链接作为目录项被判定（在区内），删除时也只删链接、不碰它指向的东西。
   * @param {string} candidate - 绝对路径。
   * @returns {Promise<string>} 可安全删除的绝对路径。
   */
  async checkEntry(candidate) {
    if (this.realRoot === '') await this.open()
    if (typeof candidate !== 'string' || candidate === '' || candidate.includes('\0')) {
      throw new FileExtrasError('file-extras/bad-request', '路径非法')
    }
    if (!isAbsolute(candidate)) {
      throw new FileExtrasError('file-extras/bad-request', `路径必须是绝对路径：${candidate}`)
    }
    const resolved = resolvePath(candidate)
    // 先挡工作区根自己：它的「父目录」天然在区外，若走下面的父目录判定会被报成
    // outside-workspace —— 意思对但说不清，这里给一个明确的 delete-root。
    if (foldCase(resolved) === foldCase(this.realRoot)) {
      throw new FileExtrasError('file-extras/delete-root', '拒绝对工作区根执行删除')
    }
    const parentReal = await realpath(dirname(resolved)).catch(() => undefined)
    if (parentReal === undefined) {
      throw new FileExtrasError('file-extras/not-found', `上级目录不存在：${resolved}`)
    }
    if (!isInside(this.realRoot, parentReal)) {
      throw new FileExtrasError('file-extras/outside-workspace', `上级目录不在工作区内：${parentReal}`, { root: this.realRoot })
    }
    const entry = join(parentReal, basename(resolved))
    if (!isInside(this.realRoot, entry)) {
      throw new FileExtrasError('file-extras/outside-workspace', `路径不在工作区内：${entry}`, { root: this.realRoot })
    }
    return entry
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
 * 只给 **download / upload** 这两条裸路由用：它们是字节通道，浏览器侧按 `response.ok` 判成败，
 * 所以失败必须是真正的错误状态。RPC 端点相反 —— 信封失败也要回 200，因为
 * `ctx.connection.rpc.call` 把非 2xx 一律当**传输失败**抛异常，读不到信封里的错误码。
 */
function statusForCode(code) {
  switch (code) {
    case 'file-extras/outside-workspace':
    case 'file-extras/delete-root': return 403
    case 'file-extras/not-regular-file':
    case 'file-extras/not-a-directory':
    case 'file-extras/bad-request': return 400
    case 'file-extras/name-conflict':
    case 'file-extras/busy':
    case 'file-extras/trash-failed': return 409
    case 'file-extras/trash-unavailable': return 501
    case 'file-extras/trash-timeout': return 504
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

    /**
     * 删除若干路径。
     *
     * payload: { root: string, paths: string[], permanent?: boolean }
     * value:   { removed, mode: 'trash' | 'permanent', results: [{ path, ok, type?, mode?, error?, message? }] }
     *
     * 默认（`permanent !== true`）走**回收站**，可还原；`permanent: true` 才走 `fs.rm`，
     * 永久且不可恢复 —— 浏览器侧用一个默认不勾的复选框把这两条路分开，
     * **绝不静默降级**（回收站不可用时宁可报错，也不偷偷改成永久删除）。
     *
     * 回收站本身是跨平台的（见 `lib/trash.js`）：Windows 走 Shell 的 SHFileOperation，
     * Linux 走 freedesktop Trash 规范，macOS 走 `~/.Trash`。三个平台都没有后端时
     * 回 `file-extras/trash-unavailable`，由用户自己勾「永久删除」继续。
     *
     * 逐条独立结算：一批里有一个失败（被占用、权限不足、回收站拒收），其余照做，
     * 失败原因按条回给浏览器侧拼成提示 —— 不做「一个失败整批回滚」，那既做不到也不符合用户预期。
     *
     * 安全：走 `checkEntry`（按目录项判定包含关系），所以
     *   · 工作区外的路径一律拒绝；
     *   · 工作区**根自己**拒绝删除（否则一行手滑就把整个工作区抹了）；
     *   · 落在工作区内的软链接按「链接本身」处理，绝不跟随到区外。
     */
    async remove(payload) {
      const rawPaths = payload?.paths
      if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
        throw new FileExtrasError('file-extras/bad-request', 'paths 必须是非空数组')
      }
      if (rawPaths.length > MAX_PATHS_PER_REQUEST) {
        throw new FileExtrasError('file-extras/bad-request', `一次最多删除 ${MAX_PATHS_PER_REQUEST} 项`)
      }
      const confinement = new Confinement(payload?.root)
      const root = await confinement.open()
      const permanent = payload?.permanent === true
      /** 与 rawPaths 一一对应的结果槽；先占位，保证返回顺序就是请求顺序。 */
      const outcomes = new Array(rawPaths.length).fill(undefined)
      /** 待送回收站的项：{ slot, path（客户端原样路径）, real（真实路径）, kind }。 */
      const queued = []

      /** 把异常翻译成逐条结果；`lib/trash.js` 抛的错自带 `file-extras/*` code，照样透传。 */
      const failureOf = (path, cause) => {
        const code = cause instanceof FileExtrasError
          ? cause.code
          : (typeof cause?.code === 'string' && cause.code.startsWith('file-extras/')
            ? cause.code
            : (cause?.code === 'ENOENT' ? 'file-extras/not-found'
              : (cause?.code === 'EPERM' || cause?.code === 'EBUSY' || cause?.code === 'EACCES' ? 'file-extras/busy' : 'file-extras/internal')))
        return { path, ok: false, error: code, message: messageOf(cause) }
      }

      for (let slot = 0; slot < rawPaths.length; slot += 1) {
        const path = rawPaths[slot]
        if (typeof path !== 'string' || path === '') {
          outcomes[slot] = { path: String(path), ok: false, error: 'file-extras/bad-request', message: '路径非法' }
          continue
        }
        let entry
        let info
        try {
          entry = await confinement.checkEntry(path)
          if (foldCase(entry) === foldCase(root)) {
            throw new FileExtrasError('file-extras/delete-root', '拒绝对工作区根执行删除')
          }
          info = await lstat(entry)
        } catch (cause) {
          outcomes[slot] = failureOf(path, cause)
          continue
        }
        const link = info.isSymbolicLink()
        if (permanent) {
          try {
            // recursive 对文件/软链接就是 unlink，对真目录才是递归；Node 内部按 lstat 判定，
            // 所以穿过软链接递归删目标这种事不会发生。
            await rm(entry, { recursive: true, force: false })
            outcomes[slot] = { path, ok: true, type: link ? 'link' : (info.isDirectory() ? 'directory' : 'file'), mode: 'permanent' }
          } catch (cause) {
            outcomes[slot] = failureOf(path, cause)
          }
          continue
        }
        queued.push({ slot, path, real: entry, kind: link ? 'link' : (info.isDirectory() ? 'directory' : 'file') })
      }

      if (queued.length > 0) {
        let answers
        try {
          answers = await moveToTrash(queued.map((item) => ({ path: item.real, kind: item.kind })), { cwd: root })
        } catch (cause) {
          // 回收站整体不可用：这一批全部按失败回报，绝不退化成永久删除。
          for (const item of queued) outcomes[item.slot] = failureOf(item.path, cause)
          answers = new Map()
        }
        for (const item of queued) {
          if (outcomes[item.slot] !== undefined) continue
          const answer = answers.get(item.real)
          outcomes[item.slot] = answer === undefined
            ? { path: item.path, ok: false, error: 'file-extras/trash-failed', message: '回收站没有回报这一项的结果' }
            : (answer.ok
              ? { path: item.path, ok: true, type: item.kind, mode: answer.mode ?? 'trash' }
              : { path: item.path, ok: false, error: 'file-extras/trash-failed', message: answer.message ?? '移到回收站失败' })
        }
      }

      const results = outcomes.filter((item) => item !== undefined)
      return { removed: results.filter((item) => item.ok === true).length, mode: permanent ? 'permanent' : 'trash', results }
    },
  }

  /**
   * GET <CHANNEL>/download?root=…&path=…
   *
   * 流式回文件字节，不经过 RPC（JSON 里塞 base64 会白白放大 33%），也**不设大小上限**：
   * 字节从磁盘直接进 socket，host 侧内存占用与文件大小无关，客户端那边是浏览器的原生下载
   * （同样不经过页面内存）。上限只会变成用户传大文件时的一道莫名其妙的墙。
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
   *
   * 边收边写，**不把整个文件读进内存**：
   *   1. 先用 content-length 挡掉明显超限的请求（浏览器传 File 一定会带这个头）；
   *   2. 写同目录下的 `.part-<uuid>` 临时文件，收完再 rename 成目标名 ——
   *      rename 在同卷上是原子的，所以中途失败/超限不会在工作区留下半个「看起来正常」的文件，
   *      文件树的 watcher 也不会把一个还在长的文件当成成品列出来；
   *   3. 流式计数作为兜底上限（content-length 可以撒谎）。
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
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new FileExtrasError('file-extras/too-large', `上传内容超过上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024)} GiB`, { limit: MAX_UPLOAD_BYTES })
    }
    const wanted = safeFileName(query.name)
    const finalName = await pickFreeName(directory, wanted)
    const target = join(directory, finalName)
    // 二次确认：拼出来的目标必须仍在工作区内（`pickFreeName` 只会加后缀，这里是兜底断言）。
    if (!isInside(confinement.realRoot, resolvePath(target))) {
      throw new FileExtrasError('file-extras/outside-workspace', `目标路径不在工作区内：${target}`)
    }
    const temporary = `${target}.part-${randomUUID()}`
    let written = 0
    try {
      await pipeline(
        request,
        async function* count(source) {
          for await (const chunk of source) {
            written += chunk.length
            if (written > MAX_UPLOAD_BYTES) {
              throw new FileExtrasError('file-extras/too-large', `上传内容超过上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024)} GiB`, { limit: MAX_UPLOAD_BYTES })
            }
            yield chunk
          }
        },
        createWriteStream(temporary),
      )
      await rename(temporary, target)
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw cause
    }
    return {
      ok: true,
      value: { path: target, name: finalName, size: written, renamed: finalName !== wanted },
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
      const raw = await readBody(request, MAX_RPC_BYTES)
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
