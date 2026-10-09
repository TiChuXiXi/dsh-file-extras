/**
 * 回收站的**测试专用**助手：给自检脚本做「用了就清干净」。
 *
 * 为什么能这么干：回收站就是每个卷上一个普通目录 `<盘>:\$Recycle.Bin\<用户 SID>\`，
 * 里面按条目放着一对文件 —— `$I<id>.<ext>`（元数据：原路径 + 删除时间）和
 * `$R<id>.<ext>`（数据本体）。删掉这一对，就等于把这条记录从回收站里拿掉
 * （资源管理器「从回收站删除」做的是同一件事）。
 *
 * 找「本次产生的那几条」用的是**快照差集**，而不是去解析 `$I` 的二进制格式：
 * 测试期间只有本进程在往回收站扔东西，差集就是本次的全部产物。
 *
 * 注意：这是测试脚手架，不是插件代码 —— 插件本身只通过 Shell 的 SHFileOperation 走回收站，
 * 永远不直接碰 `$Recycle.Bin`。
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join, parse as parsePath } from 'node:path'

/** 快照的私有标记：只有 {@link snapshotTrash} 造出来的 Set 才带它。 */
const SNAPSHOT = Symbol('trash-snapshot')

/** `<盘>:\$Recycle.Bin` —— 模板串会把 `$R` 当插值，所以这里用拼接。 */
function rootOf(drive) {
  return drive.endsWith('\\') ? `${drive}$Recycle.Bin` : `${drive}\\$Recycle.Bin`
}

/** 取路径所在卷的回收站根（`D:\a\b` → `D:\$Recycle.Bin`）。 */
export function trashRootFor(path) {
  return rootOf(parsePath(path).root)
}

/** 列出回收站根下各用户 SID 子目录（读不到的跳过，别人的 SID 目录本来也不该动）。 */
async function sidDirs(root) {
  const names = await readdir(root).catch(() => [])
  const dirs = []
  for (const name of names) {
    if (!name.startsWith('S-1-')) continue
    const full = join(root, name)
    if ((await stat(full).catch(() => undefined))?.isDirectory() === true) dirs.push(full)
  }
  return dirs
}

/**
 * 给回收站拍一张快照。
 * @param somePath - 卷内任意路径（用它的卷决定看哪个回收站）。
 * @returns {Promise<Set<string>>} 当前所有条目的绝对路径（带私有标记，供 {@link purgeTrash} 校验）。
 */
export async function snapshotTrash(somePath) {
  const files = new Set()
  const root = trashRootFor(somePath)
  for (const dir of await sidDirs(root)) {
    for (const name of await readdir(dir).catch(() => [])) files.add(join(dir, name))
  }
  // 非枚举标记：不会出现在 spread / JSON 里，但能让 purgeTrash 认得出「这是真快照」。
  Object.defineProperty(files, SNAPSHOT, { value: true, enumerable: false })
  return files
}

/**
 * 清掉快照之后新增的回收站条目。
 *
 * **必须传 {@link snapshotTrash} 的返回值**：空集或随手造的 Set 会被拒绝 ——
 * 传一个空集合进来等于「把整个回收站清空」，这种失误没有任何提示就不可逆了。
 * @param somePath - 卷内任意路径。
 * @param before - {@link snapshotTrash} 的结果。
 * @returns {Promise<number>} 实际删掉的条目文件数。
 */
export async function purgeTrash(somePath, before) {
  if (!(before instanceof Set) || before[SNAPSHOT] !== true) {
    throw new Error('purgeTrash 只接受 snapshotTrash() 的返回值：随手传一个 Set（尤其是空集）会把整个回收站清空')
  }
  let removed = 0
  const root = trashRootFor(somePath)
  for (const dir of await sidDirs(root)) {
    for (const name of await readdir(dir).catch(() => [])) {
      const full = join(dir, name)
      if (before.has(full)) continue
      // `$R…` 可能是个**目录**（Windows 回收文件夹时整棵搬进来），必须 recursive，
      // 否则会以 EISDIR 静默失败、在回收站里留下残骸。
      await rm(full, { recursive: true, force: true }).catch(() => undefined)
      removed += 1
    }
  }
  return removed
}

/**
 * 快照差集：本次操作在回收站里新增了哪些条目。
 * @param somePath - 卷内任意路径。
 * @param before - 之前的快照。
 * @returns {Promise<string[]>} 新增条目的文件名（`$I…` / `$R…`）。
 */
export async function addedTrashEntries(somePath, before) {
  const added = []
  const root = trashRootFor(somePath)
  for (const dir of await sidDirs(root)) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (!before.has(join(dir, name))) added.push(name)
    }
  }
  return added
}
