/**
 * dsh-file-extras —— 文件驱动的斜杠命令：解析与发现（纯函数，零依赖）。
 *
 * 移植自 https://github.com/TiChuXiXi/dsh-command-md 的 `lib/parse.js`（同一作者，MIT）。
 * 只保留纯逻辑，Cordis 注册那一层搬进 `index.js` —— 这样这一层可以脱离 DSH 单独跑测试。
 *
 * 约定（与 opencode 的命令文件一致）：
 *   · `~/.dsh/commands/<name>.md` 一个文件一条全局斜杠命令，命令名就是去掉 `.md` 的文件名；
 *   · 文件开头可选的 YAML frontmatter 里读 `description`（发现界面里的说明）与
 *     `input-hint`（输入提示），其余键忽略但容忍；
 *   · 正文里的 `$ARGUMENTS` 占位符会被用户敲在命令后面的原始参数替换；
 *   · 正文在**每次调用时**重新读盘，所以改文件立即生效，不用重启。
 *
 * @module dsh-file-extras/commands-md
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 命令名文法，与 `dsh-commands` 注册表自己的那一条**逐字相同**
 * （`@deepseek-ai/dsh-commands` 的 `COMMAND_NAME`）。在发现阶段就按它筛，
 * 不合法的文件名直接跳过，而不是等到 `ctx.commands.register()` 抛异常。
 */
export const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/**
 * YAML frontmatter 的围栏。只有**行首**的 `---` 才算开场；
 * 之后第一条正好是 `---`（允许尾随空白）的行收尾。
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/

/** 正文里的参数占位符。 */
export const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS'

/** frontmatter 里一行 `key: value`。 */
const KEY_VALUE_RE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/

/** `#` 只有在前面有空白时才是注释起点。 */
function stripInlineComment(value) {
  const hash = value.search(/[ \t]+#/)
  return hash === -1 ? value : value.slice(0, hash)
}

/** 去掉成对的首尾引号（`'` 或 `"`）。 */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** 这个原始值是不是一个完整的带引号标量？ */
function isQuoted(value) {
  const trimmed = value.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '"' && last === '"') || (first === "'" && last === "'")
}

/**
 * 解析命令文件的 YAML frontmatter 前缀。
 *
 * 只支持命令文件真正会用到的子集：`key: value` 标量对。值可以用 `'` / `"` 引起来，
 * 也可以带尾随 `#` 注释。没有开场围栏时 frontmatter 为空、整个文件都是正文。
 *
 * @param {string} content - 文件原始文本。
 * @returns {{ frontmatter: Record<string, string>, body: string }} 解析结果；
 *   `body` 是收尾围栏之后的文本（去掉开头的空行）。
 */
export function parseCommandFile(content) {
  // 先剥掉 BOM，否则 `^---` 锚不住。
  const text = content.replace(/^\uFEFF/, '')
  const match = FRONTMATTER_RE.exec(text)
  if (!match) {
    return { frontmatter: {}, body: text.trim() }
  }
  const frontmatter = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const kv = KEY_VALUE_RE.exec(rawLine)
    if (!kv) continue
    const value = kv[2]
    if (value.trim().length === 0) continue
    frontmatter[kv[1]] = isQuoted(value) ? unquote(value) : unquote(stripInlineComment(value))
  }
  return { frontmatter, body: text.slice(match[0].length).trim() }
}

/**
 * 从文件名推命令名；扩展名不对或名字不合文法时返回 `undefined`。
 * @param {string} fileName - 目录项的文件名。
 * @returns {string | undefined} 合法的命令名。
 */
export function commandNameFromFile(fileName) {
  if (!fileName.toLowerCase().endsWith('.md')) return undefined
  const name = fileName.slice(0, -3)
  return COMMAND_NAME.test(name) ? name : undefined
}

/**
 * 扫一个用户级命令目录。
 *
 * 目录不存在或读不了**不算错误**（就是没有命令）；单个文件读不了或超限则跳过。
 *
 * @param {object} options - 参数。
 * @param {string} options.userDir - 用户命令目录（默认 `~/.dsh/commands`）。
 * @param {number} [options.maxBytes] - 单文件字节上限。
 * @returns {Array<{name: string, file: string, description: string, inputHint?: string}>}
 *   按名字排序的发现结果。
 */
export function discoverCommandFiles({ userDir, maxBytes = 1024 * 1024 }) {
  let entries
  try {
    entries = readdirSync(userDir, { withFileTypes: true })
  } catch {
    return []
  }

  const discovered = []
  for (const entry of entries) {
    // 只认普通文件：软链接到这里一律跳过，避免命令文件变成任意路径读取的入口。
    if (!entry.isFile()) continue
    const name = commandNameFromFile(entry.name)
    if (!name) continue
    const file = resolve(userDir, entry.name)
    let content
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (Buffer.byteLength(content, 'utf8') > maxBytes) continue
    const { frontmatter } = parseCommandFile(content)
    const description = frontmatter.description?.trim() || `运行 /${name}`
    discovered.push({
      name,
      file,
      description,
      inputHint: frontmatter['input-hint']?.trim() || undefined,
    })
  }

  return discovered.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 把正文渲染成真正发给模型的提示词。
 * @param {string} body - 命令文件正文。
 * @param {string} rawInput - 用户敲在命令名后面的原始参数（含分隔空白）。
 * @returns {string} 替换过 `$ARGUMENTS` 的提示词。
 */
export function buildPrompt(body, rawInput) {
  const args = rawInput.trim()
  if (!body.includes(ARGUMENTS_PLACEHOLDER)) return body
  return body.split(ARGUMENTS_PLACEHOLDER).join(args)
}

/**
 * 读盘并渲染某条命令的当前内容（每次调用都重新读，改文件立即生效）。
 * @param {string} file - 命令文件的绝对路径。
 * @param {number} maxBytes - 读取的字节上限。
 * @param {string} rawInput - 本次调用的参数。
 * @returns {string} 渲染好的提示词。
 * @throws 文件读不了或超过上限时抛错（由调用方转成命令的 error 结果）。
 */
export function renderPrompt(file, maxBytes, rawInput) {
  const content = readFileSync(file, 'utf8')
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new Error(`命令文件超过 ${maxBytes} 字节上限：${file}`)
  }
  const { body } = parseCommandFile(content)
  return buildPrompt(body, rawInput)
}
