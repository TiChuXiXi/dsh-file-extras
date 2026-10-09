window.__ModuleLoader__.load({
  id: 'dsh-file-extras',
  factory: (require) => {
    /**
     * dsh-file-extras —— 浏览器半区（跑在 dsh web 页面里）。
     *
     * 增强的对象是官方「工作区文件」树（@deepseek-ai/dsh-client-ui-sidebar-files）。那棵树
     * 只给了两件东西：**行**（`li[data-files-entry="file|directory|other"][data-files-path="<绝对路径>"]`
     * + 行内 `button/span`）和**树根**（`div[data-files-state="tree"][data-files-root="<工作区根>"]`）。
     * 槽位层面没有「每个文件一行」的座位（`sidebar.right.tab.files.actions` 只在标题栏出现一次），
     * 所以「行内显示大小/日期」和「行上右键菜单」只能在树的 DOM 上做增强，本插件就落在这里。
     *
     * 三条硬约束，改这个文件前先读：
     *   1. **不往 React 管的元素里插子节点**。大小/日期写进行元素自己的 `data-fx-meta` 属性，
     *      文本靠 CSS `::after { content: attr(data-fx-meta) }` 显示。React 只 diff 它 props 里
     *      出现过的属性，不认识的属性它既不会写也不会删，所以我们的标记不会被 reconciliation 抹掉。
     *   2. **自己的 UI 不挂 document.body**。右键菜单注册进 `shell.overlay`（框架级浮层，本来就
     *      在每一列之上、滚动容器之外），只有临时 `<input type="file">` 和下载用的 `<a>` 是
     *      一次性入体、用完即删。
     *   3. **中途失败不抛给页面**。元数据取不到就那行不显示，右键菜单操作失败弹 toast。
     *
     * 数据来自 host 半区 `/dsh-file-extras`：RPC `stat`（大小 / mtime / 一级子项数）、
     * `GET download`、`POST upload`。官方 `workspaceFiles` 命名空间给不了 mtime，所以这里必须是
     * 自建通道。
     */

    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** host 侧通道（index.js 里 webServer 注册的同一个前缀）。 */
    const CHANNEL = '/dsh-file-extras'
    /** 文件树树根与行：这两个 data 属性是官方组件对外暴露的稳定契约。 */
    const TREE_SELECTOR = '[data-files-state="tree"]'
    const ROW_SELECTOR = '[data-files-entry]'
    /** 我们写在行元素上的元数据文本（CSS ::after 取它）。 */
    const META_ATTR = 'data-fx-meta'
    /** 我们写在 li 上的抓取状态：pending / ok / none / stale。 */
    const MARK_ATTR = 'data-fx-mark'
    /** 树根上的窄栏标记：元数据从「靠右同排」切到「名字下面一行」。 */
    const NARROW_ATTR = 'data-fx-narrow'
    /**
     * 单行放不下就换行的阈值（px）。单行需要的宽度大致是
     * 缩进(≤36) + 图标16 + 间距6 + 名字(≥80 才有意义) + 间距8 + 时间戳(~145) + 行内边距20 + 滚动条 ≈ 310，
     * 取 320 留一点余量；再窄就让时间戳单独占一行 —— 那里至少放得下 152px 的内容。
     */
    const NARROW_WIDTH = 320
    /** 注入样式的归属标记（这是本包自己的样式表，live edit 时能一眼认出）。 */
    const STYLE_MARK = 'dsh-file-extras'
    /** 元数据的后台重取周期：文件在会话里被反复改写，行节点被 React 复用，不重取就会显示旧值。 */
    const RESYNC_INTERVAL_MS = 15000
    /** DOM 变更到重新抓取之间的去抖，避免一次展开触发多轮。 */
    const SYNC_DEBOUNCE_MS = 120

    /* --------------------------------------------------------------- 格式化 */

    const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

    /** 两位补零。 */
    function pad2(value) {
      return value < 10 ? `0${value}` : String(value)
    }

    /**
     * 按字节数自动选单位（1024 进制）。
     * @param bytes - 字节数。
     * @returns 形如 `0 B` / `812 B` / `1.5 KB` / `23 MB` 的文本；非法输入回空串。
     */
    function formatSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${Math.round(bytes)} B`
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${SIZE_UNITS[unit]}`
    }

    /**
     * 行内日期：一律 `YYYY-MM-DD HH:mm:ss`（本地时区）。
     *
     * 刻意不做「本年省略年份」的压缩：那样两年的文件长得不一样，扫一眼分不清是几月的记录；
     * 宽出来的那几像素由名字的 `text-overflow: ellipsis` 让位，比让人猜年份划算。
     * @param ms - 毫秒时间戳。
     * @returns 日期文本；非法输入回空串。
     */
    function formatDate(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const date = new Date(ms)
      if (Number.isNaN(date.getTime())) return ''
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    }

    /** 路径末段（`/` 与 `\` 都认）。 */
    function basenameOf(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.replace(/\\/g, '/').split('/')
      return parts[parts.length - 1] ?? ''
    }

    /** 任意异常压成可读字符串。 */
    function messageOf(cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }

    /* ------------------------------------------------------------------ 样式 */

    /**
     * 只绑定主题令牌（浅色/深色自动跟随），颜色一律给回退链，缺令牌时不至于变成透明。
     * `[data-files-entry] > [data-fx-meta]::after` 是本插件与官方树的唯一视觉接触点：
     * `margin-left:auto` 把元数据推到行尾，名字本身是 `min-width:0;overflow:hidden`，
     * 空间不够时先压缩名字，元数据始终完整。
     */
    const CSS = `
[data-files-entry] > [data-fx-meta]{
  overflow:hidden;
}
[data-files-entry] > [data-fx-meta]::after{
  content:attr(data-fx-meta);
  flex:none;
  margin-left:auto;
  padding-left:8px;
  font-size:11px;
  line-height:1.2;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  font-variant-numeric:tabular-nums;
  white-space:nowrap;
  pointer-events:none;
}
.dsh-fx-menu{
  position:fixed;
  z-index:1;
  min-width:196px;
  max-width:340px;
  padding:4px;
  border-radius:8px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));
  box-shadow:0 10px 28px rgba(0,0,0,.18);
  color:var(--dsw-alias-label-primary);
  font-size:13px;
  line-height:1.4;
  pointer-events:auto;
  user-select:none;
}
.dsh-fx-menu-title{
  padding:4px 10px 6px;
  margin-bottom:4px;
  border-bottom:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);
  font-size:11px;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.dsh-fx-menu-item{
  display:block;
  width:100%;
  box-sizing:border-box;
  padding:6px 10px;
  border:0;
  border-radius:6px;
  background:transparent;
  color:inherit;
  font:inherit;
  text-align:left;
  cursor:pointer;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.dsh-fx-menu-item:hover,.dsh-fx-menu-item:focus-visible{
  background:var(--dsw-alias-interactive-bg-hover);
  outline:none;
}
.dsh-fx-toast{
  position:fixed;
  left:50%;
  bottom:32px;
  transform:translateX(-50%);
  max-width:min(520px,80vw);
  padding:8px 14px;
  border-radius:8px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));
  box-shadow:0 10px 28px rgba(0,0,0,.18);
  color:var(--dsw-alias-label-primary);
  font-size:13px;
  line-height:1.5;
  white-space:pre-wrap;
  word-break:break-all;
  pointer-events:none;
}
.dsh-fx-toast[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
`

    /**
     * 窄栏样式：完整时间戳（`YYYY-MM-DD HH:mm:ss`，约 145px）在窄栏里和名字抢不下空间，
     * 与其把时间戳截断（那是这条信息里最不该丢的部分），不如让它换到名字下面一行。
     * 换行只改元数据自己的排布，不动名字的省略号行为。
     */
    const NARROW_CSS = `
[data-files-state="tree"][${NARROW_ATTR}] [data-files-entry] > [${META_ATTR}]{
  flex-wrap:wrap;
}
/* 名字必须留在一行上：flex-basis:auto 时它的假想主轴尺寸是整段文件名，
   换行算法在收缩之前就先判定"放不下"，会把图标孤零零留在上一行。
   basis 归零 + grow 才让它和图标共用第一行，超长部分照旧走省略号。 */
[data-files-state="tree"][${NARROW_ATTR}] [data-files-entry] > [${META_ATTR}] > span{
  flex:1 1 0;
  min-width:0;
}
[data-files-state="tree"][${NARROW_ATTR}] [data-files-entry] > [${META_ATTR}]::after{
  box-sizing:border-box;
  flex:0 0 100%;
  margin-left:0;
  padding-left:22px;
  overflow:hidden;
  text-overflow:ellipsis;
}
`

    /* ------------------------------------------------------- 浮层状态（菜单/提示） */

    /** 组件只读这一份快照；每次 publish 换新对象，引用变化即触发重渲染。 */
    let snapshot = { menu: null, toast: null }
    const storeListeners = new Set()

    function getSnapshot() {
      return snapshot
    }

    function subscribeStore(listener) {
      storeListeners.add(listener)
      return () => {
        storeListeners.delete(listener)
      }
    }

    function publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...storeListeners]) listener()
    }

    /** 身份计数器：key 变化让菜单/提示重新挂载（位置测量、定时器都跟着重置）。 */
    let sequence = 0
    let menuCloser = null
    let toastTimer = null

    /**
     * 打开右键菜单。
     * @param menu - { x, y, title, items }。
     */
    function openMenu(menu) {
      sequence += 1
      publish({ menu: { ...menu, id: sequence } })
    }

    /** 关闭右键菜单。 */
    function closeMenu() {
      if (snapshot.menu === null) return
      publish({ menu: null })
    }

    /**
     * 弹一条自动消失的提示。
     * @param text - 内容。
     * @param kind - 'ok' | 'error'。
     */
    function showToast(text, kind) {
      if (typeof text !== 'string' || text === '') return
      sequence += 1
      if (toastTimer !== null) window.clearTimeout(toastTimer)
      publish({ toast: { id: sequence, text, kind: kind ?? 'ok' } })
      toastTimer = window.setTimeout(() => {
        toastTimer = null
        publish({ toast: null })
      }, kind === 'error' ? 6000 : 2600)
    }

    /**
     * 点菜单项：先关菜单再跑，成功弹提示、失败弹错误。
     * @param item - 菜单项。
     */
    async function runItem(item) {
      closeMenu()
      try {
        const message = await item.run()
        if (typeof message === 'string' && message !== '') showToast(message, 'ok')
      } catch (cause) {
        showToast(messageOf(cause), 'error')
      }
    }

    /* ------------------------------------------------------------ 通道调用 */

    /** 由 apply 注入：`ctx.connection.rpc.call` 的绑定版本（组件拿不到 ctx）。 */
    let callChannel = null

    /**
     * 调一个 RPC 端点并拆掉 Connection 信封。
     * @param endpoint - 端点名。
     * @param payload - 载荷。
     * @returns 端点返回的 value。
     */
    async function call(endpoint, payload) {
      if (callChannel === null) throw new Error('连接尚未就绪')
      const result = await callChannel(CHANNEL, endpoint, payload)
      if (result === null || typeof result !== 'object') throw new Error(`端点 ${endpoint} 返回格式非法`)
      if (result.ok !== true) {
        const message = result.error !== null && typeof result.error === 'object' ? result.error.message : ''
        throw new Error(typeof message === 'string' && message !== '' ? message : `端点 ${endpoint} 失败`)
      }
      return result.value
    }

    /* ------------------------------------------------------- 文件树元数据 */

    /** 已发出 stat 请求、尚未回收的树根（同一棵树不并发重复请求）。 */
    const inFlight = new Set()
    /** 已经挂上宽度观察的树根（WeakSet：树的节点被 React 换掉后自然回收）。 */
    const watchedTrees = new WeakSet()
    /** 观察文件树宽度：侧栏拖动时单行/换行要跟着切。 */
    let treeWidthObserver = null
    /** 待应用的宽度（rAF 里统一写，见下）。 */
    const pendingWidths = new Map()
    let widthFrame = null
    let syncTimer = null

    /**
     * 按树当前的宽度切换「单行 / 换行」；值没变就不碰 DOM。
     * @param tree - 树根元素。
     * @param width - 实测宽度（px）。
     */
    function applyTreeWidth(tree, width) {
      const narrow = width > 0 && width < NARROW_WIDTH
      if (narrow === tree.hasAttribute(NARROW_ATTR)) return
      if (narrow) tree.setAttribute(NARROW_ATTR, '')
      else tree.removeAttribute(NARROW_ATTR)
    }

    /**
     * 把这一批宽度写进 DOM。
     *
     * 刻意放到 rAF 里而不是直接在观察回调里写：换行会让行变高，行变高又可能改变树的尺寸，
     * 于是观察回调在**同一帧内**再次触发 —— 浏览器会报
     * `ResizeObserver loop completed with undelivered notifications`。挪出这一帧就断开了这个环。
     */
    function flushWidths() {
      widthFrame = null
      for (const [tree, width] of pendingWidths) applyTreeWidth(tree, width)
      pendingWidths.clear()
    }

    /**
     * 给一棵新出现的树挂上宽度观察（幂等）。
     * @param tree - 树根元素。
     */
    function watchTree(tree) {
      if (watchedTrees.has(tree)) return
      watchedTrees.add(tree)
      applyTreeWidth(tree, tree.getBoundingClientRect().width)
      if (treeWidthObserver !== null) treeWidthObserver.observe(tree)
    }

    /** 取一棵树的根路径与「路径 → li」索引。 */
    function treeRows(tree) {
      const root = tree.getAttribute('data-files-root')
      if (typeof root !== 'string' || root === '') return null
      const rows = new Map()
      for (const li of tree.querySelectorAll(ROW_SELECTOR)) {
        const path = li.getAttribute('data-files-path')
        if (typeof path === 'string' && path !== '') rows.set(path, li)
      }
      return { root, rows }
    }

    /**
     * 把一次 stat 结果写进行。
     * @param li - 行容器。
     * @param entry - host 返回的条目，或 undefined（该路径没被回答）。
     */
    function writeRow(li, entry) {
      const row = li.firstElementChild
      if (row === null) {
        li.setAttribute(MARK_ATTR, 'none')
        return
      }
      const usable = entry !== undefined && typeof entry === 'object' && typeof entry.error !== 'string'
      let text = ''
      if (usable) {
        if (entry.type === 'directory') {
          // 目录的「大小」按需求就是一级子项数量：readdir 一层，不递归。
          const count = typeof entry.childCount === 'number' ? `${entry.childCount} 项` : ''
          text = [count, formatDate(entry.mtimeMs)].filter((part) => part !== '').join(' · ')
        } else if (entry.type === 'file') {
          text = [formatSize(entry.size), formatDate(entry.mtimeMs)].filter((part) => part !== '').join(' · ')
        }
      }
      if (text === '') {
        row.removeAttribute(META_ATTR)
        li.removeAttribute('title')
        li.setAttribute(MARK_ATTR, 'none')
        return
      }
      // 日期已经是完整时间戳、且元数据永远不被压缩（让位的是名字），所以不需要再挂 title。
      row.setAttribute(META_ATTR, text)
      li.setAttribute(MARK_ATTR, 'ok')
    }

    /**
     * 收下一棵树的 stat 结果并按路径回填。
     * @param root - 树根。
     * @param value - RPC value。
     */
    function applyEntries(root, value) {
      const entries = Array.isArray(value?.entries) ? value.entries : []
      const byPath = new Map()
      for (const entry of entries) {
        if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') byPath.set(entry.path, entry)
      }
      for (const tree of document.querySelectorAll(TREE_SELECTOR)) {
        const info = treeRows(tree)
        if (info === null || info.root !== root) continue
        for (const [path, li] of info.rows) {
          if (li.getAttribute(MARK_ATTR) !== 'pending') continue
          writeRow(li, byPath.get(path))
        }
      }
    }

    /**
     * 为一棵树排队并发出 stat。
     * @param tree - 树根元素。
     * @param force - true 时连已取过的行也重取（stale 刷新）。
     */
    function queueTree(tree, force) {
      const info = treeRows(tree)
      if (info === null) return
      if (inFlight.has(info.root)) return
      const pending = []
      for (const [path, li] of info.rows) {
        const mark = li.getAttribute(MARK_ATTR)
        if (mark === 'pending') continue
        // 非强制同步只补「从没取过」的行；强制同步把已有结果也重取一遍。
        if (mark !== null && force !== true) continue
        li.setAttribute(MARK_ATTR, 'pending')
        pending.push(path)
      }
      if (pending.length === 0) return
      inFlight.add(info.root)
      call('stat', { root: info.root, paths: pending })
        .then((value) => {
          applyEntries(info.root, value)
        })
        .catch((cause) => {
          console.warn('[dsh-file-extras] 取文件元数据失败：', messageOf(cause))
          for (const tree2 of document.querySelectorAll(TREE_SELECTOR)) {
            const info2 = treeRows(tree2)
            if (info2 === null || info2.root !== info.root) continue
            for (const li of info2.rows.values()) {
              if (li.getAttribute(MARK_ATTR) === 'pending') li.setAttribute(MARK_ATTR, 'none')
            }
          }
        })
        .then(() => {
          inFlight.delete(info.root)
          // 请求往返期间树里可能又长出新行：再跑一轮（下一轮没有待取行就自然停下）。
          scheduleSync(SYNC_DEBOUNCE_MS)
        })
    }

    /**
     * 扫描当前所有文件树。
     * @param force - true 时重取已显示的值（保留旧文本，不回退成空白）。
     */
    function syncAll(force) {
      for (const tree of document.querySelectorAll(TREE_SELECTOR)) {
        watchTree(tree)
        if (force === true) {
          for (const li of tree.querySelectorAll(ROW_SELECTOR)) {
            if (li.getAttribute(MARK_ATTR) !== 'pending') li.setAttribute(MARK_ATTR, 'stale')
          }
        }
        queueTree(tree, force)
      }
    }

    /** 去抖排队一次同步。 */
    function scheduleSync(delay) {
      if (syncTimer !== null) window.clearTimeout(syncTimer)
      syncTimer = window.setTimeout(() => {
        syncTimer = null
        syncAll(false)
      }, delay)
    }

    /** 触发一棵树的官方重载（点它的刷新按钮），再顺手重取元数据。 */
    function refreshTrees(root) {
      for (const tree of document.querySelectorAll(TREE_SELECTOR)) {
        if (tree.getAttribute('data-files-root') !== root) continue
        const reload = tree.querySelector('[data-files-reload]')
        if (reload instanceof HTMLElement) reload.click()
      }
      syncAll(true)
    }

    /* ------------------------------------------------------------ 动作实现 */

    /**
     * 下载一个文件：host 侧回原始字节，这边转 Blob 交给浏览器落盘。
     * 不用 `<a href>` 直接导航是为了保留错误回执（403/404/超限都能变成一句提示）。
     *
     * host 对下载/上传失败回的是**非 200** + JSON 错误体；这里再按 content-type 兜一层 ——
     * 端点若哪天退回「200 + {ok:false}」的老信封，也不至于把一段错误 JSON 当成文件存盘。
     * @param root - 工作区根。
     * @param path - 文件绝对路径。
     * @returns 提示文本。
     */
    async function downloadFile(root, path) {
      const name = basenameOf(path)
      const url = `${CHANNEL}/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      const response = await fetch(url, { credentials: 'same-origin' })
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (!response.ok || contentType.includes('application/json')) {
        let detail = ''
        try {
          const body = await response.json()
          if (typeof body?.error?.message === 'string') detail = body.error.message
        } catch {
          detail = ''
        }
        throw new Error(detail !== '' ? detail : `下载失败：HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = name
      anchor.rel = 'noopener'
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(href), 60000)
      return `已开始下载 ${name}`
    }

    /**
     * 复制文本到剪贴板：优先 Clipboard API，失败回退到临时 textarea。
     * @param text - 要复制的内容。
     * @returns 提示文本。
     */
    async function copyText(text) {
      let copied = false
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch {
        copied = false
      }
      if (!copied) {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0'
        document.body.appendChild(area)
        area.select()
        try {
          copied = document.execCommand('copy')
        } catch {
          copied = false
        }
        area.remove()
      }
      if (!copied) throw new Error('复制失败：浏览器拒绝了剪贴板访问')
      return '已复制路径'
    }

    /**
     * 上传单个文件（原始字节，不套 multipart —— host 侧直接从查询串取目录与文件名）。
     * @param root - 工作区根。
     * @param dir - 目标目录绝对路径。
     * @param file - 浏览器 File 对象。
     */
    async function uploadOne(root, dir, file) {
      const url = `${CHANNEL}/upload?root=${encodeURIComponent(root)}`
        + `&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`
      const response = await fetch(url, { method: 'POST', body: file, credentials: 'same-origin' })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (body === null || body.ok !== true) {
        const message = typeof body?.error?.message === 'string' ? body.error.message : '上传失败'
        throw new Error(message)
      }
      return body.value
    }

    /**
     * 依次上传一批文件，全部结束再刷新一次树（避免每传一个文件重载一次）。
     * @param root - 工作区根。
     * @param dir - 目标目录。
     * @param files - File 列表。
     */
    async function uploadAll(root, dir, files) {
      let done = 0
      const failures = []
      for (const file of files) {
        try {
          await uploadOne(root, dir, file)
          done += 1
        } catch (cause) {
          failures.push(`${file.name}：${messageOf(cause)}`)
        }
      }
      refreshTrees(root)
      if (failures.length === 0) {
        showToast(`已上传 ${done} 个文件到 ${basenameOf(dir) || dir}`, 'ok')
        return
      }
      showToast(`上传完成 ${done} 个，失败 ${failures.length} 个\n${failures.join('\n')}`, 'error')
    }

    /**
     * 打开系统文件选择器，选完往目录里传。
     * @param root - 工作区根。
     * @param dir - 目标目录绝对路径。
     * @returns 空串（进度由 uploadAll 自己弹提示）。
     */
    function pickUpload(root, dir) {
      if (typeof root !== 'string' || root === '' || typeof dir !== 'string' || dir === '') {
        throw new Error('无法确定上传目标目录')
      }
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0'
      document.body.appendChild(input)
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? [])
        input.remove()
        if (files.length === 0) return
        void uploadAll(root, dir, files)
      }, { once: true })
      input.click()
      return ''
    }

    /* -------------------------------------------------------------- 菜单项 */

    function fileItems(root, path) {
      return [
        { id: 'download', label: '下载', run: () => downloadFile(root, path) },
        { id: 'copy-path', label: '复制路径', run: () => copyText(path) },
      ]
    }

    function directoryItems(root, path) {
      return [
        { id: 'upload', label: '上传文件到此处…', run: () => pickUpload(root, path) },
        { id: 'copy-path', label: '复制路径', run: () => copyText(path) },
      ]
    }

    function blankItems(root, dir) {
      return [
        { id: 'upload', label: '上传文件到此处…', run: () => pickUpload(root, dir) },
        { id: 'copy-path', label: '复制路径', run: () => copyText(dir) },
        { id: 'refresh', label: '刷新大小与日期', run: () => { syncAll(true); return '' } },
      ]
    }

    /* ------------------------------------------------------------ 事件处理 */

    /**
     * 右键：只接管文件树内的菜单，树外一律 `return`，浏览器默认菜单照旧。
     * 命中行元素（按钮/span 本体）→ 文件/目录菜单；其余落在树里的位置都算空白 ——
     * 包括展开目录的子 `ul`，它虽然也在 `li[data-files-entry]` 里面，但那片空白属于该目录。
     * @param event - contextmenu 事件。
     */
    function onContextMenu(event) {
      const element = event.target
      if (!(element instanceof Element)) return
      const tree = element.closest(TREE_SELECTOR)
      if (tree === null) return
      const root = tree.getAttribute('data-files-root') ?? ''
      if (root === '') return
      event.preventDefault()
      event.stopPropagation()
      const li = element.closest(ROW_SELECTOR)
      // 关键：不能只用 closest(ROW_SELECTOR)。目录 li 同时装着「行元素」和「子列表 ul」，
      // 两者都会 closest 到同一个 li —— 只有落在行元素自己身上才是「对着这一行右键」。
      const rowElement = li === null ? null : li.firstElementChild
      const onRow = rowElement !== null && (element === rowElement || rowElement.contains(element))
      if (onRow) {
        const path = li.getAttribute('data-files-path') ?? ''
        if (path === '') return
        const isDirectory = li.getAttribute('data-files-entry') === 'directory'
        openMenu({
          x: event.clientX,
          y: event.clientY,
          title: basenameOf(path),
          items: isDirectory ? directoryItems(root, path) : fileItems(root, path),
        })
        return
      }
      // 空白处：先看落点在哪个已展开目录的子列表里，找不到就归工作区根。
      const owner = li !== null && li.getAttribute('data-files-entry') === 'directory' ? li : element.closest('li[data-files-entry="directory"]')
      const dir = owner !== null ? (owner.getAttribute('data-files-path') ?? root) : root
      openMenu({ x: event.clientX, y: event.clientY, title: basenameOf(dir) || dir, items: blankItems(root, dir) })
    }

    /** 点空白处（菜单外）关菜单。 */
    function onDocumentMouseDown(event) {
      if (snapshot.menu === null) return
      const element = event.target
      if (element instanceof Element && element.closest('.dsh-fx-menu') !== null) return
      closeMenu()
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') closeMenu()
    }

    /** 树体在滚动容器里，滚动/窗口变化后菜单位置就错了，直接关掉最省事。 */
    function onViewportChange() {
      closeMenu()
    }

    /* ---------------------------------------------------------- 浮层组件 */

    /**
     * 右键菜单本体。位置先按指针放，挂载后按实际尺寸夹回视口内。
     * @param props - { menu }。
     */
    function MenuView({ menu }) {
      const ref = React.useRef(null)
      const [position, setPosition] = React.useState({ left: menu.x, top: menu.y })
      React.useLayoutEffect(() => {
        const element = ref.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        setPosition({
          left: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
          top: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8)),
        })
      }, [menu])
      return h('div', {
        ref,
        className: 'dsh-fx-menu',
        role: 'menu',
        style: { left: `${position.left}px`, top: `${position.top}px` },
        // 菜单自己也要吃掉右键，否则在菜单上再右键会弹出浏览器菜单。
        onContextMenu: (event) => { event.preventDefault() },
      },
      menu.title === '' ? null : h('div', { className: 'dsh-fx-menu-title' }, menu.title),
      menu.items.map((item) => h('button', {
        key: item.id,
        type: 'button',
        role: 'menuitem',
        className: 'dsh-fx-menu-item',
        title: item.label,
        onClick: () => { void runItem(item) },
      }, item.label)))
    }

    /** 短暂提示条。 */
    function ToastView({ toast }) {
      return h('div', { className: 'dsh-fx-toast', 'data-kind': toast.kind, role: 'status' }, toast.text)
    }

    /** `shell.overlay` 的占位：没有菜单也没有提示时返回 null，浮层保持穿透。 */
    function Overlay() {
      const state = React.useSyncExternalStore(subscribeStore, getSnapshot)
      if (state.menu === null && state.toast === null) return null
      return h(React.Fragment, null,
        state.menu === null ? null : h(MenuView, { key: `menu-${state.menu.id}`, menu: state.menu }),
        state.toast === null ? null : h(ToastView, { key: `toast-${state.toast.id}`, toast: state.toast }))
    }

    /* -------------------------------------------------------------- 生命周期 */

    let styleElement = null
    let observer = null
    let resyncTimer = null

    /** 卸载时把树还原成我们没来过的样子。 */
    function clearMarks() {
      for (const tree of document.querySelectorAll(TREE_SELECTOR)) tree.removeAttribute(NARROW_ATTR)
      for (const li of document.querySelectorAll(ROW_SELECTOR)) {
        const row = li.firstElementChild
        if (row !== null) row.removeAttribute(META_ATTR)
        li.removeAttribute(MARK_ATTR)
        li.removeAttribute('title')
      }
    }

    function install() {
      styleElement = document.createElement('style')
      styleElement.setAttribute('data-plugin', STYLE_MARK)
      styleElement.textContent = `${CSS}${NARROW_CSS}`
      document.head.appendChild(styleElement)

      treeWidthObserver = new ResizeObserver((entries) => {
        for (const entry of entries) pendingWidths.set(entry.target, entry.contentRect.width)
        if (widthFrame === null) widthFrame = window.requestAnimationFrame(flushWidths)
      })

      document.addEventListener('contextmenu', onContextMenu, true)
      document.addEventListener('mousedown', onDocumentMouseDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('blur', onViewportChange)
      document.addEventListener('scroll', onViewportChange, true)

      observer = new MutationObserver(() => { scheduleSync(SYNC_DEBOUNCE_MS) })
      observer.observe(document.body, { childList: true, subtree: true })

      resyncTimer = window.setInterval(() => {
        if (document.visibilityState !== 'visible') return
        if (document.querySelector(TREE_SELECTOR) === null) return
        syncAll(true)
      }, RESYNC_INTERVAL_MS)

      scheduleSync(0)
    }

    function uninstall() {
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('blur', onViewportChange)
      document.removeEventListener('scroll', onViewportChange, true)
      if (observer !== null) observer.disconnect()
      if (treeWidthObserver !== null) treeWidthObserver.disconnect()
      if (widthFrame !== null) window.cancelAnimationFrame(widthFrame)
      if (resyncTimer !== null) window.clearInterval(resyncTimer)
      if (syncTimer !== null) window.clearTimeout(syncTimer)
      if (toastTimer !== null) window.clearTimeout(toastTimer)
      observer = null
      treeWidthObserver = null
      widthFrame = null
      pendingWidths.clear()
      resyncTimer = null
      syncTimer = null
      toastTimer = null
      inFlight.clear()
      if (styleElement !== null) styleElement.remove()
      styleElement = null
      clearMarks()
      publish({ menu: null, toast: null })
      menuCloser = null
    }

    /* ---------------------------------------------------------------- 入口 */

    /** 浏览器半区必需的 Cordis 服务：slots 挂浮层菜单，connection 调 host 通道。 */
    const inject = ['slots', 'connection']

    /**
     * @param ctx - 客户端根 context。
     */
    function apply(ctx) {
      callChannel = (channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload)

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-file-extras-menu',
        order: 60,
      }, Overlay)), 'dsh-file-extras: context menu overlay')

      ctx.effect(() => {
        install()
        return () => { uninstall() }
      }, 'dsh-file-extras: file tree enhancement')

      console.log('[dsh-file-extras] 浏览器半区已激活：文件树元数据 + 右键菜单')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
