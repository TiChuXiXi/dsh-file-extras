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
     *
     * 「@ 到对话」是唯一的例外，它**不走**本插件的 host 通道：引用芯片交给官方会话输入框
     * 自己插（`ctx.conversation.input.for(actx).addFiles(...)`，和把文件拖进输入框同一条路），
     * 本插件只负责「从文件树里认出用户点了哪个文件」+「拼出和官方 @ 补全逐字一致的提及文本」。
     * 序列化、点击预览、草稿持久化、发送都沿用官方行为，不重新实现。
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
    /** 写在**行元素**上的选中标记（CSS 用它画选中态，也是剪枝时唯一的真相来源）。 */
    const SELECTED_ATTR = 'data-fx-selected'
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
.dsh-fx-menu-item[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}
.dsh-fx-menu-sep{
  height:1px;
  margin:4px 6px;
  background:var(--dsw-alias-border-l1);
}
/* 选中态：填色 + 一圈内描边。只填色会和 :hover 撞成一样，加描边才一眼分得清。 */
[data-files-entry] > [${SELECTED_ATTR}]{
  background:var(--dsw-alias-interactive-bg-hover);
  box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));
}
.dsh-fx-backdrop{
  position:fixed;
  inset:0;
  z-index:2;
  display:flex;
  align-items:center;
  justify-content:center;
  background:rgba(0,0,0,.32);
  pointer-events:auto;
}
.dsh-fx-dialog{
  box-sizing:border-box;
  width:min(460px,88vw);
  max-height:80vh;
  display:flex;
  flex-direction:column;
  padding:16px;
  border-radius:10px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));
  box-shadow:0 18px 48px rgba(0,0,0,.28);
  color:var(--dsw-alias-label-primary);
  font-size:13px;
  line-height:1.5;
}
.dsh-fx-dialog-title{font-size:14px;font-weight:600;margin-bottom:6px}
.dsh-fx-dialog-message{margin:0 0 10px;color:var(--dsw-alias-label-secondary)}
.dsh-fx-dialog-list{
  margin:0 0 12px;
  padding:6px;
  list-style:none;
  overflow:auto;
  flex:1 1 auto;
  min-height:0;
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:6px;
  background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));
}
.dsh-fx-dialog-item{display:flex;align-items:baseline;gap:8px;padding:2px 6px}
.dsh-fx-dialog-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fx-dialog-kind{margin-left:auto;flex:none;padding-left:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-fx-dialog-more{padding:2px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-fx-dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex:none}
.dsh-fx-check{
  display:flex;
  align-items:center;
  gap:6px;
  margin:0 0 12px;
  color:var(--dsw-alias-label-secondary);
  cursor:pointer;
  user-select:none;
}
.dsh-fx-check input{margin:0;cursor:pointer}
.dsh-fx-btn{
  padding:5px 14px;
  border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  font:inherit;
  cursor:pointer;
}
.dsh-fx-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fx-btn[data-variant="primary"]{
  border-color:transparent;
  background:var(--dsw-alias-brand-primary);
  color:#fff;
}
.dsh-fx-btn[data-variant="danger"]{
  border-color:transparent;
  background:var(--dsw-alias-state-error-primary);
  color:#fff;
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
.dsh-fx-toast[data-kind="progress"]{color:var(--dsw-alias-label-secondary)}
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

    /* --------------------------------------------- 浮层状态（菜单 / 确认框 / 提示） */

    /** 组件只读这一份快照；每次 publish 换新对象，引用变化即触发重渲染。 */
    let snapshot = { menu: null, dialog: null, toast: null }
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

    /** 身份计数器：key 变化让菜单/确认框/提示重新挂载（位置测量、焦点、定时器都跟着重置）。 */
    let sequence = 0
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
     * 打开二次确认框。
     * @param dialog - { title, message, items, confirmLabel, onConfirm }。
     */
    function openDialog(dialog) {
      sequence += 1
      publish({ dialog: { ...dialog, id: sequence } })
    }

    /** 取消当前确认框（什么都不做）。 */
    function cancelDialog() {
      if (snapshot.dialog === null) return
      publish({ dialog: null })
    }

    /** 确认并执行：先收框，再跑动作，异常统一变成错误提示。 */
    async function runDialog(checked) {
      const dialog = snapshot.dialog
      if (dialog === null) return
      publish({ dialog: null })
      try {
        const message = await dialog.onConfirm(checked === true)
        if (typeof message === 'string' && message !== '') showToast(message, 'ok')
      } catch (cause) {
        showToast(messageOf(cause), 'error')
      }
    }

    /**
     * 弹一条提示。
     * @param text - 内容。
     * @param kind - 'ok' | 'error' | 'progress'。
     * @param options - `sticky: true` 表示不自动消失（进度类提示用，结束时要自己再弹一条覆盖它）。
     */
    function showToast(text, kind, options) {
      if (typeof text !== 'string' || text === '') return
      sequence += 1
      if (toastTimer !== null) window.clearTimeout(toastTimer)
      const sticky = options?.sticky === true
      publish({ toast: { id: sequence, text, kind: kind ?? 'ok' } })
      toastTimer = sticky
        ? null
        : window.setTimeout(() => {
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

    /* -------------------------------------------------------------- 多选 */

    /**
     * 当前选择。官方那棵树没有多选，这是本插件自己维护的一套：
     *
     *   · `Ctrl/⌘ + 单击` —— 切换单行；
     *   · `Shift + 单击`  —— 从锚点行到这一行（**可见行的 DOM 顺序**）整段选上；
     *   · 普通单击        —— 清空选择，并把这一行设为新的锚点，然后放行官方行为（打开文件 / 展开目录）；
     *   · 空白处单击      —— 清空选择；
     *   · Esc             —— 依次收掉确认框、右键菜单、选择。
     *
     * 选择按「树元素」隔离：点另一棵树的行会先把旧选择清掉，避免两个面板的选择互相污染。
     * 真相只有一份 —— 行元素上的 `data-fx-selected` 属性；`paths` 只是它的镜像，
     * 每次同步都会按 DOM 里实际还在的行剪枝（折叠、刷新、被删掉的行会自动掉出选择）。
     */
    const selection = { tree: null, paths: new Set(), anchor: null }

    /** 取一行的「行元素」（`button` 或 `span`，也就是承载元数据与选中态的那个节点）。 */
    function rowElementOf(li) {
      return li === null ? null : li.firstElementChild
    }

    /** 把一棵树里所有可见行的（路径 → li）按 DOM 顺序列出来 —— Shift 区间选择要用这个顺序。 */
    function visibleRows(tree) {
      const rows = []
      for (const li of tree.querySelectorAll(ROW_SELECTOR)) {
        const path = li.getAttribute('data-files-path')
        if (typeof path === 'string' && path !== '') rows.push({ path, li })
      }
      return rows
    }

    /** 清空选择（含 DOM 上的标记）。 */
    function clearSelection() {
      if (selection.paths.size === 0 && selection.anchor === null) return
      for (const row of document.querySelectorAll(`[${SELECTED_ATTR}]`)) row.removeAttribute(SELECTED_ATTR)
      selection.tree = null
      selection.paths.clear()
      selection.anchor = null
    }

    /**
     * 把一棵树当前的选择重新刷到 DOM 上。
     * @param tree - 树根元素。
     */
    function paintSelection(tree) {
      for (const { path, li } of visibleRows(tree)) {
        const row = rowElementOf(li)
        if (row === null) continue
        if (selection.paths.has(path)) row.setAttribute(SELECTED_ATTR, '')
        else row.removeAttribute(SELECTED_ATTR)
      }
    }

    /**
     * 用一批路径替换当前选择。
     * @param tree - 树根元素。
     * @param paths - 选中的路径。
     * @param anchor - 新的锚点行。
     */
    function setSelection(tree, paths, anchor) {
      clearSelection()
      selection.tree = tree
      for (const path of paths) selection.paths.add(path)
      selection.anchor = anchor ?? null
      paintSelection(tree)
    }

    /**
     * Ctrl/⌘ + 单击：切换一行。
     * @param tree - 树根元素。
     * @param path - 该行路径。
     */
    function toggleSelection(tree, path) {
      if (selection.tree !== tree) {
        setSelection(tree, [path], path)
        return
      }
      const next = new Set(selection.paths)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      setSelection(tree, next, path)
    }

    /**
     * Shift + 单击：从锚点到这一行整段选中。
     * @param tree - 树根元素。
     * @param path - 该行路径。
     */
    function extendSelection(tree, path) {
      const rows = visibleRows(tree)
      const to = rows.findIndex((row) => row.path === path)
      let from = rows.findIndex((row) => row.path === selection.anchor)
      if (to < 0) return
      if (from < 0) from = to
      const [start, end] = from <= to ? [from, to] : [to, from]
      const next = new Set(selection.paths)
      for (let index = start; index <= end; index += 1) next.add(rows[index].path)
      setSelection(tree, next, selection.anchor)
    }

    /**
     * 全选这棵树里当前可见的所有行。
     * @param tree - 树根元素。
     * @returns 选中的数量。
     */
    function selectAllVisible(tree) {
      const rows = visibleRows(tree)
      setSelection(tree, rows.map((row) => row.path), rows.length === 0 ? null : rows[0].path)
      return rows.length
    }

    /** 剪枝：只保留此刻还在 DOM 里的选中行（折叠 / 刷新 / 删除后调用）。 */
    function pruneSelection() {
      if (selection.paths.size === 0) return
      const alive = new Set()
      for (const row of document.querySelectorAll(`[${SELECTED_ATTR}]`)) {
        const li = row.closest(ROW_SELECTOR)
        const path = li === null ? null : li.getAttribute('data-files-path')
        if (typeof path === 'string' && path !== '') alive.add(path)
      }
      for (const path of [...selection.paths]) {
        if (!alive.has(path)) selection.paths.delete(path)
      }
      if (selection.paths.size === 0) {
        selection.tree = null
        selection.anchor = null
      }
    }

    /**
     * 右键要作用的目标集合。
     *
     * 规矩和资源管理器一致：右键落在**已选中**的行上 → 作用整个选择；落在别的行上 →
     * 先把选择换成这一行再作用它 —— 这样「先 Ctrl 点几个，再右键删」和「直接右键删一个」
     * 都是自然的，也不会出现「看着选中了 5 个，结果只删了右键的那一个」。
     * @param tree - 树根元素。
     * @param path - 被右键的行路径（空白处传 null）。
     * @returns {Array<{ path, kind }>} 目标列表。
     */
    function targetsFor(tree, path) {
      const kindOf = new Map(visibleRows(tree).map((row) => [row.path, row.li.getAttribute('data-files-entry') ?? 'file']))
      if (path === null) {
        return [...selection.paths].map((item) => ({ path: item, kind: kindOf.get(item) ?? 'file' }))
      }
      const inside = selection.tree === tree && selection.paths.has(path)
      if (!inside) setSelection(tree, [path], path)
      const paths = inside ? [...selection.paths] : [path]
      return paths.map((item) => ({ path: item, kind: kindOf.get(item) ?? 'file' }))
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
    /**
     * 路径 → 最近一次 stat 的结果。只给「删除确认框」用：那里要写清每项是文件还是文件夹、
     * 多大、文件夹里第一级有几项 —— 光有行上的渲染文本（`1.2 KB · 2026-…`）拆不出这些。
     */
    const entryCache = new Map()
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
        if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
        byPath.set(entry.path, entry)
        if (typeof entry.error === 'string') entryCache.delete(entry.path)
        else entryCache.set(entry.path, entry)
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
      pruneSelection()
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

    /** 预检（stat）错误码 → 给用户看的一句话。 */
    const STAT_ERROR_TEXT = {
      missing: '文件已不存在',
      'file-extras/outside-workspace': '路径不在工作区内',
      'file-extras/not-found': '文件已不存在',
      'file-extras/bad-request': '路径非法',
      unavailable: '读不到（权限或被占用）',
    }

    /**
     * 下载一个文件。
     *
     * **不要用 `fetch` + `response.blob()`**：那个写法要等整个文件传完、并在页面内存里拼出
     * 一份完整副本之后 promise 才 resolve —— 大文件因此「点下去很久没反应」，几百 MB 时既慢
     * 又要吃掉同等内存，而且最后还要再从内存写一遍到磁盘。改成两段：
     *
     *   1. **预检**：走已有的 `stat` RPC（毫秒级，只读元数据）。权限、存在性、是不是普通文件
     *      都在这一步判定，失败直接弹具体原因 —— 不会像纯 `<a href>` 导航那样，把一段错误
     *      JSON 静默存成「文件」；
     *   2. **交给浏览器原生下载**：`<a download>` 触发导航，字节由 host 经 HTTP 直接流到磁盘，
     *      完全不经过 JS 堆，立即开始、内存零拷贝、没有大小上限。
     *
     * 代价是理论上存在一个窗口：预检通过后、导航发出前文件被删掉。此时浏览器会存下一个很小的
     * 错误体 —— 概率极低且一眼可辨，比为大文件牺牲即时性划算。
     * @param root - 工作区根。
     * @param path - 文件绝对路径。
     * @returns 提示文本。
     */
    async function downloadFile(root, path) {
      const name = basenameOf(path)
      const probe = await call('stat', { root, paths: [path] })
      const entry = Array.isArray(probe?.entries) ? probe.entries[0] : undefined
      if (entry === undefined || typeof entry.error === 'string') {
        const reason = STAT_ERROR_TEXT[entry?.error] ?? '读取失败'
        throw new Error(`${name} 无法下载：${reason}`)
      }
      if (entry.type !== 'file') throw new Error(`${name} 不是普通文件，无法下载`)
      const anchor = document.createElement('a')
      anchor.href = `${CHANNEL}/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
      anchor.download = name
      anchor.rel = 'noopener'
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      const size = formatSize(entry.size)
      return size === '' ? `已开始下载 ${name}` : `已开始下载 ${name}（${size}）`
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
     *
     * 每个文件开始前先弹一条**不会自动消失**的进度提示：大文件传输期间页面上必须有东西在动，
     * 否则用户看到的就是「点了上传，半天没反应」——和下载那边是同一类问题。
     * @param root - 工作区根。
     * @param dir - 目标目录。
     * @param files - File 列表。
     */
    async function uploadAll(root, dir, files) {
      let done = 0
      const failures = []
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        showToast(
          files.length === 1
            ? `正在上传 ${file.name}（${formatSize(file.size) || '—'}）…`
            : `正在上传 ${index + 1}/${files.length}：${file.name}（${formatSize(file.size) || '—'}）…`,
          'progress',
          { sticky: true },
        )
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

    /* ------------------------------------------------------------ @ 到对话 */

    /**
     * 客户端根 context，`apply` 时记下。
     *
     * 右键菜单虽然渲染在 React 里，但「@ 到对话」要的是**会话服务**，那是 cordis 上的东西：
     * 组件拿不到 ctx，只有 apply 拿得到，所以在这里留一个引用。
     */
    let clientCtx = null

    /**
     * 复刻官方 `@` 补全的路径语法（`@deepseek-ai/dsh-file-reference` 的 `formatFileMention`）。
     *
     * 必须逐字一致：右键插进去的芯片和用户自己敲 `@` 选出来的是同一种东西，
     * 序列化（模型看到的文本）、点击预览、发送都走官方那条路。
     * 规则是「有空白就加引号；目录的引号故意不闭合、并以 `/` 结尾（那是官方留给继续下钻的语法）」。
     * @param path - 工作区相对路径（正斜杠；目录**不带**尾斜杠）。
     * @param kind - `file` 或 `directory`。
     * @returns 提及文本；路径含控制字符或双引号时返回 undefined（编辑器语法表示不了这种路径）。
     */
    function formatMention(path, kind) {
      const text = kind === 'directory' ? `${path}/` : path
      if (/[\u0000-\u001f\u007f-\u009f"]/u.test(text)) return undefined
      if (!/\s/u.test(text)) return `@${text}`
      return kind === 'directory' ? `@"${text}` : `@"${text}"`
    }

    /**
     * 绝对路径 → 工作区相对路径。
     *
     * 官方 `@` 候选（`dsh-file-reference-local`）给的是「相对工作区根 + 正斜杠」，
     * 模型也按这个解析，所以这里必须同样处理。注意文件树的 `data-files-path` 是
     * `D:\a\b/c/d.ts` 这种「反斜杠根 + 正斜杠子路径」的混合形式（官方 `childPath`
     * 就是拼 `/`），所以先统一成正斜杠再比。
     * @param absolute - 树里的绝对路径。
     * @param cwd - 会话工作区根。
     * @returns 相对路径；不在工作区里就原样返回（与官方拖拽文件的处理一致）。
     */
    function workspaceRelative(absolute, cwd) {
      const text = absolute.replace(/\\/g, '/')
      const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      if (root === '') return text
      if (text === root) return ''
      return text.startsWith(`${root}/`) ? text.slice(root.length + 1) : text
    }

    /**
     * 找到「当前正在看的那个对话」的输入框外壳。
     *
     * 当前会话从 `ctx.sidebarRight.mounted` 读 —— 那是官方对「主栏里正在显示哪个会话」的
     * 唯一公开可观察量，文件树本身也是按这个会话渲染的。会话 context 用
     * `ctx.sessions.scope(id)` 借（不延长生命周期），输入框外壳用官方公开的
     * `ctx.conversation.input.for(actx)` 解析。
     * @returns `{ input, sessions, sessionId }`；任一步拿不到就返回 `{ error }`。
     */
    function resolveComposer() {
      const ctx = clientCtx
      if (ctx === null || typeof ctx.get !== 'function') return { error: '插件尚未就绪' }
      const conversation = ctx.get('conversation')
      const sessions = ctx.get('sessions')
      if (conversation === undefined || conversation === null) return { error: '对话服务不可用' }
      if (sessions === undefined || sessions === null) return { error: '会话服务不可用' }
      const sidebarRight = ctx.get('sidebarRight')
      const mounted = sidebarRight === undefined || sidebarRight === null ? undefined : sidebarRight.mounted
      const sessionId = mounted === undefined ? undefined : mounted.getSnapshot()
      if (sessionId === undefined || sessionId === null) return { error: '当前没有打开的对话，无法 @ 到对话' }
      const actx = sessions.scope(sessionId)
      if (actx === undefined || actx === null) return { error: '当前对话尚未就绪，无法 @ 到对话' }
      let input = null
      try {
        input = conversation.input.for(actx)
      } catch (cause) {
        return { error: messageOf(cause) }
      }
      if (input === null || input === undefined || typeof input.addFiles !== 'function') {
        return { error: '当前对话的输入框不支持插入引用' }
      }
      return { input, sessions, sessionId }
    }

    /**
     * 把若干文件/文件夹以 `@` 引用芯片的形式放进当前对话的输入框。
     *
     * **不自己实现「对话里 @ 文件」**：芯片交给会话自己的编辑器插（官方 `addFiles`，
     * 和把文件拖进输入框走的是同一条路），所以序列化、点击预览、草稿持久化、
     * 发送时展开成模型文本，全部沿用官方行为。
     *
     * 只插入、不发送 —— 用户还要接着写话，替他按发送键是越权。
     * @param root - 工作区根（拿不到会话 cwd 时的兜底基准）。
     * @param targets - `{ path, kind }` 列表。
     * @returns 成功提示文本。
     * @throws 失败原因（`runItem` 把它当错误提示弹出来）。
     */
    function mentionIntoComposer(root, targets) {
      if (targets.length === 0) throw new Error('没有可 @ 的目标')
      const resolved = resolveComposer()
      if (resolved.error !== undefined) throw new Error(resolved.error)
      const cwd = resolved.sessions.list.getSnapshot().byId[resolved.sessionId]?.cwd
      const base = typeof cwd === 'string' && cwd !== '' ? cwd : root
      const references = []
      for (const target of targets) {
        const relative = workspaceRelative(target.path, base)
        if (relative === '') throw new Error('工作区根目录本身无法 @ 到对话')
        const mention = formatMention(relative, target.kind)
        if (mention === undefined) throw new Error(`路径含无法 @ 的字符：${basenameOf(target.path)}`)
        const name = basenameOf(relative)
        references.push({
          source: 'reference',
          ref: mention,
          label: target.kind === 'directory' ? `${name}/` : name,
          appearance: target.kind === 'directory' ? 'folder' : 'file',
          clipboardText: mention,
        })
      }
      let applied = false
      try {
        applied = resolved.input.addFiles(references, []) === true
      } catch (cause) {
        throw new Error(messageOf(cause))
      }
      if (!applied) throw new Error('输入框正忙（正在提交），稍后再试')
      try {
        // 焦点交回输入框，用户可以直接接着写字；拿不到焦点不影响已经插进去的芯片。
        resolved.input.focus()
      } catch (ignored) {
        /* 焦点是锦上添花，不因为拿不到就报失败 */
      }
      return references.length > 1 ? `已 @ ${references.length} 项到对话` : `已 @ ${basenameOf(targets[0].path)} 到对话`
    }

    /* -------------------------------------------------------------- 菜单项 */

    /** 分隔线。 */
    const SEPARATOR = { id: 'separator', separator: true }

    /** 删除项的文案：单项就是「删除」，多项带上数量，免得看不出会删几个。 */
    function deleteLabel(count) {
      return count > 1 ? `删除 ${count} 项` : '删除'
    }

    /** 复制路径项：多项时复制多行。 */
    function copyItem(targets) {
      const paths = targets.map((target) => target.path)
      return {
        id: 'copy-path',
        label: paths.length > 1 ? `复制 ${paths.length} 个路径` : '复制路径',
        run: () => copyText(paths.join('\n')),
      }
    }

    /**
     * 「@ 到对话」项：把选中的文件/文件夹作为引用芯片放进当前对话的输入框。
     * 多项时一次插多个芯片（官方 `addFiles` 本来就收一个批次）。
     * @param root - 工作区根。
     * @param targets - 作用目标。
     */
    function mentionItem(root, targets) {
      return {
        id: 'mention',
        label: targets.length > 1 ? `@ 到对话（${targets.length} 项）` : '@ 到对话',
        run: () => mentionIntoComposer(root, targets),
      }
    }

    /**
     * 文件行菜单。
     * @param root - 工作区根。
     * @param targets - 作用目标。
     */
    function fileItems(root, targets) {
      const items = []
      // 多选时不提供下载：那要连发 N 次导航，浏览器多半会拦，不如不给。
      if (targets.length === 1) items.push({ id: 'download', label: '下载', run: () => downloadFile(root, targets[0].path) })
      items.push(mentionItem(root, targets))
      items.push(copyItem(targets))
      items.push(SEPARATOR)
      items.push({ id: 'delete', label: deleteLabel(targets.length), danger: true, run: () => confirmDelete(root, targets) })
      return items
    }

    /**
     * 文件夹行菜单。多选时不提供上传（一次只能传进一个目录）。
     * @param root - 工作区根。
     * @param targets - 作用目标。
     */
    function directoryItems(root, targets) {
      const items = []
      if (targets.length === 1) items.push({ id: 'upload', label: '上传文件到此处…', run: () => pickUpload(root, targets[0].path) })
      items.push(mentionItem(root, targets))
      items.push(copyItem(targets))
      items.push(SEPARATOR)
      items.push({ id: 'delete', label: deleteLabel(targets.length), danger: true, run: () => confirmDelete(root, targets) })
      return items
    }

    /**
     * 空白处菜单：作用对象是「所在的这一层目录」，外加选择相关的操作。
     * @param tree - 树根元素。
     * @param root - 工作区根。
     * @param dir - 空白所属目录。
     */
    function blankItems(tree, root, dir) {
      const items = [
        { id: 'upload', label: '上传文件到此处…', run: () => pickUpload(root, dir) },
        { id: 'copy-path', label: '复制路径', run: () => copyText(dir) },
        { id: 'refresh', label: '刷新大小与日期', run: () => { syncAll(true); return '' } },
        SEPARATOR,
        {
          id: 'select-all',
          label: '全选可见项',
          run: () => {
            const count = selectAllVisible(tree)
            return count === 0 ? '' : `已选择 ${count} 项`
          },
        },
      ]
      if (selection.paths.size > 0) {
        items.push({
          id: 'clear-selection',
          label: `清除选择（${selection.paths.size} 项）`,
          run: () => { clearSelection(); return '' },
        })
        items.push(SEPARATOR)
        items.push({
          id: 'delete',
          label: deleteLabel(selection.paths.size),
          danger: true,
          run: () => confirmDelete(root, targetsFor(tree, null)),
        })
      }
      return items
    }

    /* ------------------------------------------------------------ 删除流程 */

    /**
     * 一句话描述「这一项是什么」——确认框里每行右侧那一小段。
     * @param target - { path, kind }。
     * @returns 描述文本。
     */
    function describeTarget(target) {
      const entry = entryCache.get(target.path)
      const isDirectory = target.kind === 'directory' || entry?.type === 'directory'
      if (isDirectory) {
        const count = typeof entry?.childCount === 'number' ? `，第一级 ${entry.childCount} 项` : ''
        return `文件夹（含全部内容${count}）`
      }
      const size = formatSize(entry?.size)
      return size === '' ? '文件' : `文件 · ${size}`
    }

    /**
     * 弹二次确认框。删除是破坏性操作，所以确认框必须把「删哪些、是什么」摆清楚，
     * 而不是一句「确定删除吗」。
     *
     * 默认动作是**移到回收站**（可还原）；「永久删除」藏在一个**默认不勾**的复选框后面，
     * 勾上后标题、正文、按钮文案一起变，避免手滑点到不可恢复的那条路。
     * @param root - 工作区根。
     * @param targets - { path, kind } 列表。
     */
    function confirmDelete(root, targets) {
      if (targets.length === 0) return
      const count = targets.length
      openDialog({
        title: '删除确认',
        message: `将把以下 ${count} 项移到回收站（可从回收站还原）：`,
        items: targets.map((target) => ({
          path: target.path,
          name: basenameOf(target.path),
          detail: describeTarget(target),
        })),
        confirmLabel: count > 1 ? `移到回收站 ${count} 项` : '移到回收站',
        check: {
          label: '永久删除（不进回收站，无法恢复）',
          message: `将永久删除以下 ${count} 项，删除后无法从回收站恢复：`,
          confirmLabel: count > 1 ? `永久删除 ${count} 项` : '永久删除',
        },
        onConfirm: (permanent) => removeEntries(root, targets, permanent),
      })
    }

    /**
     * 执行删除：一次 RPC 删一批，逐条结算。
     * @param root - 工作区根。
     * @param targets - { path } 列表。
     * @param permanent - true 走 fs.rm（不可恢复）；否则走回收站。
     * @returns 空串（进度与结果都由这里自己弹提示）。
     */
    async function removeEntries(root, targets, permanent) {
      showToast(
        permanent ? `正在永久删除 ${targets.length} 项…` : `正在移到回收站 ${targets.length} 项…`,
        'progress',
        { sticky: true },
      )
      const value = await call('remove', { root, paths: targets.map((target) => target.path), permanent: permanent === true })
      const results = Array.isArray(value?.results) ? value.results : []
      const failed = results.filter((result) => result.ok !== true)
      for (const target of targets) entryCache.delete(target.path)
      clearSelection()
      refreshTrees(root)
      const verb = value?.mode === 'permanent' ? '永久删除' : '移到回收站'
      if (failed.length === 0) showToast(`已${verb} ${results.length} 项`, 'ok')
      else {
        showToast(
          `${verb}完成 ${results.length - failed.length} 项，失败 ${failed.length} 项\n`
          + failed.map((result) => `${basenameOf(result.path)}：${result.message ?? result.error ?? '未知原因'}`).join('\n'),
          'error',
        )
      }
      return ''
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
      const rowElement = rowElementOf(li)
      const onRow = rowElement !== null && (element === rowElement || rowElement.contains(element))
      if (onRow) {
        const path = li.getAttribute('data-files-path') ?? ''
        if (path === '') return
        const targets = targetsFor(tree, path)
        const isDirectory = li.getAttribute('data-files-entry') === 'directory'
        openMenu({
          x: event.clientX,
          y: event.clientY,
          title: targets.length > 1 ? `已选 ${targets.length} 项` : basenameOf(path),
          items: isDirectory ? directoryItems(root, targets) : fileItems(root, targets),
        })
        return
      }
      // 空白处：先看落点在哪个已展开目录的子列表里，找不到就归工作区根。
      const owner = li !== null && li.getAttribute('data-files-entry') === 'directory' ? li : element.closest('li[data-files-entry="directory"]')
      const dir = owner !== null ? (owner.getAttribute('data-files-path') ?? root) : root
      openMenu({ x: event.clientX, y: event.clientY, title: basenameOf(dir) || dir, items: blankItems(tree, root, dir) })
    }

    /**
     * 单击（捕获阶段，先于 React 的根监听器）。
     *
     * 带修饰键的单击是「选择」，必须**拦下官方行为**（否则 Ctrl 点文件会顺手打开它、
     * Ctrl 点目录会顺手展开）—— 所以这里 `preventDefault` + `stopPropagation`。
     * 不带修饰键的单击只是清空选择，然后原样放行。
     * @param event - click 事件。
     */
    function onTreeClickCapture(event) {
      if (event.button !== 0) return
      const element = event.target
      if (!(element instanceof Element)) return
      const tree = element.closest(TREE_SELECTOR)
      if (tree === null) return
      const li = element.closest(ROW_SELECTOR)
      const rowElement = rowElementOf(li)
      const onRow = rowElement !== null && (element === rowElement || rowElement.contains(element))
      if (!onRow) {
        // 点空白：只清选择，不拦事件（目录的展开/收起本来是点头部那一行触发的）。
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) clearSelection()
        return
      }
      const path = li.getAttribute('data-files-path') ?? ''
      if (path === '') return
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        event.stopPropagation()
        toggleSelection(tree, path)
        return
      }
      if (event.shiftKey && selection.tree === tree && selection.anchor !== null) {
        event.preventDefault()
        event.stopPropagation()
        extendSelection(tree, path)
        return
      }
      clearSelection()
      // 锚点仍要记下来：接下来的 Shift+单击才有起点（和资源管理器一致）。
      selection.tree = tree
      selection.anchor = path
    }

    /**
     * 双击：官方用它打开文件，这里顺手把选择清掉，避免「打开了一个文件、
     * 侧栏还留着几个高亮的行」这种会让人误判的残留状态。
     */
    function onTreeDoubleClick() {
      clearSelection()
    }

    /** 点空白处（菜单外）关菜单。 */
    function onDocumentMouseDown(event) {
      if (snapshot.menu === null) return
      const element = event.target
      if (element instanceof Element && element.closest('.dsh-fx-menu') !== null) return
      closeMenu()
    }

    /**
     * Esc 分层收：确认框 → 右键菜单 → 选择。一次只收一层，符合「按一下退一步」的直觉。
     * @param event - keydown 事件。
     */
    function onKeyDown(event) {
      if (event.key !== 'Escape') return
      if (snapshot.dialog !== null) {
        cancelDialog()
        return
      }
      if (snapshot.menu !== null) {
        closeMenu()
        return
      }
      clearSelection()
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
      menu.items.map((item, index) => (
        item.separator === true
          ? h('div', { key: `${item.id}-${index}`, className: 'dsh-fx-menu-sep' })
          : h('button', {
            key: `${item.id}-${index}`,
            type: 'button',
            role: 'menuitem',
            className: 'dsh-fx-menu-item',
            'data-danger': item.danger === true ? 'true' : undefined,
            title: item.label,
            onClick: () => { void runItem(item) },
          }, item.label)
      )))
    }

    /** 确认框里最多逐条列出多少项，超出折成一行「还有 N 项」。 */
    const DIALOG_LIST_LIMIT = 50

    /**
     * 二次确认框。
     *
     * 焦点默认落在「取消」上 —— 破坏性操作不该让回车顺手确认掉。
     * `dialog.check` 存在时多一行复选框（默认**不勾**）：勾上后标题之外的正文、按钮文案、
     * 按钮语气一起变，用户看到的永远是他真正要执行的那件事。
     * @param props - { dialog }。
     */
    function DialogView({ dialog }) {
      const cancelRef = React.useRef(null)
      const [checked, setChecked] = React.useState(false)
      React.useEffect(() => {
        if (cancelRef.current !== null) cancelRef.current.focus()
      }, [dialog])
      const check = dialog.check
      const armed = check !== undefined && checked === true
      const shown = dialog.items.slice(0, DIALOG_LIST_LIMIT)
      const rest = dialog.items.length - shown.length
      return h('div', {
        className: 'dsh-fx-backdrop',
        // 点遮罩 = 取消；点框体本身不冒泡到这里。
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) cancelDialog()
        },
      }, h('div', { className: 'dsh-fx-dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('div', { className: 'dsh-fx-dialog-title' }, dialog.title),
        h('p', { className: 'dsh-fx-dialog-message' }, armed ? check.message : dialog.message),
        h('ul', { className: 'dsh-fx-dialog-list' },
          shown.map((item) => h('li', { key: item.path, className: 'dsh-fx-dialog-item', title: item.path },
            h('span', { className: 'dsh-fx-dialog-name' }, item.name),
            h('span', { className: 'dsh-fx-dialog-kind' }, item.detail))),
          rest > 0 ? h('li', { className: 'dsh-fx-dialog-more' }, `…还有 ${rest} 项`) : null),
        check === undefined ? null : h('label', { className: 'dsh-fx-check' },
          h('input', {
            type: 'checkbox',
            checked,
            onChange: (event) => setChecked(event.target.checked),
          }),
          h('span', null, check.label)),
        h('div', { className: 'dsh-fx-dialog-actions' },
          h('button', {
            ref: cancelRef,
            type: 'button',
            className: 'dsh-fx-btn',
            onClick: () => cancelDialog(),
          }, '取消'),
          h('button', {
            type: 'button',
            className: 'dsh-fx-btn',
            'data-variant': armed ? 'danger' : 'primary',
            onClick: () => { void runDialog(armed) },
          }, armed ? check.confirmLabel : dialog.confirmLabel))))
    }

    /** 短暂提示条。 */
    function ToastView({ toast }) {
      return h('div', { className: 'dsh-fx-toast', 'data-kind': toast.kind, role: 'status' }, toast.text)
    }

    /** `shell.overlay` 的占位：什么都没有时返回 null，浮层保持穿透。 */
    function Overlay() {
      const state = React.useSyncExternalStore(subscribeStore, getSnapshot)
      if (state.menu === null && state.dialog === null && state.toast === null) return null
      return h(React.Fragment, null,
        state.dialog === null ? null : h(DialogView, { key: `dialog-${state.dialog.id}`, dialog: state.dialog }),
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
      document.addEventListener('click', onTreeClickCapture, true)
      document.addEventListener('dblclick', onTreeDoubleClick, true)
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
      document.removeEventListener('click', onTreeClickCapture, true)
      document.removeEventListener('dblclick', onTreeDoubleClick, true)
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
      entryCache.clear()
      clearSelection()
      if (styleElement !== null) styleElement.remove()
      styleElement = null
      clearMarks()
      publish({ menu: null, dialog: null, toast: null })
    }

    /* ---------------------------------------------------------------- 入口 */

    /** 浏览器半区必需的 Cordis 服务：slots 挂浮层菜单，connection 调 host 通道。 */
    const inject = ['slots', 'connection']

    /**
     * @param ctx - 客户端根 context。
     */
    function apply(ctx) {
      callChannel = (channel, endpoint, payload) => ctx.connection.rpc.call(channel, endpoint, payload)
      clientCtx = ctx

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
