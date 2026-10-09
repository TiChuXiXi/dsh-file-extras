# dsh-file-extras

DSH Web GUI 的**工作区文件树增强**插件：在官方「文件」页（`@deepseek-ai/dsh-client-ui-sidebar-files`）上补三件事。

| 需求 | 现在的行为 |
| --- | --- |
| 覆盖默认浏览器右键菜单 | 在文件树内右键弹出自己的菜单（树外一律不接管，浏览器默认菜单照旧） |
| 文件右键 | **下载** / **复制路径** |
| 文件夹右键 | **上传文件到此处…** / **复制路径** |
| 空白处右键 | **上传文件到此处…** / **复制路径** / **刷新大小与日期**（空白归属它所在的那层目录；根空白归工作区根） |
| 文件大小 + 修改日期 | 行尾显示 `1.2 KB · 2026-03-04 13:06:07`，按字节自动选单位（B/KB/MB/GB/TB/PB，1024 进制） |
| 文件夹大小 + 修改日期 | 行尾显示 `3 项 · 2026-03-04 13:06:07`；**只数第一级子级**（`readdir` 一层，不递归） |

## 为什么需要 host 半区

官方文件树的数据来自 `workspaceFiles` Remote 命名空间，它的类型面里**只有 size，没有修改时间**
（`WorkspaceDirectoryListing.entries[].size` / `WorkspaceFileStat.bytes`；`version` 是不透明令牌，
契约上明令 *never parsed*）。所以 mtime 只能由插件自己从 host 侧取。

host 半区在 `ctx.webServer` 上挂一条前缀路由 `/dsh-file-extras`：

- `POST /dsh-file-extras/stat` —— Connection RPC 信封，批量取 大小 / mtime / 一级子项数量；
- `GET  /dsh-file-extras/download?root=&path=` —— 流式回文件字节 + `Content-Disposition`；
- `POST /dsh-file-extras/upload?root=&dir=&name=` —— 请求体即原始字节，写进目标目录。

浏览器的右键菜单注册进 `shell.overlay`（框架级浮层，本来就在每一列之上、滚动容器之外）。

## 安装

```powershell
dsh plugin --profile web add dsh-file-extras
```

或在会话里让 Agent 用 `plugin_manager` 的 `install_bundle` 指向本目录。
装完**刷新一次页面**（客户端 bundle 在插件激活时读入并缓存，改代码后需要重新激活才生效）。

## 配置

无（无 `Config` 字段、无运行时开关）。可调参数都在源码顶部的常量里，每个都带注释。

## 安全边界

- 路由复用 `connection.requestRejection()`：Host/Origin 检查 + 浏览器签名 cookie 认证，
  非本机页面与未认证请求拿不到任何数据；
- `root` 必须是绝对路径、存在、且**不是盘符/文件系统根**（否则「声明 root=C:\ 就能读全盘」）；
- 每个候选路径都做 realpath 后再比包含关系 —— 工作区内的软链接指向区外同样被拒（纯字符串前缀比对比不了这一层）；
- 上传只写**单段文件名**（`..\..\x` 会被压成 `x`），重名一律自动加序号 `name (1).ext`，**从不覆盖**已有文件；
- 下载上限 512 MiB、上传上限 256 MiB，超限回 `413` 而不是截断。

## 实现要点（改代码前先读）

- **不往 React 管的元素里插子节点**。大小/日期写进行元素自己的 `data-fx-meta` 属性，
  文本靠 CSS `::after { content: attr(data-fx-meta) }` 渲染。React 只 diff 它 props 里出现过的属性，
  不认识的属性既不写也不删，所以标记不会被 reconciliation 抹掉。
- **窄栏自动换行**。完整时间戳约 145px，单行放不下时（<320px）由 `ResizeObserver` 给树根打上
  `data-fx-narrow`，时间戳换到名字下面一行 —— 宁可换行也不截断时间戳。
  属性写入放在 `requestAnimationFrame` 里：换行会让行变高，直接在观察回调里改会触发
  `ResizeObserver loop completed with undelivered notifications`。
- **错误状态码分两套**。RPC 端点失败也回 `200` + 错误信封（`rpc.call` 把非 2xx 当传输失败，
  读不到信封里的错误码）；`download` / `upload` 是字节通道，失败回真正的 `4xx`，
  客户端按 `response.ok` 判；下载另外按 `content-type` 兜一层，避免把错误 JSON 存成文件。

## 自检

```powershell
node scripts/selftest.mjs                  # host 半区：假 ctx/req/res 驱动路由，18 个用例（真文件系统）
node scripts/dom-probe.mjs                 # 浏览器半区：headless Chrome 里跑真实 lib/client.js，35 条断言
node scripts/dom-probe.mjs --shot out/     # 同上，另存浅色/深色两张截图
```

`dom-probe.mjs` 需要 react/react-dom 的 UMD 构建：

```powershell
npm install --prefix .npm-cache/domprobe --cache .npm-cache --registry=https://registry.npmjs.org react@18.3.1 react-dom@18.3.1
```

沙箱会禁掉命名管道导致 Chrome 渲染进程 `FATAL platform_channel`，`dom-probe.mjs` 需要在
放宽权限（danger-full-access）下运行。

> 注意：`dom-probe.mjs` 测的是**照抄官方 DOM 契约的静态夹具页**，用来钉住本插件的 DOM 逻辑与几何，
> 它**不是**对运行中 DSH 页面的验证。真机效果需要在 DSH Web GUI 里刷新页面后目视确认。

## 已知取舍

- 增强落在官方树的 DOM 契约上（`data-files-state` / `data-files-root` / `data-files-entry` /
  `data-files-path` / `data-files-body` / `data-files-reload`）。这些属性是官方组件有意暴露的钩子，
  但如果上游改名，本插件会**静默失效**（找不到树就什么都不做，不会报错也不会弄坏页面）。
- 元数据每 15 秒后台重取一次（仅页面可见时）。文件在会话里被反复改写、行节点又被 React 复用，
  不重取就会一直显示旧值。
- 「刷新」按的是官方的重载按钮（`data-files-reload`），不自己维护目录状态。
