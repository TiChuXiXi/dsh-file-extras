/**
 * 浏览器半区的**真机 DOM 自检**：用本机 Chrome 起一个 headless 实例，加载一个临时页面 ——
 * 页面里放一份**照抄官方工作区文件树 DOM 契约**的静态 HTML（`data-files-state` /
 * `data-files-root` / `data-files-entry` / `data-files-path` / `data-files-body` /
 * `data-files-reload`），再挂上真正的 `lib/client.js`，然后用 CDP 取回**渲染后的结果**做断言。
 *
 * 为什么必须真机：本插件的三条关键行为都只在真布局引擎里成立 ——
 *   · 大小/日期是写进行元素 `data-fx-meta` 后由 CSS `::after{content:attr(...)}` 显示出来的，
 *     属性写没写上、`::after` 有没有真的产出文本，只有浏览器说了算；
 *   · 元数据靠 `margin-left:auto` 推到行尾、名字靠 `min-width:0` 让位，会不会压成一团要看几何；
 *   · 右键菜单挂在 `shell.overlay` 里（position:fixed），夹回视口的逻辑要用真实视口尺寸。
 *
 * 用法：node scripts/dom-probe.mjs [--debug] [--shot <目录>]
 * 依赖：本机 Chrome/Edge；react/react-dom 的 UMD 构建（缺了会提示并跳过）。
 *   npm install --prefix .npm-cache/domprobe --registry=https://registry.npmjs.org react@18.3.1 react-dom@18.3.1
 *
 * 注意：沙箱会禁掉命名管道，Chrome 的渲染进程会 FATAL platform_channel，所以这个脚本要在
 * 放宽权限（danger-full-access）下运行；缺浏览器/缺 React 时自动跳过（退出码 0）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, '.npm-cache', 'domprobe')
const CLIENT = process.env.DOM_PROBE_CLIENT ?? join(ROOT, 'lib', 'client.js')
const PORT = Number(process.env.DOM_PROBE_PORT ?? 9341)
const DEBUG = process.argv.includes('--debug')
const SHOT_AT = process.argv.indexOf('--shot')
const SHOT_DIR = SHOT_AT > 0 && process.argv[SHOT_AT + 1] !== undefined ? process.argv[SHOT_AT + 1] : null

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = BROWSERS.find((path) => path !== '' && existsSync(path))
const reactUmd = join(SCRATCH, 'node_modules', 'react', 'umd', 'react.production.min.js')
const reactDomUmd = join(SCRATCH, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js')

if (browser === undefined) {
  console.log('跳过：本机没找到 Chrome/Edge（真机 DOM 自检需要浏览器）')
  process.exit(0)
}
if (!existsSync(reactUmd) || !existsSync(reactDomUmd)) {
  console.log(`跳过：缺少 react/react-dom UMD。先装：npm install --prefix ${SCRATCH} --cache ${join(ROOT, '.npm-cache')} --registry=https://registry.npmjs.org react@18.3.1 react-dom@18.3.1`)
  process.exit(0)
}

/* ------------------------------------------------------------------ 夹具数据 */

const FIXTURE_ROOT = 'D:\\fixture'

/** 本年的时间戳。 */
const RECENT = new Date(new Date().getFullYear(), 2, 4, 13, 6, 7, 0).getTime()
/** 跨年的时间戳：日期格式不该因为年份不同而变样，这一条专门盯它。 */
const OLD = new Date(2020, 4, 6, 9, 8, 7, 0).getTime()

/** 路径 → host 会回什么。与 index.js 的 stat 端点返回形状逐字一致。 */
const ENTRIES = {
  [`${FIXTURE_ROOT}\\alpha.txt`]: { type: 'file', size: 1234, mtimeMs: RECENT },
  [`${FIXTURE_ROOT}\\big.bin`]: { type: 'file', size: 5 * 1024 * 1024, mtimeMs: RECENT },
  [`${FIXTURE_ROOT}\\empty.txt`]: { type: 'file', size: 0, mtimeMs: OLD },
  [`${FIXTURE_ROOT}\\old.txt`]: { type: 'file', size: 1536, mtimeMs: OLD },
  [`${FIXTURE_ROOT}\\missing.txt`]: { error: 'missing' },
  [`${FIXTURE_ROOT}\\sub`]: { type: 'directory', childCount: 3, mtimeMs: RECENT },
  [`${FIXTURE_ROOT}\\sub\\a.txt`]: { type: 'file', size: 999, mtimeMs: RECENT },
  [`${FIXTURE_ROOT}\\sub\\pipe`]: { type: 'other', mtimeMs: RECENT },
  [`${FIXTURE_ROOT}\\sub\\a-very-long-file-name-to-force-ellipsis.txt`]: { type: 'file', size: 2048, mtimeMs: RECENT },
}

const pad2 = (value) => (value < 10 ? `0${value}` : String(value))
/** 与 lib/client.js 的 formatDate 逐字一致：一律完整时间戳。 */
const expectDate = (ms) => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** 期望渲染出来的行内文本。 */
const EXPECTED_META = {
  [`${FIXTURE_ROOT}\\alpha.txt`]: `1.2 KB · ${expectDate(RECENT)}`,
  [`${FIXTURE_ROOT}\\big.bin`]: `5.0 MB · ${expectDate(RECENT)}`,
  [`${FIXTURE_ROOT}\\empty.txt`]: `0 B · ${expectDate(OLD)}`,
  [`${FIXTURE_ROOT}\\old.txt`]: `1.5 KB · ${expectDate(OLD)}`,
  [`${FIXTURE_ROOT}\\sub`]: `3 项 · ${expectDate(RECENT)}`,
  [`${FIXTURE_ROOT}\\sub\\a.txt`]: `999 B · ${expectDate(RECENT)}`,
  [`${FIXTURE_ROOT}\\sub\\a-very-long-file-name-to-force-ellipsis.txt`]: `2.0 KB · ${expectDate(RECENT)}`,
}

/* ------------------------------------------------------------------ 页面 */

/** 照抄官方 sidebar-files 的 DOM 契约 + 关键布局 CSS（类名换成 fx-，规则逐条对应）。 */
function buildHtml() {
  const row = (kind, path, name) => kind === 'directory'
    ? `<li data-files-entry="directory" data-files-path="${path}"><button class="fx-row" aria-expanded="true"><svg class="fx-icon" width="16" height="16"></svg><span class="fx-name">${name}</span></button><ul class="fx-level">${NESTED}</ul></li>`
    : kind === 'other'
      ? `<li data-files-entry="other" data-files-path="${path}"><span class="fx-row fx-other" aria-disabled="true" title="其他"><span class="fx-name">${name}</span></span></li>`
      : `<li data-files-entry="file" data-files-path="${path}"><button class="fx-row"><svg class="fx-icon" width="16" height="16"></svg><span class="fx-name">${name}</span></button></li>`

  const NESTED = [
    row('file', `${FIXTURE_ROOT}\\sub\\a.txt`, 'a.txt'),
    row('other', `${FIXTURE_ROOT}\\sub\\pipe`, 'pipe'),
    row('file', `${FIXTURE_ROOT}\\sub\\a-very-long-file-name-to-force-ellipsis.txt`, 'a-very-long-file-name-to-force-ellipsis.txt'),
  ].join('')

  const top = [
    row('directory', `${FIXTURE_ROOT}\\sub`, 'sub'),
    row('file', `${FIXTURE_ROOT}\\alpha.txt`, 'alpha.txt'),
    row('file', `${FIXTURE_ROOT}\\big.bin`, 'big.bin'),
    row('file', `${FIXTURE_ROOT}\\empty.txt`, 'empty.txt'),
    row('file', `${FIXTURE_ROOT}\\old.txt`, 'old.txt'),
    row('file', `${FIXTURE_ROOT}\\missing.txt`, 'missing.txt'),
  ].join('')

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
/* 真机页面有全局 border-box 重置（少了它，官方 .row{width:100%;padding:5px 10px} 会自己撑宽 20px）。 */
*,*::before,*::after{box-sizing:border-box}
:root{
  --dsw-alias-label-primary:#1f2329;--dsw-alias-label-secondary:#5c6370;--dsw-alias-label-tertiary:#8b939f;
  --dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#f5f6f8;--dsw-alias-bg-overlay:#ffffff;
  --dsw-alias-border-l1:#e6e8eb;--dsw-alias-border-l2:#d5d8dd;--dsw-alias-interactive-bg-hover:#eef0f3;
  --dsw-alias-state-error-primary:#d92d20;
}
html.dark{
  --dsw-alias-label-primary:#e6e8eb;--dsw-alias-label-secondary:#a8aeb8;--dsw-alias-label-tertiary:#7d848f;
  --dsw-alias-bg-base:#17181a;--dsw-alias-bg-layer-1:#1e1f22;--dsw-alias-bg-layer-2:#26282c;--dsw-alias-bg-overlay:#26282c;
  --dsw-alias-border-l1:#33363b;--dsw-alias-border-l2:#41454b;--dsw-alias-interactive-bg-hover:#2f3237;
  --dsw-alias-state-error-primary:#ff6b6b;
}
html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.5 system-ui,sans-serif}
/* —— 以下布局规则逐条照搬官方 sidebar-files 的样式表（只改类名前缀） —— */
#panel{width:340px;height:560px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1)}
.fx-root{height:100%;min-height:0;color:var(--dsw-alias-label-primary);flex-direction:column;flex:auto;display:flex}
.fx-header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none;align-items:center;gap:4px;height:38px;padding:0 6px 0 16px;display:flex}
.fx-body{scrollbar-gutter:stable;flex:auto;min-height:0;margin-right:2px;padding:8px 0 8px 8px;overflow:auto}
.fx-level{margin:0;padding:0;list-style:none}
.fx-level .fx-level{padding-left:18px}
.fx-item{margin:0;padding:0}
.fx-row{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;border-radius:6px;cursor:pointer;background:0 0;border:0;align-items:center;gap:6px;padding:5px 10px;display:flex}
.fx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fx-icon{color:var(--dsw-alias-label-tertiary);flex:none}
.fx-other{color:var(--dsw-alias-label-tertiary);cursor:default}
.fx-name{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}
.fx-tool{width:28px;height:28px}
</style></head><body>
<div id="panel">
  <div class="fx-root" data-files-state="tree" data-files-root="${FIXTURE_ROOT}">
    <div class="fx-header"><span data-files-path>${FIXTURE_ROOT}</span><button class="fx-tool" data-files-reload>⟳</button></div>
    <div class="fx-body" data-files-body><ul class="fx-level">${top}</ul></div>
  </div>
</div>
<div id="outside" style="position:fixed;left:0;bottom:0;width:340px;height:40px;background:var(--dsw-alias-bg-layer-2)">树外的空白区</div>
<div id="overlay-root"></div>
<script>window.__ModuleLoader__ = { load: (spec) => { window.__entry = spec } }</script>
<script>${readFileSync(reactUmd, 'utf8')}</script>
<script>${readFileSync(reactDomUmd, 'utf8')}</script>
<script>${readFileSync(CLIENT, 'utf8')}</script>
<script>window.__fixtureRoot = ${JSON.stringify(FIXTURE_ROOT)}</script>
<script>window.__entries = ${JSON.stringify(ENTRIES)}</script>
<script>window.__expectedMeta = ${JSON.stringify(EXPECTED_META)}</script>
</body></html>`
}

/* ------------------------------------------------------------------ 页面探针 */

const pageScript = `
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

window.__errors = []
window.addEventListener('error', (event) => window.__errors.push(String(event.message || event.error)))
window.addEventListener('unhandledrejection', (event) => window.__errors.push('unhandledrejection: ' + String(event.reason)))

/* —— 记录被点过的「官方重载按钮」与发出去的请求 —— */
window.__reloadClicks = 0
document.querySelector('[data-files-reload]').addEventListener('click', () => { window.__reloadClicks += 1 })

window.__calls = []
window.__fetchCalls = []
window.__fetchMode = 'ok'
window.__clipboard = []
const realFetch = window.fetch

const callChannel = async (channel, endpoint, payload) => {
  window.__calls.push({ channel, endpoint, payload })
  if (endpoint !== 'stat') return { ok: false, error: { code: 'x/unknown', message: '未知端点', details: {} } }
  const entries = payload.paths.map((path) => {
    const known = window.__entries[path]
    return known === undefined ? { path, error: 'missing' } : { path, ...known }
  })
  return { ok: true, value: { root: payload.root, entries } }
}

/* —— 挂上真正的客户端半区 —— */
const half = window.__entry.factory((name) => {
  if (name === 'react') return window.React
  throw new Error('未提供的模块 ' + name)
})
const registered = {}
half.apply({
  effect: (fn) => { fn(); return () => {} },
  slots: {
    inject: (name, fn) => { fn(); return () => {} },
    register: (spec, component) => { registered[spec.id] = component; return () => {} },
  },
  connection: { rpc: { call: callChannel } },
})
if (registered['dsh-file-extras-menu'] === undefined) {
  return { error: 'shell.overlay 上没注册到 dsh-file-extras-menu，注册到的是：' + Object.keys(registered).join(',') }
}
ReactDOM.createRoot(document.getElementById('overlay-root')).render(React.createElement(registered['dsh-file-extras-menu']))
await wait(300)

/* —— 桩：剪贴板 / fetch / 锚点 / 文件选择器 —— */
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text) => { window.__clipboard.push(text) } },
})
window.fetch = async (url, init) => {
  window.__fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET', hasBody: Boolean(init && init.body) })
  if (window.__fetchMode === 'download-error' || window.__fetchMode === 'download-error-200') {
    // 两种失败形态都要能变成提示：
    //   download-error     —— host 现在对字节通道回真正的错误状态；
    //   download-error-200 —— 老「200 + {ok:false}」信封，靠 content-type 兜住。
    const status = window.__fetchMode === 'download-error' ? 413 : 200
    return new Response(JSON.stringify({ ok: false, error: { code: 'file-extras/too-large', message: '文件超过下载上限 512 MiB', details: {} } }), { status, headers: { 'content-type': 'application/json' } })
  }
  if (String(url).includes('/download')) {
    return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  }
  return new Response(JSON.stringify({ ok: true, value: { path: 'x', name: 'y', size: 1, renamed: false } }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const createdUrls = []
const realCreate = URL.createObjectURL.bind(URL)
URL.createObjectURL = (blob) => { const url = realCreate(blob); createdUrls.push(url); return url }
window.__createdUrls = createdUrls
HTMLAnchorElement.prototype.click = function stubClick() { window.__anchorClicks = (window.__anchorClicks || 0) + 1 }
window.__pickedInputs = []
const realInputClick = HTMLInputElement.prototype.click
HTMLInputElement.prototype.click = function stubInputClick() {
  window.__pickedInputs.push(this)
  // 不真的弹选择器：把 this 记下来，由探针自己塞 files 再派发 change。
}

const root = document.querySelector('[data-files-state="tree"]')
const body = document.querySelector('[data-files-body]')
const rowOf = (path) => root.querySelector('[data-files-path="' + path.replace(/\\\\/g, '\\\\\\\\') + '"].fx-item, [data-files-entry][data-files-path="' + path.replace(/\\\\/g, '\\\\\\\\') + '"]')
const rows = () => [...root.querySelectorAll('[data-files-entry]')]
const rowFor = (path) => rows().find((node) => node.getAttribute('data-files-path') === path)
const metaTextOf = (li) => {
  const row = li.firstElementChild
  if (row === null) return null
  const attr = row.getAttribute('data-fx-meta')
  const content = getComputedStyle(row, '::after').content
  return { attr, content, mark: li.getAttribute('data-fx-mark'), title: li.getAttribute('title') }
}
const menuNode = () => document.querySelector('.dsh-fx-menu')
const menuLabels = () => [...document.querySelectorAll('.dsh-fx-menu-item')].map((node) => (node.textContent || '').trim())
const toastText = () => {
  const node = document.querySelector('.dsh-fx-toast')
  return node === null ? null : (node.textContent || '')
}
const rightClick = (node, x, y) => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 })
  const notCancelled = node.dispatchEvent(event)
  return { defaultPrevented: event.defaultPrevented, dispatchReturn: notCancelled }
}
const clickMenuItem = async (label) => {
  const node = [...document.querySelectorAll('.dsh-fx-menu-item')].find((item) => (item.textContent || '').trim() === label)
  if (node === undefined) return false
  node.click()
  await wait(250)
  return true
}
const rectOf = (node) => {
  const box = node.getBoundingClientRect()
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }
}

const result = { errors: window.__errors, calls: window.__calls, screenshots: {} }

/* ================= 1. 元数据：属性 + ::after 真的渲染出文本 ================= */
await wait(400)
result.rows = rows().map((li) => {
  const path = li.getAttribute('data-files-path')
  const row = li.firstElementChild
  return {
    path,
    entry: li.getAttribute('data-files-entry'),
    meta: metaTextOf(li),
    nameWidth: row === null ? null : rectOf(row.querySelector('.fx-name') ?? row).width,
    rowWidth: row === null ? null : rectOf(row).width,
  }
})
result.expectedMeta = window.__expectedMeta
result.metaMismatch = Object.entries(window.__expectedMeta).map(([path, want]) => {
  const found = result.rows.find((row) => row.path === path)
  const got = found === undefined || found.meta === null ? null : found.meta.attr
  return got === want ? null : { path, want, got }
}).filter((item) => item !== null)
result.metaMissing = result.rows.filter((row) => row.meta !== null && row.meta.attr !== null).length
// ::after 的 content 必须是带引号的同一段文本
result.pseudoMismatch = result.rows.map((row) => {
  if (row.meta === null || row.meta.attr === null) return null
  const want = JSON.stringify(row.meta.attr)
  return row.meta.content === want ? null : { path: row.path, want, got: row.meta.content }
}).filter((item) => item !== null)
// other / missing 不许有元数据
result.shouldHaveNoMeta = rows()
  .filter((li) => ['other'].includes(li.getAttribute('data-files-entry'))
    || ['D:\\\\fixture\\\\missing.txt'].includes(li.getAttribute('data-files-path')))
  .map((li) => ({ path: li.getAttribute('data-files-path'), meta: metaTextOf(li) }))

/* ================= 2. 右键：文件 / 目录 / 空白 ================= */
// 2a. 文件行
const fileLi = rowFor('D:\\\\fixture\\\\alpha.txt')
result.fileRightClick = rightClick(fileLi.firstElementChild, 120, 200)
await wait(200)
result.fileMenu = { labels: menuLabels(), box: menuNode() === null ? null : rectOf(menuNode()), title: document.querySelector('.dsh-fx-menu-title')?.textContent ?? null }

// 2b. 目录行
const dirLi = rowFor('D:\\\\fixture\\\\sub')
result.dirRightClick = rightClick(dirLi.firstElementChild, 120, 120)
await wait(200)
result.dirMenu = { labels: menuLabels(), title: document.querySelector('.dsh-fx-menu-title')?.textContent ?? null }

// 2c. 展开目录里的空白（落在 sub 的子 ul 上）→ 上传目标是 sub
const nestedUl = dirLi.querySelector('ul')
result.blankRightClick = rightClick(nestedUl, 200, 150)
await wait(200)
result.blankMenu = { labels: menuLabels(), title: document.querySelector('.dsh-fx-menu-title')?.textContent ?? null }

// 2d. 树外右键：不许接管（先按 Escape 收掉上一步的菜单，否则量到的是旧菜单）
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await wait(150)
result.menuClosedBefore = menuNode() === null
result.outsideRightClick = rightClick(document.getElementById('outside'), 100, 700)
await wait(150)
result.outsideMenuShown = menuNode() !== null
result.outsideDefaultPrevented = result.outsideRightClick.defaultPrevented

// 2e. Escape 关菜单
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
const beforeEscape = menuNode() !== null
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await wait(150)
result.escape = { opened: beforeEscape, closed: menuNode() === null }

// 2f. 点菜单外关菜单
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
document.getElementById('outside').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
await wait(150)
result.outsideClickClosed = menuNode() === null

// 2g. 视口夹取：往右下角右键，菜单不许溢出
rightClick(fileLi.firstElementChild, window.innerWidth - 4, window.innerHeight - 4)
await wait(250)
const clamped = menuNode()
result.clamp = clamped === null ? null : {
  box: rectOf(clamped),
  viewport: { width: window.innerWidth, height: window.innerHeight },
  url: null,
}
if (clamped !== null) {
  result.clamp.overflowRight = clamped.getBoundingClientRect().right > window.innerWidth
  result.clamp.overflowBottom = clamped.getBoundingClientRect().bottom > window.innerHeight
}
result.screenshots.menuClamped = true
await wait(50)

/* ================= 3. 动作 ================= */
// 3a. 复制路径
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
await clickMenuItem('复制路径')
result.copy = { clipboard: window.__clipboard.slice(), toast: toastText(), menuClosed: menuNode() === null }

// 3b. 下载
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
await clickMenuItem('下载')
result.download = {
  fetch: window.__fetchCalls.slice(),
  objectUrls: createdUrls.length,
  anchorClicks: window.__anchorClicks || 0,
  toast: toastText(),
}

// 3c. 下载失败要变成错误提示（host 回真正的错误状态）
window.__fetchMode = 'download-error'
await wait(2800)
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
await clickMenuItem('下载')
result.downloadError = { toast: toastText() }

// 3c2. 老「200 + {ok:false}」信封也要被 content-type 兜住，不能存成一段 JSON
window.__fetchMode = 'download-error-200'
await wait(2800)
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
await clickMenuItem('下载')
result.downloadError200 = { toast: toastText(), objectUrls: createdUrls.length }
window.__fetchMode = 'ok'

// 3d. 目录上传：选中文件 → change → POST → 重载树
await wait(2800)
window.__fetchCalls.length = 0
window.__reloadClicks = 0
rightClick(dirLi.firstElementChild, 120, 120)
await wait(150)
await clickMenuItem('上传文件到此处…')
const input = window.__pickedInputs[window.__pickedInputs.length - 1]
if (input === undefined) {
  result.upload = { error: '没有创建 input[type=file]' }
} else {
  const file = new File(['hello-upload'], 'note.txt', { type: 'text/plain' })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(600)
  result.upload = {
    inputType: input.type,
    inputMultiple: input.multiple,
    inputRemoved: input.isConnected === false,
    fetch: window.__fetchCalls.slice(),
    reloadClicks: window.__reloadClicks,
    toast: toastText(),
  }
}

/* ================= 4. 空白处上传的目标目录 ================= */
await wait(2800)
window.__pickedInputs.length = 0
const nestedUl2 = dirLi.querySelector('ul')
rightClick(nestedUl2, 200, 150)
await wait(150)
await clickMenuItem('上传文件到此处…')
result.blankUpload = { title: '（见 blankMenu.title）', picked: window.__pickedInputs.length }

// 根空白（body 的 padding 区域）
const bodyRect = body.getBoundingClientRect()
rightClick(body, 4, bodyRect.bottom - 2)
await wait(150)
result.rootBlankMenu = { labels: menuLabels(), title: document.querySelector('.dsh-fx-menu-title')?.textContent ?? null }

/* ================= 5. 窄栏：时间戳换行，树不许被撑出横向滚动条 ================= */
const panel = document.getElementById('panel')
const bodyEl = document.querySelector('[data-files-body]')
panel.style.width = '220px'
await wait(400)
const narrowRows = rows().map((li) => {
  const row = li.firstElementChild
  const name = row.querySelector('.fx-name')
  return {
    path: li.getAttribute('data-files-path'),
    rowHeight: rectOf(row).height,
    nameHeight: name === null ? null : rectOf(name).height,
    meta: row.getAttribute('data-fx-meta'),
    content: getComputedStyle(row, '::after').content,
    pseudoFlexBasis: getComputedStyle(row, '::after').flexBasis,
  }
})
result.narrow = {
  flag: root.hasAttribute('data-fx-narrow'),
  bodyOverflow: bodyEl.scrollWidth > bodyEl.clientWidth + 1,
  metrics: {
    bodyScrollWidth: bodyEl.scrollWidth,
    bodyClientWidth: bodyEl.clientWidth,
    bodyOffsetWidth: bodyEl.offsetWidth,
  },
  // 谁把 body 撑宽了：逐元素比对右边缘与 body 内容区右边缘。
  offenders: (() => {
    const limit = bodyEl.getBoundingClientRect().left + bodyEl.clientWidth
    const found = []
    for (const node of bodyEl.querySelectorAll('*')) {
      const box = node.getBoundingClientRect()
      if (box.right > limit + 1) {
        found.push({ tag: node.tagName, cls: node.getAttribute('class'), path: node.getAttribute('data-files-path'), right: Math.round(box.right), limit: Math.round(limit), width: Math.round(box.width), scrollWidth: node.scrollWidth })
      }
    }
    return found.slice(0, 6)
  })(),
  rows: narrowRows,
}
panel.style.width = '340px'
await wait(400)
result.wideAgain = { flag: root.hasAttribute('data-fx-narrow') }

/* ================= 6. 卸载还原 ================= */
result.finalErrors = window.__errors
return result
`

/* ------------------------------------------------------------------ CDP / 运行 */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 极简 CDP 客户端：一条 WebSocket 复用多条命令（截图需要）。 */
function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    let nextId = 1
    const pending = new Map()
    socket.onopen = () => resolve({
      send(method, params) {
        const id = nextId
        nextId += 1
        return new Promise((settle, fail) => {
          pending.set(id, { settle, fail })
          socket.send(JSON.stringify({ id, method, params }))
          setTimeout(() => {
            if (pending.delete(id)) fail(new Error(`CDP ${method} 超时`))
          }, 30000)
        })
      },
      close() { socket.close() },
    })
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) entry.fail(new Error(JSON.stringify(message.error)))
      else entry.settle(message.result)
    }
    socket.onerror = () => reject(new Error('CDP WebSocket 出错'))
  })
}

/** 起 headless 浏览器跑一次探针。 */
async function run() {
  mkdirSync(SCRATCH, { recursive: true })
  const pagePath = join(SCRATCH, 'file-extras-harness.html')
  writeFileSync(pagePath, buildHtml(), 'utf8')

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--hide-scrollbars=false', `--window-size=1280,800`,
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(SCRATCH, 'profile')}`,
    `file:///${pagePath.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore', windowsHide: true })

  try {
    let target = null
    let lastError = 'CDP 没有响应'
    for (let attempt = 0; attempt < 60 && target === null; attempt += 1) {
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json())
        target = list.find((item) => item.type === 'page' && String(item.url).includes('file-extras-harness')) ?? null
      } catch (cause) {
        lastError = String(cause?.message ?? cause)
      }
      if (target === null) await sleep(300)
    }
    if (target === null) return { error: `找不到页面 target：${lastError}` }

    const client = await connect(target.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')

    // target 在 about:blank 阶段就出现在 /json/list 里了：必须等文档真的解析完，
    // 否则 querySelector('[data-files-reload]') 拿到的是空白页的 null。
    let ready = false
    for (let attempt = 0; attempt < 60 && ready === false; attempt += 1) {
      const probe = await client.send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && document.querySelector('[data-files-state="tree"]') !== null`,
        returnByValue: true,
      })
      ready = probe?.result?.value === true
      if (ready === false) await sleep(150)
    }
    if (ready === false) return { error: `页面没有解析完：readyState/harness 未就绪` }

    const evaluation = await client.send('Runtime.evaluate', {
      expression: `(async () => { try { ${pageScript} } catch (cause) { return { error: String((cause && cause.stack) || cause) } } })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    const value = evaluation?.result?.value
    if (value === undefined) {
      const detail = evaluation?.exceptionDetails
      return { error: `探针没有返回值：${JSON.stringify(detail ?? evaluation).slice(0, 500)}` }
    }

    if (SHOT_DIR !== null) {
      mkdirSync(SHOT_DIR, { recursive: true })
      const shot = await client.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(SHOT_DIR, 'file-extras-light.png'), Buffer.from(shot.data, 'base64'))
      // 深色主题：换 token 后重开一次菜单，验证两套主题都读令牌而不是写死颜色。
      await client.send('Runtime.evaluate', {
        expression: `(async () => {
          document.documentElement.classList.add('dark')
          const li = [...document.querySelectorAll('[data-files-entry]')].find((n) => n.getAttribute('data-files-path').endsWith('alpha.txt'))
          li.firstElementChild.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }))
          await new Promise((d) => setTimeout(d, 300))
        })()`,
        awaitPromise: true,
        returnByValue: true,
      })
      const shotDark = await client.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(SHOT_DIR, 'file-extras-dark.png'), Buffer.from(shotDark.data, 'base64'))
      value.shots = ['file-extras-light.png', 'file-extras-dark.png']
    }
    client.close()
    return value
  } finally {
    child.kill()
  }
}

const result = await run()

/* ------------------------------------------------------------------ 断言 */

const lines = []
let failed = 0
const ok = (label, problem) => {
  if (problem === undefined) lines.push(`OK   ${label}`)
  else { failed += 1; lines.push(`FAIL ${label}: ${problem}`) }
}

if (result.error !== undefined) {
  ok('页面探针执行', result.error)
} else {
  if (result.errors?.length > 0) ok('页面没有 JS 异常', result.errors.join(' | '))
  else ok('页面没有 JS 异常')

  ok(`文件树里 ${result.rows.length} 行都被抓过一遍（mark=ok/none）`,
    result.rows.every((row) => row.meta !== null && row.meta.mark !== null)
      ? undefined
      : JSON.stringify(result.rows.map((row) => [row.path, row.meta?.mark])))

  ok('文件/目录行的大小与日期都对',
    result.metaMismatch.length === 0 ? undefined : JSON.stringify(result.metaMismatch))

  ok('other 与不存在的路径不显示元数据',
    result.shouldHaveNoMeta.every((item) => item.meta !== null && item.meta.attr === null && item.meta.mark === 'none')
      ? undefined
      : JSON.stringify(result.shouldHaveNoMeta))

  ok('CSS ::after 真的渲染出同一段文本（不是只写了属性）',
    result.pseudoMismatch.length === 0 ? undefined : JSON.stringify(result.pseudoMismatch))

  const withMeta = result.rows.filter((row) => row.meta?.attr !== null)
  const overflow = withMeta.filter((row) => row.nameWidth !== null && row.rowWidth !== null && row.nameWidth > row.rowWidth)
  ok('名字让位给元数据：名字宽度不超过行宽', overflow.length === 0 ? undefined : JSON.stringify(overflow.map((row) => [row.path, row.nameWidth, row.rowWidth])))
  const longName = withMeta.find((row) => row.path.endsWith('a-very-long-file-name-to-force-ellipsis.txt'))
  ok('超长名字被压缩而元数据仍在（省略号截断生效）',
    longName === undefined ? '没找到长名字那一行' : (longName.nameWidth < longName.rowWidth ? undefined : `名字宽 ${longName.nameWidth} / 行宽 ${longName.rowWidth}`))

  ok('文件右键：浏览器默认菜单被接管', result.fileRightClick.defaultPrevented === true ? undefined : JSON.stringify(result.fileRightClick))
  ok('文件右键菜单项 = 下载 / 复制路径',
    JSON.stringify(result.fileMenu.labels) === JSON.stringify(['下载', '复制路径']) ? undefined : JSON.stringify(result.fileMenu.labels))
  ok('文件右键菜单标题 = 文件名', result.fileMenu.title === 'alpha.txt' ? undefined : JSON.stringify(result.fileMenu.title))
  ok('目录右键菜单项 = 上传文件到此处… / 复制路径',
    JSON.stringify(result.dirMenu.labels) === JSON.stringify(['上传文件到此处…', '复制路径']) ? undefined : JSON.stringify(result.dirMenu.labels))
  ok('空白右键菜单项含上传 + 复制路径 + 刷新',
    JSON.stringify(result.blankMenu.labels) === JSON.stringify(['上传文件到此处…', '复制路径', '刷新大小与日期']) ? undefined : JSON.stringify(result.blankMenu.labels))
  ok('展开目录内的空白归属该目录（标题 = sub）', result.blankMenu.title === 'sub' ? undefined : JSON.stringify(result.blankMenu.title))
  ok('树外右键不接管（默认菜单保留、不弹自己的菜单）',
    result.outsideRightClick.defaultPrevented === false && result.outsideMenuShown === false
      ? undefined
      : JSON.stringify({ prevented: result.outsideRightClick.defaultPrevented, shown: result.outsideMenuShown }))
  ok('Escape 关菜单', result.escape.opened === true && result.escape.closed === true ? undefined : JSON.stringify(result.escape))
  ok('点菜单外关菜单', result.outsideClickClosed === true ? undefined : String(result.outsideClickClosed))
  ok('菜单位置夹回视口（右下角右键不溢出）',
    result.clamp !== null && result.clamp.overflowRight === false && result.clamp.overflowBottom === false
      ? undefined
      : JSON.stringify(result.clamp))
  ok('复制路径写进剪贴板并弹提示',
    result.copy.clipboard.length === 1 && result.copy.clipboard[0] === `${FIXTURE_ROOT}\\alpha.txt` && result.copy.toast === '已复制路径'
      ? undefined
      : JSON.stringify(result.copy))
  ok('点菜单项后菜单自己关掉', result.copy.menuClosed === true ? undefined : String(result.copy.menuClosed))

  const downloadCall = result.download.fetch.find((item) => item.url.includes('/download'))
  const wantDownloadUrl = `/dsh-file-extras/download?root=${encodeURIComponent(FIXTURE_ROOT)}&path=${encodeURIComponent(`${FIXTURE_ROOT}\\alpha.txt`)}`
  ok('下载走自建通道且 URL 正确',
    downloadCall !== undefined && downloadCall.url === wantDownloadUrl && downloadCall.method === 'GET'
      ? undefined
      : JSON.stringify({ got: downloadCall?.url, want: wantDownloadUrl }))
  ok('下载落盘（建了 object URL 并点了锚点）',
    result.download.objectUrls === 1 && result.download.anchorClicks === 1 ? undefined : JSON.stringify(result.download))
  ok('下载成功弹提示', result.download.toast === '已开始下载 alpha.txt' ? undefined : JSON.stringify(result.download.toast))
  ok('下载失败变成错误提示（非 200，不静默）',
    typeof result.downloadError.toast === 'string' && result.downloadError.toast.includes('超过下载上限')
      ? undefined
      : JSON.stringify(result.downloadError))
  ok('「200 + {ok:false}」也被 content-type 兜住（不会把错误 JSON 存成文件）',
    typeof result.downloadError200.toast === 'string' && result.downloadError200.toast.includes('超过下载上限')
      ? undefined
      : JSON.stringify(result.downloadError200))

  if (result.upload?.error !== undefined) {
    ok('目录上传', result.upload.error)
  } else {
    const uploadCall = result.upload.fetch.find((item) => item.url.includes('/upload'))
    const wantPrefix = `/dsh-file-extras/upload?root=${encodeURIComponent(FIXTURE_ROOT)}&dir=${encodeURIComponent(`${FIXTURE_ROOT}\\sub`)}&name=note.txt`
    ok('上传：创建了多选文件输入框并即时移除',
      result.upload.inputType === 'file' && result.upload.inputMultiple === true && result.upload.inputRemoved === true
        ? undefined
        : JSON.stringify(result.upload))
    ok('上传 POST 到自建通道、目标目录与文件名正确',
      uploadCall !== undefined && uploadCall.method === 'POST' && uploadCall.hasBody === true && uploadCall.url === wantPrefix
        ? undefined
        : JSON.stringify({ got: uploadCall?.url, want: wantPrefix }))
    ok('上传后点了官方刷新按钮重载这棵树',
      result.upload.reloadClicks === 1 ? undefined : `点击次数=${result.upload.reloadClicks}`)
    ok('上传完成弹提示',
      typeof result.upload.toast === 'string' && result.upload.toast.includes('已上传 1 个文件')
        ? undefined
        : JSON.stringify(result.upload.toast))
  }

  ok('空白处上传也打开了文件选择器', result.blankUpload.picked === 1 ? undefined : JSON.stringify(result.blankUpload))
  ok('工作区根空白同样给出菜单',
    result.rootBlankMenu.labels.length === 3 ? undefined : JSON.stringify(result.rootBlankMenu))

  const narrowRowsWithMeta = result.narrow.rows.filter((row) => row.meta !== null)
  ok('窄到 220px 时自动切到「元数据换行」模式',
    result.narrow.flag === true ? undefined : JSON.stringify(result.narrow))
  ok('窄栏里树不再横向溢出',
    result.narrow.bodyOverflow === false ? undefined : JSON.stringify({ metrics: result.narrow.metrics, offenders: result.narrow.offenders }))
  ok('窄栏里时间戳独占一行且完整（未被截断）',
    narrowRowsWithMeta.length > 0
      && narrowRowsWithMeta.every((row) => row.pseudoFlexBasis === '100%' && String(row.content).includes(':'))
      ? undefined
      : JSON.stringify(narrowRowsWithMeta.map((row) => [row.path, row.pseudoFlexBasis, row.content])))
  ok('窄栏里行确实变高了（换行真的发生，不是只是加了属性）',
    narrowRowsWithMeta.length > 0 && narrowRowsWithMeta.every((row) => row.rowHeight > row.nameHeight + 4)
      ? undefined
      : JSON.stringify(narrowRowsWithMeta.map((row) => [row.path, row.rowHeight, row.nameHeight])))
  ok('拖宽后自动切回单行模式',
    result.wideAgain.flag === false ? undefined : JSON.stringify(result.wideAgain))
}

console.log(lines.join('\n'))
if (result.calls !== undefined && DEBUG) {
  console.log('\nRPC 调用：')
  for (const call of result.calls) console.log(`  ${call.endpoint} paths=${call.payload?.paths?.length}`)
}
if (result.shots !== undefined) console.log(`\n截图：${result.shots.join('、')}`)
if (result.error === undefined && failed === 0) console.log('\n全部通过')
process.exit(failed === 0 ? 0 : 1)
