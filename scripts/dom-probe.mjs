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
<div id="control-root" style="position:fixed;right:8px;top:8px"></div>
<input type="checkbox" id="plain-box" style="position:fixed;right:8px;top:40px">
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
window.__anchors = []
window.__clipboard = []
window.__rowClicks = 0
window.__removed = []
/** 'ok' | 'missing'：让预检（stat）失败，验证「预检不过就不发起下载」。 */
window.__statMode = 'ok'

// 行上的「官方行为」计数：Ctrl/Shift 单击必须把它拦下来，普通单击必须放行。
document.querySelector('[data-files-body]').addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('[data-files-entry]') !== null) window.__rowClicks += 1
})

const callChannel = async (channel, endpoint, payload) => {
  window.__calls.push({ channel, endpoint, payload })
  if (endpoint === 'remove') {
    const permanent = payload.permanent === true
    window.__removed.push({ paths: payload.paths.slice(), permanent })
    return {
      ok: true,
      value: {
        removed: payload.paths.length,
        mode: permanent ? 'permanent' : 'trash',
        results: payload.paths.map((path) => ({ path, ok: true, type: 'file', mode: permanent ? 'permanent' : 'trash' })),
      },
    }
  }
  if (endpoint !== 'stat') return { ok: false, error: { code: 'x/unknown', message: '未知端点', details: {} } }
  const entries = payload.paths.map((path) => {
    if (window.__statMode === 'missing' && String(path).endsWith('alpha.txt')) return { path, error: 'missing' }
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

/* —— 对照组：一个最朴素的 React 受控复选框。用来区分「程序化 click 不触发 React onChange」
      和「我们的组件写错了」—— 前者是测试环境问题，后者是插件问题。 —— */
window.__control = { changes: 0 }
function ControlBox() {
  const [on, setOn] = React.useState(false)
  return React.createElement('input', {
    type: 'checkbox',
    id: 'control-box',
    checked: on,
    onChange: (event) => { window.__control.changes += 1; setOn(event.target.checked) },
  })
}
ReactDOM.createRoot(document.getElementById('control-root')).render(React.createElement(ControlBox))
await wait(150)

/* —— 桩：剪贴板 / fetch / 锚点 / 文件选择器 —— */
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text) => { window.__clipboard.push(text) } },
})
window.fetch = async (url, init) => {
  window.__fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET', hasBody: Boolean(init && init.body) })
  // 上传故意慢一点：好在传输途中采到「正在上传 …」那条不自动消失的进度提示。
  if (String(url).includes('/upload')) await new Promise((done) => setTimeout(done, 120))
  return new Response(JSON.stringify({ ok: true, value: { path: 'x', name: 'y', size: 1, renamed: false } }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const createdUrls = []
const realCreate = URL.createObjectURL.bind(URL)
URL.createObjectURL = (blob) => { const url = realCreate(blob); createdUrls.push(url); return url }
window.__createdUrls = createdUrls
// 锚点点击就是「原生下载」的触发点：记下 href/download，别真的发起导航。
HTMLAnchorElement.prototype.click = function stubClick() {
  window.__anchors.push({ href: this.getAttribute('href'), download: this.getAttribute('download'), connected: this.isConnected })
}
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
/** 造一个带修饰键的单击，和用户按键时走的是同一条路径。 */
const rowClick = (node, modifiers) => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...modifiers })
  const notCancelled = node.dispatchEvent(event)
  return { defaultPrevented: event.defaultPrevented, reachedOfficial: notCancelled }
}
const selectedPaths = () => [...document.querySelectorAll('[data-fx-selected]')]
  .map((row) => row.closest('[data-files-entry]')?.getAttribute('data-files-path'))
  .filter((path) => typeof path === 'string')
const dialogNode = () => document.querySelector('.dsh-fx-dialog')
const dialogText = () => (dialogNode() === null ? null : dialogNode().textContent)
const dialogItems = () => [...document.querySelectorAll('.dsh-fx-dialog-item')].map((node) => (node.textContent || ''))
const clickDialogButton = async (label) => {
  const node = [...document.querySelectorAll('.dsh-fx-btn')].find((item) => (item.textContent || '').trim() === label)
  if (node === undefined) return false
  node.click()
  await wait(300)
  return true
}
const escape = async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(150)
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

/**
 * 请 Node 侧用 CDP 发一个**真实**鼠标点击。
 *
 * 为什么不能自己合成事件：这套 headless Chrome 里 HTMLElement.click() 不执行 checkbox 的
 * 激活行为（页面上一个纯 HTML 的 input[type=checkbox] 点下去都不翻转），
 * 而自己改 input.checked 又会踩 React 的 value tracker —— 它给受控 input 在实例上重定义了
 * setter，直接赋值连"旧值"一起改掉，React 认为没变化，onChange 不触发。
 * CDP 的 Input.dispatchMouseEvent 产生的是 trusted 事件，走的是浏览器真正的激活路径，
 * 既不用碰 React 内部，也不用改产品代码去迁就测试。
 */
const trustedClick = async (node) => {
  const box = node.getBoundingClientRect()
  window.__wantClick = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (window.__clicked === true) {
      window.__clicked = false
      window.__wantClick = null
      return true
    }
    await wait(25)
  }
  window.__wantClick = null
  return false
}

const result = { errors: window.__errors, calls: window.__calls, screenshots: {} }

const control = document.getElementById('control-box')
const rawBox = document.getElementById('plain-box')
// 对照组：真实鼠标点击必须能翻转一个纯 HTML checkbox —— 证明握手链路本身是通的。
// 必须放在**任何确认框打开之前**：遮罩是 position:fixed;inset:0，开着的时候点到哪儿都是遮罩。
await trustedClick(rawBox)
result.trustedClickWorks = rawBox.checked
rawBox.checked = false
// 受控复选框同样应该被真实点击驱动
await trustedClick(control)
result.controlBox = { after: control.checked, changes: window.__control.changes }
await trustedClick(control)
await wait(120)

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

/* ================= 3. 多选：Ctrl 切换 / Shift 区间 / 官方行为必须被拦下 ================= */
const subLi = rowFor('D:\\\\fixture\\\\sub')
const aTxtLi = rowFor('D:\\\\fixture\\\\sub\\\\a.txt')
const bigLi = rowFor('D:\\\\fixture\\\\big.bin')
window.__rowClicks = 0

// 普通单击：放行官方行为（打开文件），并清空选择
rightClick(bigLi.firstElementChild, 120, 300)
await wait(150)
await clickMenuItem('复制路径') // 顺手关掉菜单
await wait(150)
const plain = rowClick(bigLi.firstElementChild, {})
await wait(120)
result.plainClick = { reachedOfficial: plain.reachedOfficial, rowClicks: window.__rowClicks, selected: selectedPaths() }

// Ctrl 单击：切换选择，官方行为必须被拦下
window.__rowClicks = 0
const ctrl1 = rowClick(fileLi.firstElementChild, { ctrlKey: true })
await wait(120)
const ctrl2 = rowClick(bigLi.firstElementChild, { ctrlKey: true })
await wait(120)
const ctrl3 = rowClick(bigLi.firstElementChild, { ctrlKey: true })
await wait(120)
result.ctrlClick = {
  prevented: [ctrl1.defaultPrevented, ctrl2.defaultPrevented, ctrl3.defaultPrevented],
  reachedOfficial: [ctrl1.reachedOfficial, ctrl2.reachedOfficial, ctrl3.reachedOfficial],
  rowClicks: window.__rowClicks,
  selected: selectedPaths(),
}

// 选中态真的画出来了（CSS 生效，不只是加了属性）
const selectedBox = getComputedStyle(fileLi.firstElementChild).backgroundColor
const plainBox = getComputedStyle(aTxtLi.firstElementChild).backgroundColor
result.selectionPaint = { selected: selectedBox, plain: plainBox, attr: fileLi.firstElementChild.hasAttribute('data-fx-selected') }

// Shift 单击：从锚点到这一行整段选中（锚点 = 最后一次单击的 alpha.txt，但上面点了 big.bin，
// 所以锚点已经是 big.bin；这里先把锚点设回 sub，再 Shift 点到 a.txt）
rowClick(dirLi.firstElementChild, {})
await wait(120)
const shift = rowClick(aTxtLi.firstElementChild, { shiftKey: true })
await wait(120)
result.shiftClick = { prevented: shift.defaultPrevented, reachedOfficial: shift.reachedOfficial, rowClicks: window.__rowClicks, selected: selectedPaths() }

// 右键落在已选中的行上 → 作用整个选择
window.__rowClicks = 0
rightClick(aTxtLi.firstElementChild, 120, 160)
await wait(200)
result.multiMenu = {
  labels: menuLabels().filter((label) => label !== ''),
  title: document.querySelector('.dsh-fx-menu-title')?.textContent ?? null,
  separators: document.querySelectorAll('.dsh-fx-menu-sep').length,
  selected: selectedPaths(),
}
// Esc 先收菜单，再收选择
await escape()
const afterMenuEscape = { menu: menuNode() === null, selected: selectedPaths().length }
await escape()
result.escapeLayers = { afterMenuEscape, afterSecond: { menu: menuNode() === null, selected: selectedPaths().length } }

// 右键落在**没选中**的行上 → 选择换成这一行
rowClick(fileLi.firstElementChild, { ctrlKey: true })
await wait(120)
const beforeSingle = selectedPaths()
rightClick(bigLi.firstElementChild, 120, 300)
await wait(200)
result.singleMenu = { before: beforeSingle, labels: menuLabels().filter((label) => label !== ''), selected: selectedPaths() }
await escape()

/* ================= 4. 删除：二次确认 ================= */
window.__removed.length = 0
window.__reloadClicks = 0
// 选两项再删（先清干净，别让上一段遗留的选择把 ctrl 单击变成「切出」）
await escape()
await escape()
rowClick(fileLi.firstElementChild, { ctrlKey: true })
await wait(100)
rowClick(bigLi.firstElementChild, { ctrlKey: true })
await wait(120)
result.deleteSelection = selectedPaths()
rightClick(bigLi.firstElementChild, 120, 300)
await wait(200)
result.deleteMenu = { labels: menuLabels().filter((label) => label !== ''), selected: selectedPaths() }
await clickMenuItem('删除 2 项')
const checkBox = () => document.querySelector('.dsh-fx-check input')
const dialogButtons = () => [...document.querySelectorAll('.dsh-fx-btn')].map((node) => (node.textContent || '').trim())
const dialogMessage = () => document.querySelector('.dsh-fx-dialog-message')?.textContent ?? null
result.confirmShown = {
  dialog: dialogNode() !== null,
  title: document.querySelector('.dsh-fx-dialog-title')?.textContent ?? null,
  message: dialogMessage(),
  items: dialogItems(),
  buttons: dialogButtons(),
  focus: document.activeElement === null ? null : (document.activeElement.textContent || '').trim(),
  removedCalls: window.__removed.length,
  selected: selectedPaths(),
  checkboxPresent: checkBox() !== null,
  checkboxChecked: checkBox() === null ? null : checkBox().checked,
}



/** 勾上「永久删除」：文案与按钮都要跟着变（必须在点取消**之前**量）。 */
const armedBox = checkBox()
if (armedBox !== null) await trustedClick(armedBox)
await wait(180)
result.permanentArmed = {
  checked: checkBox() === null ? null : checkBox().checked,
  message: dialogMessage(),
  buttons: dialogButtons(),
}
// 再取消勾选，回到默认那一档
if (checkBox() !== null) await trustedClick(checkBox())
await wait(180)
result.permanentDisarmed = {
  checked: checkBox() === null ? null : checkBox().checked,
  message: dialogMessage(),
  buttons: dialogButtons(),
}

// 取消：什么都不删
await clickDialogButton('取消')
result.cancelDelete = {
  dialog: dialogNode() !== null,
  removedCalls: window.__removed.length,
  selected: selectedPaths(),
}

// 再来一次，这次确认（默认走回收站）
await escape()
await escape()
rowClick(fileLi.firstElementChild, { ctrlKey: true })
await wait(100)
rowClick(bigLi.firstElementChild, { ctrlKey: true })
await wait(120)
rightClick(bigLi.firstElementChild, 120, 300)
await wait(200)
await clickMenuItem('删除 2 项')
await clickDialogButton('移到回收站 2 项')
await wait(400)
result.confirmDelete = {
  removedCalls: window.__removed.map((item) => item.paths),
  permanentFlags: window.__removed.map((item) => item.permanent),
  dialog: dialogNode() !== null,
  selected: selectedPaths(),
  reloadClicks: window.__reloadClicks,
  toast: toastText(),
}

// 走一遍「永久删除」那条路：请求里必须带 permanent: true
await escape()
await escape()
rowClick(fileLi.firstElementChild, { ctrlKey: true })
await wait(120)
rightClick(fileLi.firstElementChild, 120, 200)
await wait(200)
await clickMenuItem('删除')
await wait(150)
if (checkBox() !== null) await trustedClick(checkBox())
await wait(180)
await clickDialogButton('永久删除')
await wait(400)
result.confirmPermanent = {
  permanentFlags: window.__removed.map((item) => item.permanent),
  toast: toastText(),
}

// 文件夹删除：确认框要写明「含全部内容 + 第一级 N 项」
await wait(2900)
rightClick(dirLi.firstElementChild, 120, 120)
await wait(200)
await clickMenuItem('删除')
result.dirConfirm = { items: dialogItems(), message: document.querySelector('.dsh-fx-dialog-message')?.textContent ?? null }
await clickDialogButton('移到回收站')
await wait(400)
result.dirDelete = { removedCalls: window.__removed.map((item) => item.paths), toast: toastText() }

// Esc 收确认框（第一层）
await wait(2900)
rightClick(dirLi.firstElementChild, 120, 120)
await wait(200)
await clickMenuItem('删除')
await escape()
result.escapeDialog = { dialog: dialogNode() !== null, removedCalls: window.__removed.length }
await escape()

// 空白处：有选择时菜单里要能看到删除与清除
await wait(2900)
rowClick(fileLi.firstElementChild, { ctrlKey: true })
await wait(120)
rightClick(body, 4, body.getBoundingClientRect().bottom - 2)
await wait(200)
result.blankMenuWithSelection = { labels: menuLabels().filter((label) => label !== ''), selected: selectedPaths() }
result.selectAll = await (async () => {
  await clickMenuItem('全选可见项')
  await wait(200)
  return selectedPaths().length
})()
await wait(120)

/* ================= 5. 动作 ================= */
// 先收干净：确认框 → 菜单 → 选择（前一段的「全选可见项」会改掉后面每条菜单的文案）
await escape()
await escape()
await escape()
window.__clipboard.length = 0

// 5a. 复制路径
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
await clickMenuItem('复制路径')
result.copy = { clipboard: window.__clipboard.slice(), toast: toastText(), menuClosed: menuNode() === null }

// 5b. 下载：预检（stat RPC）通过后交给浏览器原生下载
window.__anchors.length = 0
window.__fetchCalls.length = 0
window.__calls.length = 0
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
await clickMenuItem('下载')
result.download = {
  calls: window.__calls.map((call) => ({ endpoint: call.endpoint, paths: call.payload?.paths })),
  anchors: window.__anchors.slice(),
  fetchCount: window.__fetchCalls.length,
  objectUrls: createdUrls.length,
  toast: toastText(),
}

// 5c. 预检失败 → 必须给出具体原因，且一次下载都不许发起
window.__statMode = 'missing'
await wait(2800)
window.__anchors.length = 0
window.__fetchCalls.length = 0
rightClick(fileLi.firstElementChild, 120, 200)
await wait(150)
await clickMenuItem('下载')
result.downloadMissing = { anchors: window.__anchors.length, fetchCount: window.__fetchCalls.length, toast: toastText() }
window.__statMode = 'ok'
await wait(2900)

// 5d. 目录上传：选中文件 → change → POST → 重载树
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
  await wait(40)
  const during = toastText()
  await wait(600)
  result.upload = {
    inputType: input.type,
    inputMultiple: input.multiple,
    inputRemoved: input.isConnected === false,
    fetch: window.__fetchCalls.slice(),
    reloadClicks: window.__reloadClicks,
    progressToast: during,
    toast: toastText(),
  }
}

/* ================= 6. 空白处上传的目标目录 ================= */
await wait(2800)
window.__pickedInputs.length = 0
const nestedUl2 = dirLi.querySelector('ul')
rightClick(nestedUl2, 200, 150)
await wait(150)
await clickMenuItem('上传文件到此处…')
result.blankUpload = { title: '（见 blankMenu.title）', picked: window.__pickedInputs.length }

// 根空白（body 的 padding 区域）：先清掉选择，量的是「无选择」形态的菜单
await escape()
await escape()
const bodyRect = body.getBoundingClientRect()
rightClick(body, 4, bodyRect.bottom - 2)
await wait(150)
result.rootBlankMenu = { labels: menuLabels().filter((label) => label !== ''), title: document.querySelector('.dsh-fx-menu-title')?.textContent ?? null }
await escape()

/* ================= 7. 窄栏：时间戳换行，树不许被撑出横向滚动条 ================= */
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

/* ================= 8. 卸载还原 ================= */
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
          }, 180000)
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

    const evaluation = client.send('Runtime.evaluate', {
      expression: `(async () => { try { ${pageScript} } catch (cause) { return { error: String((cause && cause.stack) || cause) } } })()`,
      awaitPromise: true,
      returnByValue: true,
    })

    // 页面探针跑的同时，替它服务「请发一个真实鼠标点击」的握手：
    // 页面摆好坐标 → 这里用 Input.dispatchMouseEvent 点下去（trusted 事件）→ 页面继续。
    // 这是唯一能真正驱动 checkbox 激活行为的方式，见页面里 trustedClick 的注释。
    let settled = false
    let servedClicks = 0
    evaluation.then(() => { settled = true }, () => { settled = true })
    while (settled === false) {
      const wanted = await client
        .send('Runtime.evaluate', { expression: 'window.__wantClick ?? null', returnByValue: true })
        .catch(() => null)
      const point = wanted?.result?.value
      if (point !== null && point !== undefined && typeof point.x === 'number') {
        const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base })
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
        servedClicks += 1
        // 清请求与置回执放在同一次求值里：分两步的话，下一次轮询会读到还没被页面清掉的
        // 同一个请求，于是同一个位置被点两次（复选框等于没点）。
        await client.send('Runtime.evaluate', {
          expression: 'window.__wantClick = null; window.__clicked = true',
          returnByValue: true,
        })
      } else {
        await sleep(40)
      }
    }
    if (DEBUG) console.log(`握手服务了 ${servedClicks} 次真实鼠标点击`)

    const evaluationResult = await evaluation
    const value = evaluationResult?.result?.value
    if (value === undefined) {
      const detail = evaluationResult?.exceptionDetails
      return { error: `探针没有返回值：${JSON.stringify(detail ?? evaluationResult).slice(0, 500)}` }
    }

    if (SHOT_DIR !== null) {
      mkdirSync(SHOT_DIR, { recursive: true })
      // 截图是在主探针跑完之后补拍的：这里用和用户完全一样的路径（Ctrl 单击 + 右键）把状态摆出来，
      // 而不是直接去写插件内部属性。
      const setup = (dark, openDialog) => `(async () => {
        const wait = (ms) => new Promise((d) => setTimeout(d, ms))
        document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')
        document.body.click()
        await wait(80)
        const rows = [...document.querySelectorAll('[data-files-entry]')]
        const byPath = (suffix) => rows.find((li) => (li.getAttribute('data-files-path') || '').endsWith(suffix))
        const click = (li, modifiers) => li.firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...modifiers }))
        click(byPath('sub'), {})
        await wait(60)
        click(byPath('sub\\\\a.txt'), { shiftKey: true })
        await wait(60)
        click(byPath('big.bin'), { ctrlKey: true })
        await wait(120)
        const target = byPath('big.bin').firstElementChild
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 260 }))
        await wait(250)
        ${openDialog ? `const item = [...document.querySelectorAll('.dsh-fx-menu-item')].find((node) => (node.textContent || '').includes('删除'))
        if (item !== undefined) { item.click(); await wait(300) }` : ''}
      })()`

      const shot = async (name, dark, openDialog) => {
        await client.send('Runtime.evaluate', { expression: setup(dark, openDialog), awaitPromise: true, returnByValue: true })
        const image = await client.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(SHOT_DIR, name), Buffer.from(image.data, 'base64'))
      }
      await shot('file-extras-light.png', false, false)
      await shot('file-extras-dark.png', true, true)
      value.shots = ['file-extras-light.png', 'file-extras-dark.png']
    }
    client.close()
    return value
  } finally {
    child.kill()
  }
}

const result = await run()

// 完整结果落盘：断言消息只留摘要，要追细节时看这个文件。
mkdirSync(SCRATCH, { recursive: true })
const reportPath = join(SCRATCH, 'last-result.json')
try {
  writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8')
} catch (cause) {
  console.log(`（结果落盘失败：${String(cause?.message ?? cause)}）`)
}

/* ------------------------------------------------------------------ 断言 */

const lines = []
let failed = 0
/** 失败详情只留一小段：整页 HTML / 整段样式表混进断言消息时，控制台会没法看。 */
const brief = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const oneLine = String(text ?? '').replace(/\s+/g, ' ')
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine
}
const ok = (label, problem) => {
  if (problem === undefined) lines.push(`OK   ${label}`)
  else { failed += 1; lines.push(`FAIL ${label}: ${brief(problem)}`) }
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
  ok('文件右键菜单项 = 下载 / 复制路径 / 删除',
    JSON.stringify(result.fileMenu.labels) === JSON.stringify(['下载', '复制路径', '删除']) ? undefined : JSON.stringify(result.fileMenu.labels))
  ok('文件右键菜单标题 = 文件名', result.fileMenu.title === 'alpha.txt' ? undefined : JSON.stringify(result.fileMenu.title))
  ok('目录右键菜单项 = 上传文件到此处… / 复制路径 / 删除',
    JSON.stringify(result.dirMenu.labels) === JSON.stringify(['上传文件到此处…', '复制路径', '删除']) ? undefined : JSON.stringify(result.dirMenu.labels))
  // 上一步右键过目录行，那一行因此被选中 —— 空白菜单于是带上选择相关的两项。
  ok('空白右键菜单项 = 上传 / 复制路径 / 刷新 / 全选，且有选择时追加清除与删除',
    JSON.stringify(result.blankMenu.labels) === JSON.stringify([
      '上传文件到此处…', '复制路径', '刷新大小与日期', '全选可见项', '清除选择（1 项）', '删除',
    ])
      ? undefined
      : JSON.stringify(result.blankMenu.labels))
  ok('展开目录内的空白归属该目录（标题 = sub）', result.blankMenu.title === 'sub' ? undefined : JSON.stringify(result.blankMenu.title))
  ok('树外右键不接管（默认菜单保留、不弹自己的菜单）',
    result.outsideRightClick.defaultPrevented === false && result.outsideMenuShown === false
      ? undefined
      : JSON.stringify({ prevented: result.outsideRightClick.defaultPrevented, shown: result.outsideMenuShown }))
  ok('Escape 关菜单', result.escape.opened === true && result.escape.closed === true ? undefined : JSON.stringify(result.escape))

  /* ---- 多选 ---- */
  ok('普通单击放行官方行为（打开文件）并清空选择',
    result.plainClick.reachedOfficial === true && result.plainClick.rowClicks === 1 && result.plainClick.selected.length === 0
      ? undefined
      : JSON.stringify(result.plainClick))
  ok('Ctrl 单击：拦下官方行为，切入选、切出选',
    result.ctrlClick.prevented.every((value) => value === true)
      && result.ctrlClick.reachedOfficial.every((value) => value === false)
      && result.ctrlClick.rowClicks === 0
      && JSON.stringify(result.ctrlClick.selected) === JSON.stringify([`${FIXTURE_ROOT}\\alpha.txt`])
      ? undefined
      : JSON.stringify(result.ctrlClick))
  ok('选中态真的画出来了（与未选中行背景不同，不是只加了属性）',
    result.selectionPaint.attr === true && result.selectionPaint.selected !== result.selectionPaint.plain
      ? undefined
      : JSON.stringify(result.selectionPaint))
  ok('Shift 单击：从锚点行整段选中，且官方行为同样被拦下',
    result.shiftClick.prevented === true && result.shiftClick.reachedOfficial === false
      && JSON.stringify(result.shiftClick.selected) === JSON.stringify([`${FIXTURE_ROOT}\\sub`, `${FIXTURE_ROOT}\\sub\\a.txt`])
      ? undefined
      : JSON.stringify(result.shiftClick))
  ok('右键已选中的行：菜单作用整个选择（标题=已选 N 项、复制带数量、免掉单文件的下载/上传）',
    result.multiMenu.title === '已选 2 项'
      && JSON.stringify(result.multiMenu.labels) === JSON.stringify(['复制 2 个路径', '删除 2 项'])
      && result.multiMenu.separators === 1
      ? undefined
      : JSON.stringify(result.multiMenu))
  ok('右键没选中的行：选择换成这一行，菜单回到单项形态',
    result.singleMenu.before.length === 1 && result.singleMenu.selected.length === 1
      && JSON.stringify(result.singleMenu.labels) === JSON.stringify(['下载', '复制路径', '删除'])
      ? undefined
      : JSON.stringify(result.singleMenu))
  ok('Esc 分层收：先收菜单（选择还在），再收选择',
    result.escapeLayers.afterMenuEscape.menu === true && result.escapeLayers.afterMenuEscape.selected === 2
      && result.escapeLayers.afterSecond.menu === true && result.escapeLayers.afterSecond.selected === 0
      ? undefined
      : JSON.stringify(result.escapeLayers))

  /* ---- 删除 ---- */
  ok('多选后删除项写明数量', JSON.stringify(result.deleteMenu.labels) === JSON.stringify(['复制 2 个路径', '删除 2 项'])
    ? undefined : JSON.stringify(result.deleteMenu.labels))
  ok('删除先弹二次确认，且此刻一次 remove 都没发',
    result.confirmShown.dialog === true && result.confirmShown.removedCalls === 0
      && result.confirmShown.title === '删除确认'
      && typeof result.confirmShown.message === 'string' && result.confirmShown.message.includes('移到回收站')
      && result.confirmShown.message.includes('还原')
      ? undefined
      : JSON.stringify(result.confirmShown))
  ok('确认框逐项列出名称与「文件 + 大小」',
    result.confirmShown.items.length === 2
      && result.confirmShown.items[0].includes('alpha.txt') && result.confirmShown.items[0].includes('1.2 KB')
      && result.confirmShown.items[1].includes('big.bin') && result.confirmShown.items[1].includes('5.0 MB')
      ? undefined
      : JSON.stringify(result.confirmShown.items))
  ok('确认框按钮 = 取消 / 移到回收站 N 项，且焦点默认在取消（回车不会顺手确认）',
    JSON.stringify(result.confirmShown.buttons) === JSON.stringify(['取消', '移到回收站 2 项']) && result.confirmShown.focus === '取消'
      ? undefined
      : JSON.stringify({ buttons: result.confirmShown.buttons, focus: result.confirmShown.focus }))
  ok('点取消：不删任何东西，选择保留',
    result.cancelDelete.dialog === false && result.cancelDelete.removedCalls === 0
      && result.cancelDelete.selected.length === 2
      ? undefined
      : JSON.stringify(result.cancelDelete))
  ok('勾上「永久删除」后：文案转成不可恢复、按钮换成永久删除',
    result.confirmShown.checkboxPresent === true && result.confirmShown.checkboxChecked === false
      && result.permanentArmed.checked === true
      && typeof result.permanentArmed.message === 'string'
      && result.permanentArmed.message.includes('永久删除') && result.permanentArmed.message.includes('无法从回收站恢复')
      && JSON.stringify(result.permanentArmed.buttons) === JSON.stringify(['取消', '永久删除 2 项'])
      ? undefined
      : JSON.stringify({ shown: result.confirmShown, armed: result.permanentArmed }))
  ok('取消勾选后回到「移到回收站」（默认不勾，危险那一档要用户自己点）',
    result.permanentDisarmed.checked === false
      && typeof result.permanentDisarmed.message === 'string' && result.permanentDisarmed.message.includes('可从回收站还原')
      && JSON.stringify(result.permanentDisarmed.buttons) === JSON.stringify(['取消', '移到回收站 2 项'])
      ? undefined
      : JSON.stringify(result.permanentDisarmed))
  ok('点确认：按选择一次 RPC 删掉两项，且没带 permanent',
    JSON.stringify(result.confirmDelete.removedCalls) === JSON.stringify([[`${FIXTURE_ROOT}\\alpha.txt`, `${FIXTURE_ROOT}\\big.bin`]])
      && JSON.stringify(result.confirmDelete.permanentFlags) === JSON.stringify([false])
      ? undefined
      : JSON.stringify({ calls: result.confirmDelete.removedCalls, flags: result.confirmDelete.permanentFlags }))
  ok('删除后：确认框关闭、选择清空、重载这棵树、弹出结果（回收站口径）',
    result.confirmDelete.dialog === false && result.confirmDelete.selected.length === 0
      && result.confirmDelete.reloadClicks === 1 && result.confirmDelete.toast === '已移到回收站 2 项'
      ? undefined
      : JSON.stringify(result.confirmDelete))
  ok('走「永久删除」这条路时请求里带 permanent: true，提示也换成永久口径',
    result.confirmPermanent.permanentFlags.at(-1) === true && result.confirmPermanent.toast === '已永久删除 1 项'
      ? undefined
      : JSON.stringify(result.confirmPermanent))
  ok('删文件夹的确认框写明「含全部内容 + 第一级 N 项」',
    result.dirConfirm.items.length === 1 && result.dirConfirm.items[0].includes('sub')
      && result.dirConfirm.items[0].includes('含全部内容') && result.dirConfirm.items[0].includes('第一级 3 项')
      ? undefined
      : JSON.stringify(result.dirConfirm))
  ok('删文件夹同样走确认后再发 remove',
    result.dirDelete.removedCalls.length === 3
      && JSON.stringify(result.dirDelete.removedCalls[2]) === JSON.stringify([`${FIXTURE_ROOT}\\sub`])
      && result.dirDelete.toast === '已移到回收站 1 项'
      ? undefined
      : JSON.stringify(result.dirDelete))
  ok('Esc 关确认框且不执行删除',
    result.escapeDialog.dialog === false && result.escapeDialog.removedCalls === 3
      ? undefined
      : JSON.stringify(result.escapeDialog))
  ok('有选择时空白菜单给出删除与清除选择',
    JSON.stringify(result.blankMenuWithSelection.labels) === JSON.stringify([
      '上传文件到此处…', '复制路径', '刷新大小与日期', '全选可见项', '清除选择（1 项）', '删除',
    ])
      ? undefined
      : JSON.stringify(result.blankMenuWithSelection.labels))
  ok('全选可见项：选中整棵树当前可见的 9 行', result.selectAll === 9 ? undefined : String(result.selectAll))
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

  const wantDownloadHref = `/dsh-file-extras/download?root=${encodeURIComponent(FIXTURE_ROOT)}&path=${encodeURIComponent(`${FIXTURE_ROOT}\\alpha.txt`)}`
  const preflight = result.download.calls.filter((call) => call.endpoint === 'stat' && call.paths?.includes(`${FIXTURE_ROOT}\\alpha.txt`))
  ok('下载前先发一次 stat 预检（只读元数据，毫秒级）',
    preflight.length === 1 ? undefined : JSON.stringify(result.download.calls))
  ok('下载走浏览器原生导航：href 指向下载通道、download 名正确、锚点在文档里',
    result.download.anchors.length === 1
      && result.download.anchors[0].href === wantDownloadHref
      && result.download.anchors[0].download === 'alpha.txt'
      && result.download.anchors[0].connected === true
      ? undefined
      : JSON.stringify({ got: result.download.anchors, want: wantDownloadHref }))
  ok('下载不再把文件读成 Blob（fetch 0 次、objectURL 0 个 —— 大文件不会先堆进内存）',
    result.download.fetchCount === 0 && result.download.objectUrls === 0
      ? undefined
      : JSON.stringify({ fetchCount: result.download.fetchCount, objectUrls: result.download.objectUrls }))
  ok('下载提示立即给出，并带上文件大小',
    result.download.toast === '已开始下载 alpha.txt（1.2 KB）' ? undefined : JSON.stringify(result.download.toast))
  ok('预检失败时不发起下载，并说清原因',
    result.downloadMissing.anchors === 0 && result.downloadMissing.fetchCount === 0
      && typeof result.downloadMissing.toast === 'string'
      && result.downloadMissing.toast.includes('无法下载') && result.downloadMissing.toast.includes('已不存在')
      ? undefined
      : JSON.stringify(result.downloadMissing))

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
    ok('上传途中一直有进度提示（不会「点了没反应」）',
      typeof result.upload.progressToast === 'string' && result.upload.progressToast.includes('正在上传 note.txt')
        ? undefined
        : JSON.stringify(result.upload.progressToast))
    ok('上传完成弹提示',
      typeof result.upload.toast === 'string' && result.upload.toast.includes('已上传 1 个文件')
        ? undefined
        : JSON.stringify(result.upload.toast))
  }

  ok('空白处上传也打开了文件选择器', result.blankUpload.picked === 1 ? undefined : JSON.stringify(result.blankUpload))
  ok('工作区根空白（无选择）同样给出菜单',
    JSON.stringify(result.rootBlankMenu.labels) === JSON.stringify(['上传文件到此处…', '复制路径', '刷新大小与日期', '全选可见项'])
      ? undefined
      : JSON.stringify(result.rootBlankMenu))

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