/**
 * 跨平台「移入回收站」。
 *
 * 为什么需要一整个模块：回收站**不是文件系统特性**，三个平台三套完全不同的机制，
 * 而 Node 一个都不提供 —— `fs.rm` / `unlink` / `rmdir` 落到的是内核的删除原语
 * （Windows 的 `DeleteFileW`、POSIX 的 `unlink(2)`），删掉就是删掉。
 *
 *   · **Windows**：回收站是 **Shell** 特性。真正「移入回收站」的是 `SHFileOperation` /
 *     `IFileOperation`，它要在 `<卷>:\$Recycle.Bin\<SID>\` 下写一对
 *     `$I`（元数据：原路径 + 删除时间）+ `$R`（数据）文件，并登记进当前用户的回收站索引。
 *     手工把文件挪进 `$Recycle.Bin` 没用 —— 没有 `$I` 边车，资源管理器既列不出来也没法还原。
 *     Node 够不到 Shell 那一层，所以这一路外包给 Windows PowerShell 5.1 的
 *     `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile/DeleteDirectory`（内部就是
 *     `SHFileOperation`，`OnlyErrorDialogs` 关掉确认框，失败会抛异常）。
 *
 *   · **Linux**：走 freedesktop.org 的 Trash 规范 —— 纯粹是「挪进目录 + 写一个文本文件」，
 *     不需要任何特权 API。`~/.local/share/Trash/{files,info}/`，`info/<名字>.trashinfo`
 *     是 INI 形式的 `Path=`（百分号编码）+ `DeletionDate=`。别的卷上的文件用该卷根下的
 *     `.Trash/<uid>` 或 `.Trash-<uid>`。
 *
 *   · **macOS**：同样只是目录 —— `~/.Trash/`；别的卷用 `<卷根>/.Trashes/<uid>/`。
 *
 * Linux / macOS 这两条路是**直接实现的协议**（不是子进程），所以逻辑可以注入平台与家目录
 * 在任意机器上实测 —— `scripts/selftest.mjs` 就在 Windows 上真跑了这两条分支。
 *
 * 已知取舍：
 *   · 手工挪进 macOS 的 `~/.Trash` 不会写 Finder 的「放回原处」元数据（那在 `.DS_Store` 里，
 *     只有 Finder 自己写），所以文件能还原、但「放回原处」不可用。
 *   · 软链接在 Windows 上一律走 `fs.rm`：`DeleteDirectory` 会顺着联接点递归，那是能删掉
 *     工作区外数据的事故，不能接。POSIX 上 `rename` 只搬链接本身，安全，所以按常规进回收站。
 */

import { spawn } from 'node:child_process'
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

/** 回收站不可用（平台没有后端、或缺 PowerShell）—— 调用方据此报错，**绝不**退化成永久删除。 */
export const TRASH_UNAVAILABLE = 'file-extras/trash-unavailable'

/** 造一个带 `code` 的错误：index.js 的失败映射认 `file-extras/*` 开头的 code。 */
function trashError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 任意异常压成可读字符串。 */
function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 路径存在与否（不关心是文件还是目录）。 */
async function exists(path) {
  return (await stat(path).catch(() => undefined)) !== undefined
}

/**
 * 找一个路径所在**文件系统**的挂载根：一路向上走到设备号变化为止。
 * @param path - 绝对路径。
 * @returns {Promise<{ root: string, device: number | bigint }>} 挂载根与设备号。
 */
async function mountOf(path) {
  let current = resolvePath(path)
  const info = await stat(current)
  const device = info.dev
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return { root: current, device }
    const parentInfo = await stat(parent).catch(() => undefined)
    if (parentInfo === undefined || parentInfo.dev !== device) return { root: current, device }
    current = parent
  }
}

/**
 * 在目标目录里挑一个不冲突的名字；冲突时依次试 `<名字>.2`、`<名字>.3`……
 * @param directory - 目标目录。
 * @param name - 期望的名字。
 * @param alsoFree - 额外的占用判定（Linux 还要看同名 `.trashinfo`）。
 * @returns {Promise<string>} 可用的名字。
 */
async function uniqueName(directory, name, alsoFree) {
  let candidate = name
  for (let index = 2; index < 1000; index += 1) {
    const taken = (await exists(join(directory, candidate))) || (alsoFree !== undefined && (await alsoFree(candidate)))
    if (!taken) return candidate
    candidate = `${name}.${index}`
  }
  throw trashError('file-extras/trash-failed', `回收站里同名条目太多，无法为 ${name} 找到位置`)
}

/* ------------------------------------------------------------------ Windows */

/**
 * 回收站删除脚本 —— 交给 **Windows PowerShell 5.1**（`powershell.exe`）执行。
 *
 * 用 `powershell.exe` 而不是 `pwsh`：`pwsh` 是 PowerShell 6+（.NET Core），
 * `Microsoft.VisualBasic` 不在它的框架里（`Add-Type` 不报错但类型找不到）；
 * 5.1 跑在 .NET Framework 上，这个程序集在 GAC 里，直接可用。
 *
 * 输入走 **stdin 的 UTF-8 JSON**（路径不过命令行，彻底避开引号/长路径/编码问题），
 * 输出走 **stdout 的 JSONL**（一行一条，绕开 PowerShell 5.1 的 `ConvertTo-Json`
 * 单元素数组塌陷问题）。脚本本体走 `-EncodedCommand`（UTF-16LE base64），
 * 连脚本里的引号都不用操心，也不受控制台代码页影响。
 */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $null = [Microsoft.VisualBasic.FileIO.FileSystem]
} catch {
  Write-Output (ConvertTo-Json -Compress @{ kind = 'unavailable'; message = $_.Exception.Message })
  exit 0
}
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($item in $payload.items) {
  try {
    if ($item.kind -eq 'directory') {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($item.path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($item.path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    Write-Output (ConvertTo-Json -Compress @{ path = $item.path; ok = $true })
  } catch {
    Write-Output (ConvertTo-Json -Compress @{ path = $item.path; ok = $false; message = $_.Exception.Message })
  }
}
`

/** 预编码好的脚本（PowerShell 的 `-EncodedCommand` 要 UTF-16LE base64）。 */
const WINDOWS_ENCODED = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')

/** 一次回收站调用的超时。 */
const WINDOWS_TIMEOUT_MS = 60000

/** Windows PowerShell 5.1 的绝对路径 —— 不能靠 PATH，`pwsh` 会先被解析到。 */
function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Windows 后端：真实文件/目录交给 Shell，软链接直接 `fs.rm`（见文件头注释）。
 * @param items - { path, kind } 列表。
 * @param cwd - 子进程工作目录。
 * @returns {Promise<Map<string, object>>} 真实路径 → 逐条结果。
 */
async function trashWindows(items, cwd) {
  const results = new Map()
  /** 软链接不进 Shell，就地永久删掉；其余攒起来一次调用。 */
  const queued = []
  for (const item of items) {
    if (item.kind !== 'link') {
      queued.push(item)
      continue
    }
    try {
      await rm(item.path, { recursive: true, force: false })
      results.set(item.path, { ok: true, mode: 'permanent' })
    } catch (cause) {
      results.set(item.path, { ok: false, message: messageOf(cause) })
    }
  }
  if (queued.length === 0) return results

  const answer = await new Promise((settle, fail) => {
    let child
    try {
      child = spawn(windowsPowerShellPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', WINDOWS_ENCODED,
      ], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (cause) {
      fail(trashError(TRASH_UNAVAILABLE, `无法启动 PowerShell：${messageOf(cause)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill()
      fail(trashError('file-extras/trash-timeout', `移入回收站超时（${WINDOWS_TIMEOUT_MS} ms）`))
    }, WINDOWS_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (cause) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fail(trashError(TRASH_UNAVAILABLE, `无法启动 PowerShell：${messageOf(cause)}`))
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle({ code, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify({ items: queued.map((item) => ({ path: item.path, kind: item.kind })) }))
  })

  const lines = String(answer.stdout).split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
  for (const line of lines) {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.kind === 'unavailable') {
      // 脚本自己判断「这台机器没有回收站 API」：这是环境事实，不是本次删除的失败原因。
      throw trashError(TRASH_UNAVAILABLE, `本机无法移到回收站：${parsed.message ?? '未知原因'}`)
    }
    if (typeof parsed.path === 'string') {
      results.set(parsed.path, parsed.ok === true ? { ok: true, mode: 'trash' } : { ok: false, message: parsed.message })
    }
  }
  if (results.size === 0) {
    // 一条 JSON 都没拿到：多半是 PowerShell 直接栽了，把 stderr 尾巴带上便于定位。
    const tail = String(answer.stderr).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
    throw trashError(TRASH_UNAVAILABLE, `回收站调用没有返回结果（退出码 ${answer.code}）${tail === '' ? '' : `：${tail}`}`)
  }
  return results
}

/* -------------------------------------------------------------- Linux / macOS */

/** 按 freedesktop 规范编码 `Path=`：逐段百分号编码，但保留分隔符 `/`。 */
function encodeTrashPath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

/** `YYYY-MM-DDThh:mm:ss`（本地时间，规范要求的形式）。 */
function trashTimestamp(date) {
  const pad = (value) => (value < 10 ? `0${value}` : String(value))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Linux 后端：freedesktop.org Trash 规范。
 *
 * 同卷 → `$XDG_DATA_HOME/Trash`（默认 `~/.local/share/Trash`）；跨卷 → 该卷根下的
 * `.Trash/<uid>`（只有当 `.Trash` 是真实目录且带 sticky 位时）或 `.Trash-<uid>`。
 * `files/` 放数据、`info/<名字>.trashinfo` 放原路径与删除时间。
 * @param items - { path, kind } 列表。
 * @param env - { home, dataHome, uid }。
 * @returns {Promise<Map<string, object>>} 真实路径 → 逐条结果。
 */
async function trashLinux(items, env) {
  const results = new Map()
  const homeTrash = join(env.dataHome ?? join(env.home, '.local', 'share'), 'Trash')
  for (const item of items) {
    try {
      const target = await linuxTrashDirectory(item.path, homeTrash, env.uid)
      const filesDir = join(target, 'files')
      const infoDir = join(target, 'info')
      await mkdir(filesDir, { recursive: true, mode: 0o700 })
      await mkdir(infoDir, { recursive: true, mode: 0o700 })
      const name = basename(item.path)
      const unique = await uniqueName(filesDir, name, (candidate) => exists(join(infoDir, `${candidate}.trashinfo`)))
      // 规范要求先写 .trashinfo 再搬数据：中途崩了只会留一个孤儿记录，不会出现「有数据没记录」。
      const infoPath = join(infoDir, `${unique}.trashinfo`)
      await writeFile(infoPath, `[Trash Info]\nPath=${encodeTrashPath(resolvePath(item.path))}\nDeletionDate=${trashTimestamp(new Date())}\n`, 'utf8')
      try {
        await rename(item.path, join(filesDir, unique))
      } catch (cause) {
        await unlink(infoPath).catch(() => undefined)
        throw cause
      }
      results.set(item.path, { ok: true, mode: 'trash' })
    } catch (cause) {
      results.set(item.path, { ok: false, message: messageOf(cause) })
    }
  }
  return results
}

/**
 * 选一个 Linux 回收站目录：同卷用家目录那个，跨卷用该卷根下的。
 * @param path - 待回收的真实路径。
 * @param homeTrash - `$XDG_DATA_HOME/Trash`。
 * @param uid - 当前用户 id。
 * @returns {Promise<string>} 回收站目录（尚未保证存在）。
 */
async function linuxTrashDirectory(path, homeTrash, uid) {
  const mount = await mountOf(path)
  await mkdir(homeTrash, { recursive: true, mode: 0o700 })
  if ((await stat(homeTrash)).dev === mount.device) return homeTrash
  const shared = join(mount.root, '.Trash')
  const sharedInfo = await stat(shared).catch(() => undefined)
  // `.Trash` 是各用户共用的：必须是真实目录（不是软链接）且带 sticky 位，才敢用它的 uid 子目录。
  if (sharedInfo?.isDirectory() === true && (sharedInfo.mode & 0o1000) !== 0) return join(shared, String(uid))
  return join(mount.root, `.Trash-${uid}`)
}

/**
 * macOS 后端：同卷 → `~/.Trash`；跨卷 → `<卷根>/.Trashes/<uid>`。
 * @param items - { path, kind } 列表。
 * @param env - { home, uid }。
 * @returns {Promise<Map<string, object>>} 真实路径 → 逐条结果。
 */
async function trashMac(items, env) {
  const results = new Map()
  const homeTrash = join(env.home, '.Trash')
  const homeInfo = await stat(env.home).catch(() => undefined)
  for (const item of items) {
    try {
      const mount = await mountOf(item.path)
      // 家目录所在卷就是启动卷：同卷直接进 ~/.Trash；别的卷归自己的 .Trashes。
      const directory = homeInfo !== undefined && homeInfo.dev === mount.device
        ? homeTrash
        : join(mount.root, '.Trashes', String(env.uid))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const name = basename(item.path)
      await rename(item.path, join(directory, await uniqueName(directory, name)))
      results.set(item.path, { ok: true, mode: 'trash' })
    } catch (cause) {
      results.set(item.path, { ok: false, message: messageOf(cause) })
    }
  }
  return results
}

/* -------------------------------------------------------------------- 入口 */

/**
 * 把一批路径移入回收站。
 *
 * @param {Array<{ path: string, kind: 'file' | 'directory' | 'link' }>} items - 待回收项（path 用真实路径）。
 * @param {object} [options] - 调用环境；非 Windows 平台可注入以做跨平台自检。
 * @param {string} [options.cwd] - Windows 子进程工作目录（默认取第一项所在目录）。
 * @param {NodeJS.Platform} [options.platform] - 目标平台（默认 `process.platform`）。
 * @param {string} [options.home] - 家目录（默认 `os.homedir()`）。
 * @param {string} [options.dataHome] - `$XDG_DATA_HOME`（默认取环境变量，再退回 `~/.local/share`）。
 * @param {number} [options.uid] - 当前用户 id（默认 `process.getuid()`）。
 * @returns {Promise<Map<string, { ok: boolean, mode?: 'trash' | 'permanent', message?: string }>>}
 *   真实路径 → 逐条结果。**平台级**失败会直接抛错（code 为 `file-extras/trash-unavailable`），
 *   调用方据此报错而**绝不能**悄悄改成永久删除。
 */
export async function moveToTrash(items, options = {}) {
  const platform = options.platform ?? process.platform
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0)
  if (items.length === 0) return new Map()
  if (platform === 'win32') {
    const cwd = options.cwd ?? dirname(items[0].path)
    return await trashWindows(items, cwd)
  }
  if (platform === 'linux') {
    return await trashLinux(items, {
      home: options.home ?? homedir(),
      dataHome: options.dataHome ?? process.env.XDG_DATA_HOME,
      uid,
    })
  }
  if (platform === 'darwin') {
    return await trashMac(items, { home: options.home ?? homedir(), uid })
  }
  throw trashError(TRASH_UNAVAILABLE, `平台 ${platform} 没有实现回收站后端`)
}
