# dsh-file-extras

DSH Web GUI 的**日常操作增强**插件。主体是在官方「文件」页（`@deepseek-ai/dsh-client-ui-sidebar-files`）上补右键菜单、行内元数据、多选与删除；另外收了两件与文件树无关、但同样天天要用的能力：**文件驱动的斜杠命令**与**输入框 ↑/↓ 历史指令回填**。

| 需求 | 现在的行为 |
| --- | --- |
| 覆盖默认浏览器右键菜单 | 在文件树内右键弹出自己的菜单（树外一律不接管，浏览器默认菜单照旧） |
| 文件右键 | **下载** / **@ 到对话** / **复制路径** / **删除** |
| 文件夹右键 | **上传文件到此处…** / **@ 到对话** / **复制路径** / **删除** |
| 空白处右键 | **上传文件到此处…** / **复制路径** / **刷新大小与日期** / **全选可见项**（有选择时再加 **清除选择** 与 **删除 N 项**） |
| 文件大小 + 修改日期 | 行尾显示 `1.2 KB · 2026-03-04 13:06:07`，按字节自动选单位（B/KB/MB/GB/TB/PB，1024 进制） |
| 文件夹大小 + 修改日期 | 行尾显示 `3 项 · 2026-03-04 13:06:07`；**只数第一级子级**（`readdir` 一层，不递归） |
| 删除（文件夹 / 单文件 / 多文件） | 走 **二次确认框**（列出每一项是什么、多大、文件夹含多少内容）；默认**移到回收站**（可还原），「永久删除」藏在默认不勾的复选框后面 |
| @ 到对话（文件 / 文件夹） | 直接在当前对话的输入框里插一枚 `@` 引用芯片，和用户自己敲 `@` 选出来的是**同一种东西** |
| 斜杠快速命令 | `~/.dsh/commands/*.md` 一个文件一条 `/命令`，正文可带 `$ARGUMENTS` 占位符；改文件立即生效 |
| ↑/↓ 快速切换历史指令 | 输入框里按 `↑`/`↓` 像终端一样翻出**本会话自己敲过的**指令，`Esc` 退出 |

## 斜杠快速命令

`~/.dsh/commands/<名字>.md` 一个文件一条**全局**斜杠命令，命令名就是去掉 `.md` 的文件名
（文法与注册表逐字一致：`/^[a-z][a-z0-9_-]*$/`）。

```markdown
---
description: 审查当前工作区的代码改动
input-hint: 可选的补充说明
---

请审查当前工作区的代码改动，重点关注潜在 bug 和安全问题。

$ARGUMENTS
```

| 行为 | 说明 |
| --- | --- |
| frontmatter | 读 `description`（发现界面里的说明）与 `input-hint`（输入提示），其余键忽略但容忍 |
| `$ARGUMENTS` | 换成用户敲在命令名后面的原始参数；没有这个占位符时正文原样发出 |
| 改文件立即生效 | 正文是**每次调用时**重新读盘的，不用重启 |
| 新增 / 删除文件 | 需要重启 `dsh web` 才反映（注册是启动时扫一遍目录） |
| 执行结果 | 正文作为一条**普通用户消息**交给 agent —— 与用户自己把这段话敲进输入框等价，不是系统注入 |

用的是官方 `ctx.commands.register()`（`@deepseek-ai/dsh-commands`），所以发现、补全、
`command/run` / `command/done` 生命周期事件全归官方。与 app 级命令（`/goal` 之类）重名时
**只跳过这一条并告警**，不会把其余命令一起带走。

> 这条能力移植自 [dsh-command-md](https://github.com/TiChuXiXi/dsh-command-md)（同一作者，MIT）。

## ↑/↓ 快速切换历史指令

在输入框里按 `↑` 翻出本会话里自己敲过的指令，再按 `↑` 往更早走，`↓` 往新的走。
第一次 `↑` 时当前草稿会存起来，一路 `↓` 翻回最新一条之后再按 `↓`（或按 `Esc`）就原样还回来。
穿梭时输入框上方有一条 `历史指令 … ↑↓ 3/12 · Esc 退出` 的提示条。

| 键 | 接管条件 | 行为 |
| --- | --- | --- |
| `↑` | 光标已贴在草稿**最开头**（或草稿为空） | 进入穿梭 / 往更早一条 |
| `↓` | 只在穿梭模式里 | 往新一条；已是最新时还回原草稿并退出 |
| `Esc` | 只在穿梭模式里 | 还回原草稿并退出 |
| 任何真实输入 | 只在穿梭模式里 | 立即退出穿梭（`beforeinput`：打字 / 退格 / 粘贴 / 拖入 / 输入法） |
| `/`、`@` 候选菜单开着时 | —— | **一律不抢键**（那里 `↑`/`↓` 是选候选） |

数据**不是**从聊天视图里抠的（那里只有已加载的一窗），而是走 host 半区的 RPC `history`：
它读 `ctx.sessionQuery.readSession()` 的**完整事件日志**，只挑 `source.kind === 'user'` 的真实用户指令
—— 所以「更早」那些也在，而 AGENTS.md、技能目录、定时提醒这类 `agent.inject()` 塞进去的系统上下文不在。
（实测一个真实会话：38 条 `user/message` 里只有 11 条 kind 是 `user`，其余 27 条是
`time-context` / `runtime-context` / `skill-catalog` / `agent-instructions` / `compact-checkpoint` / `user-approval`。）

回填用官方 `inputActions.setDraft()` 整条替换草稿：不碰编辑器内部，不自己实现输入框。
host 通道取不到历史时 `↑`/`↓` **完全不接管** —— 宁可这个功能静默失效，也不能让用户觉得键盘坏了。

> 这条能力移植自 [dsh-message-jump](https://github.com/TiChuXiXi/dsh-message-jump) 的
> 「输入框 ↑/↓ 历史消息穿梭」（同一作者，MIT）；该插件另一半的悬浮指令导航条**没有**收进来。

## @ 到对话

右键文件或文件夹 → **@ 到对话**，该路径就以引用芯片的形式进入当前对话的输入框（多选时一次插一批）。
**只插入、不发送** —— 后面还要接着写字，替你按发送键是越权。

这里**没有**重新实现「对话里 @ 文件」：

- 芯片交给官方会话自己的编辑器插（`ctx.conversation.input.for(actx).addFiles(...)`，
  和把文件拖进输入框走的是**同一条路**），所以序列化（模型看到的文本）、点击芯片在右侧栏预览、
  草稿持久化、发送时展开，全部沿用官方行为；
- 提及文本逐字复刻官方 `@` 补全的语法（`@deepseek-ai/dsh-file-reference` 的 `formatFileMention`）：
  `@src/index.ts`、目录 `@src/`、含空格 `@"my notes.txt"`、含空格的目录 `@"my docs/`（引号故意不闭合，官方语法如此）；
- 路径按「相对会话工作区根 + 正斜杠」给（官方候选就是这个形式，模型也按这个解析）。
  会话工作区与树根不一致时退回绝对路径，不硬拼一个错的相对路径。

「当前对话」取 `ctx.sidebarRight.mounted` —— 官方对「主栏正在显示哪个会话」唯一的公开可观察量，
文件树本身也是按这个会话渲染的。拿不到会话、会话没被 retain、输入框正忙（正在提交）时都**明确报错**，不静默失败。


## 多选怎么用

官方那棵树没有多选，本插件自己实现了一套，规矩和资源管理器一致：

| 操作 | 效果 |
| --- | --- |
| 普通单击 | 清空选择（并放行官方行为：文件打开、目录展开） |
| `Ctrl` / `⌘` + 单击 | 切换这一行的选中态（**拦下**官方行为，不会顺手打开文件或展开目录） |
| `Shift` + 单击 | 从锚点行到这一行整段选中（按可见行的 DOM 顺序） |
| 空白处单击 | 清空选择 |
| 空白处右键 → 全选可见项 | 一次选中当前树里所有可见行 |
| `Esc` | 分层收：确认框 → 右键菜单 → 选择 |

选中态是**填色 + 一圈内描边**（只填色会跟 `:hover` 撞成一样）。右键落在已选中的行上时，菜单作用整个选择
（标题变成 `已选 N 项`，删除项变成 `删除 N 项`，多选时不再提供只能作用于单项的下载/上传）；
右键落在没选中的行上则把选择换成那一行 —— 不会出现「看着选中了 5 个，结果只删了右键的那一个」。

## 为什么需要 host 半区

官方文件树的数据来自 `workspaceFiles` Remote 命名空间，它的类型面里**只有 size，没有修改时间**
（`WorkspaceDirectoryListing.entries[].size` / `WorkspaceFileStat.bytes`；`version` 是不透明令牌，
契约上明令 *never parsed*）。所以 mtime 只能由插件自己从 host 侧取。

host 半区在 `ctx.webServer` 上挂一条前缀路由 `/dsh-file-extras`：

- `POST /dsh-file-extras/stat` —— Connection RPC 信封，批量取 大小 / mtime / 一级子项数量；
- `POST /dsh-file-extras/history` —— 某个会话里真实用户指令的全文列表（↑/↓ 回填的数据源）；
- `GET  /dsh-file-extras/download?root=&path=` —— 流式回文件字节 + `Content-Disposition`；
- `POST /dsh-file-extras/upload?root=&dir=&name=` —— 请求体即原始字节，写进目标目录；
- `POST /dsh-file-extras/remove` —— 删除（RPC 信封），默认移入回收站，逐条独立结算。

浏览器的右键菜单注册进 `shell.overlay`（框架级浮层，本来就在每一列之上、滚动容器之外），
历史回填提示条注册进 `conversation.input.dock`（输入框卡片上方那条整宽座位）。
斜杠命令与这两者都无关，走官方 `ctx.commands.register()`，不经过本插件的通道。

## 文件

| 文件 | 作用 |
| --- | --- |
| [index.js](index.js) | host 半区：`/dsh-file-extras` 前缀路由（RPC `stat` / `history` / `remove`、`GET download`、`POST upload`）+ 扫描 `~/.dsh/commands/*.md` 注册斜杠命令 |
| [lib/commands-md.js](lib/commands-md.js) | 命令文件的纯解析层：frontmatter、`$ARGUMENTS`、目录扫描（零依赖，可脱离 DSH 单测） |
| [lib/trash.js](lib/trash.js) | 跨平台「移入回收站」：Windows / Linux / macOS 三套后端；平台与家目录可注入，所以三套逻辑能在任意一台机器上实测 |
| [lib/client.js](lib/client.js) | 浏览器半区：行内元数据 + 多选 + 右键菜单 + 删除确认框 + @ 到对话（`shell.overlay`）+ ↑/↓ 历史回填（`conversation.input.dock`） |
| [cordis.patch.yml](cordis.patch.yml) | loader 行（`inject: [webServer, connection]`） |
| [package.json](package.json) | `dsh.bundle` + `dsh.client` |
| [scripts/selftest.mjs](scripts/selftest.mjs) / [scripts/dom-probe.mjs](scripts/dom-probe.mjs) / [scripts/trash-bin.mjs](scripts/trash-bin.mjs) | 两层自检 + 回收站测试清理助手 |

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
- 上传先写同目录 `.part-<uuid>` 再原子 rename，中途失败/超限不会在工作区留下半个「看起来正常」的文件；
- **两端都不设文件大小上限**：下载是磁盘→socket 的流式传输，上传是请求流→磁盘，host 内存占用与文件大小无关。上传只在 `content-length` 明显失控（>4 GiB）时提前挡掉。
- **删除默认进回收站，跨平台三套后端**（[lib/trash.js](lib/trash.js)）：
  Windows 走 Shell 的 `SHFileOperation`（PowerShell 5.1 + `Microsoft.VisualBasic`），
  Linux 走 freedesktop Trash 规范（`~/.local/share/Trash/{files,info}`），macOS 走 `~/.Trash`。
  回收站不可用时**报错**，绝不静默降级成永久删除 —— 用户自己勾「永久删除」才走 `fs.rm`。
- 删除的安全边界：浏览器侧必须过二次确认框；host 侧拒绝工作区**根自己**、拒绝区外路径；
  软链接按「链接本身」处理，绝不跟随到区外去递归删目标（`checkEntry` 按目录项判定包含关系）。
  Windows 上软链接**不进回收站**（`DeleteDirectory` 会顺着联接点递归），直接 `fs.rm`；
  POSIX 上 `rename` 只搬链接本身，所以照常进回收站。
- 一批里有一个删不掉（被占用、权限不足、回收站拒收）只影响它自己，失败原因按条回给用户。

## 实现要点（改代码前先读）

- **不往 React 管的元素里插子节点**。大小/日期写进行元素自己的 `data-fx-meta` 属性，
  文本靠 CSS `::after { content: attr(data-fx-meta) }` 渲染。React 只 diff 它 props 里出现过的属性，
  不认识的属性既不写也不删，所以标记不会被 reconciliation 抹掉。
- **窄栏自动换行**。完整时间戳约 145px，单行放不下时（<320px）由 `ResizeObserver` 给树根打上
  `data-fx-narrow`，时间戳换到名字下面一行 —— 宁可换行也不截断时间戳。
  属性写入放在 `requestAnimationFrame` 里：换行会让行变高，直接在观察回调里改会触发
  `ResizeObserver loop completed with undelivered notifications`。
- **错误状态码分两套**。RPC 端点失败也回 `200` + 错误信封（`rpc.call` 把非 2xx 当传输失败，
  读不到信封里的错误码）；`download` / `upload` 是字节通道，失败回真正的 `4xx`。
- **大文件不要经过 JS 内存**。下载刻意**不用** `fetch` + `response.blob()`：那个写法要等整个文件
  传完、并在页面里拼出一份完整副本之后 promise 才 resolve，大文件于是「点下去很久没反应」，
  还要吃掉同等内存、最后再从内存写一遍盘。现在改成 `stat` 预检（毫秒级，失败能说清原因）+
  `<a download>` 原生导航（字节由 host 直接流到磁盘，立即开始、内存零拷贝、无大小上限）。
  上传同理：进度提示在传输开始前就弹出来，host 侧边收边写。
- **「@ 到对话」用的是官方输入框，不是自建通道**。芯片由会话自己的 Lexical 编辑器插
  （`ctx.conversation.input.for(actx).addFiles(refs, [])`），本插件只做两件事：
  从文件树里认出用户点了哪个路径、拼出和官方 `@` 补全逐字一致的提及文本。
  提及语法（引号规则、目录尾斜杠）是 `formatFileMention` 的复刻 —— 改它之前先对照
  `@deepseek-ai/dsh-file-reference` 的 grammar，**一个字都不能差**：差一个引号，模型就会把带空格的路径拆成两段。
- **`history` 只认 `source.kind === 'user'`**。事件日志里 user 角色的消息有两大类：人工输入 /
  steering，以及 `agent.inject()` 塞进去的系统上下文。后者的 `source.kind` 各自不同
  —— 实测一个真实会话（38 条 `user/message`）里出现过 `time-context` / `runtime-context` /
  `skill-catalog` / `agent-instructions` / `compact-checkpoint` / `user-approval`，
  只有人工输入的 kind 恰好是 `'user'`（11 条）。判断写的是「等于 `user`」而不是「不等于某某」，
  所以上游再加新的注入类型也漏不进来。
  斜杠命令的 handler 也正因此才用 `createUserMessage({ source: { kind: 'user' } })` 而不是
  `agent.inject()` —— 那样它才会被当成「用户敲的指令」进历史。
- **`↑`/`↓` 只在能安全接管时才接管**。编辑器是 Lexical 的 `contenteditable`（不是 textarea），
  所以 `↑` 只在光标贴最开头时抢，`↓` 只在穿梭模式里抢，候选菜单开着时一律不抢；
  事件监听挂在 `document` 的**捕获阶段** + `stopImmediatePropagation()`，才能先于 Lexical 的
  root 监听和 React 的委托监听。退出穿梭靠原生 `beforeinput`（Lexical 的程序化 `setDraft`
  不触发它，所以回填本身不会被误判成用户编辑）。
- **斜杠命令用官方注册表，`@deepseek-ai/dsh-llm` 是动态 import**。这个包只在 DSH 自己的
  node_modules 里，从第三方插件目录不一定解析得到；拿不到就**只让这一条命令回 error**，
  不自己拼一个假的 `UserMessage`（那会绕过官方的 id / 冻结 / source 约定）。
  同理，命令目录优先走官方的 `@deepseek-ai/dsh-home-paths`（认 `$DSH_HOME`），拿不到时按同一套优先级自己算。
- **回收站不是文件系统特性，是 Shell 特性**。`fs.rm` / `unlink` / `rmdir` 落到内核的删除原语，
  删掉就是删掉；真正「移入回收站」的在 Windows 上是 `SHFileOperation`（要在
  `<卷>:\$Recycle.Bin\<SID>\` 下写一对 `$I`（元数据）+ `$R`（数据）文件并登记进用户回收站索引，
  手工挪文件进去没用 —— 没有 `$I` 边车，资源管理器列不出来也还原不了），在 Linux 上是
  freedesktop Trash 规范，在 macOS 上就是 `~/.Trash`。三套机制 Node 一个都不提供，
  所以 [lib/trash.js](lib/trash.js) 自己实现：Windows 外包给 PowerShell 5.1 的
  `Microsoft.VisualBasic.FileIO.FileSystem`（内部就是 `SHFileOperation`），
  Linux / macOS 直接按协议搬目录、写 `.trashinfo`。

## 自检

```powershell
node scripts/selftest.mjs                  # host 半区：假 ctx/req/res 驱动路由，47 个用例（真文件系统 + 三套回收站后端 + 命令文件解析）
node scripts/dom-probe.mjs                 # 浏览器半区：headless Chrome 里跑真实 lib/client.js，83 条断言
node scripts/dom-probe.mjs --shot out/     # 同上，另存浅色（多选+菜单）与深色（删除确认框）两张截图
```

`selftest.mjs` 里 Linux / macOS 两条回收站后端是**注入平台与家目录**后真跑的（不是 mock）：
在 Windows 上把文件搬进一个假的 `~/.local/share/Trash`，再逐字校验 `files/` 落盘、
`info/*.trashinfo` 的 `Path=` 能还原原路径、`DeletionDate` 格式、以及同名让位成 `<名字>.2`。
测试往真回收站扔的东西由 [scripts/trash-bin.mjs](scripts/trash-bin.mjs) 按快照差集清干净。

`dom-probe.mjs` 会把完整结果写到 `.npm-cache/domprobe/last-result.json`，断言消息只留 300 字摘要。
复选框那几步走的是 CDP 的真实鼠标事件（合成事件驱动不了 checkbox 的激活行为，详见脚本内注释）。

> `selftest.mjs` 里「handler 把正文当用户消息交给 agent」那一条需要解析到
> `@deepseek-ai/dsh-llm`（只有装到 profile 之后才在 node_modules 链上）。
> 工作区里解析不到时会打印一行提示并只断言降级行为 —— 想在本地跑全，把 DSH 的
> `@deepseek-ai` 挂到工作区的 `node_modules/` 下即可（该目录已 gitignore）。

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
- **「@ 到对话」比其余功能多依赖三个客户端服务**（`conversation` / `sessions` / `sidebarRight`），
  而这三个没有声明在 `dsh.client.inject` 里 —— 刻意如此：它们是**点击那一刻**才去 `ctx.get()` 的，
  缺一个只会让这一项报错，不会让整个插件（元数据、菜单、删除）起不来。
  上游若改了 `input.for()` / `addFiles()` 的形状，这里也会**明确报错**而不是静默插入失败。
- 元数据每 15 秒后台重取一次（仅页面可见时）。文件在会话里被反复改写、行节点又被 React 复用，
  不重取就会一直显示旧值。
- 「刷新」按的是官方的重载按钮（`data-files-reload`），不自己维护目录状态。
- 选择状态由本插件维护（行元素上的 `data-fx-selected` 属性是唯一真相），每次同步按 DOM 里实际还在的行剪枝：
  折叠、刷新、删掉的行会自动掉出选择。
- **回收站的平台差异**：手工把文件挪进 macOS 的 `~/.Trash` 不会写 Finder 的「放回原处」元数据
  （那在 `.DS_Store` 里，只有 Finder 自己写），所以文件能还原、但「放回原处」不可用。
  Linux 跨卷时会用该卷根下的 `.Trash/<uid>` 或 `.Trash-<uid>`（规范要求）。
  回收站被系统关掉、或条目超过回收站配额时，**Windows / macOS 自己会改成永久删除** —— 那是系统的行为，插件无法区分。
- 没有回收站后端的平台（FreeBSD 等）会明确回 `file-extras/trash-unavailable`，
  确认框里勾「永久删除」仍可继续。
- **斜杠命令是启动时扫一遍目录**：改已有文件的正文立即生效（每次调用重新读盘），
  但新增 / 删除 / 改名 `.md` 文件要重启 `dsh web` 才反映。
- **`history` 依赖 `ctx.sessionQuery`**（`dsh-base` 里的 `session-query-sqlite` 提供）。
  缺席时该端点回 `file-extras/history-unavailable`，浏览器侧 `↑`/`↓` 完全不接管，
  文件树那部分功能不受任何影响。
- **`history` 只回最近 300 条、单条截 20000 字符**：回填到输入框用，不做无上限搬运。
- 本插件把 `conversation` / `sessions` / `sidebarRight` / `commands` / `sessionQuery` 全部
  **懒取**（`ctx.get(...)`）而不是写进 `inject`：任何一项缺席都只让对应功能降级或报错，
  不会把整个插件挡在门外。
