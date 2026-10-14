# dsh-workspace-categories

给 **DeepSeek Harness 桌面版**用的工作区管理器：把左侧栏的工作区浏览器换成 **VS Code 风格的三级树**。

```
分类 A                     ← 自建分类（可拖动工作区归类）
  └ 工作区 A-1             ← 会话数 / 新建会话 / 归入分类
      └ 会话 1
      └ 会话 2
  └ 工作区 A-2
未分类                     ← 未归类的工作区落在这里
  └ 工作区 B
```

## 它怎么接管左侧栏

左侧栏的 `sidebar.workspaces` 是一个 **single 槽位**：同一个槽位允许注册多个条目，只要 `priority` 不同，**priority 最小的那个渲染获胜**（同 priority 重复注册才会抛错）。

本插件以 `priority: -100` 注册进去，官方 `ui-workspace` 的默认浏览器是 `priority: 0`，因此：

- 不需要禁用任何官方插件；
- `ui-workspace` 仍然挂载，`ctx.uiWorkspace` 等服务和它的其它扩展点照常可用；
- 本插件的注册一旦 dispose，官方浏览器**立刻**回来——所以「分类树 / 原生列表」可以一键切换，不用重启，不用改配置。

切换开关有两个：树顶栏最右侧的列表图标，以及侧边栏底部（`sidebar.footer.action`）常驻的文件夹图标。选择结果存在 `localStorage` 的 `dsh.workspace-tree.state.v1`。

## 功能

| 能力 | 说明 |
| --- | --- |
| 分类管理 | 顶栏 `+` 新建；分类行铅笔重命名、`×` 删除（删除后工作区回到「未分类」） |
| 归类 | 工作区行右侧下拉框，或把工作区行**拖到**分类行上 |
| 折叠 | 分类行 / 工作区行点击折叠，状态持久化 |
| 会话 | 展开工作区时默认显示 5 条，`显示更多` 每次 +10；点会话行打开该会话 |
| 运行中标记 | 会话行右侧脉冲点 |
| 新建会话 | 工作区行的 `+`，走 `ctx.uiWorkspace.startSession(workspaceId)` |
| **新建工作区** | 顶栏文件夹按钮、每个分类行的 `+`、以及「未分类」行的 `+`：调起系统目录选择器，选中后立即成为工作区；从分类行发起时会**自动归入该分类** |
| 筛选 | 顶部输入框同时匹配工作区（标题/路径）和会话（标题/路径/id）；展开工作区时会话列表也按同一关键词过滤 |
| 排序 | 置顶会话优先，其余按 `updatedAt` 倒序（与官方浏览器一致） |

### 新建工作区走的是官方同一条链路

```js
// 目录选择器：与官方 dsh-client-ui-directory-picker-native 的取用顺序完全一致
const path =
  globalThis.__DSH_DIRECTORY_PICKER__?.pick() ??  // Electron 外壳注入的 chooser 优先
  ctx.get('uiWorkspace').pickDirectory()          // 否则走 remote.directoryPicker
// 采纳：官方 WorkspacePickFlow 的 adoptDirectory 也是这一句
const workspace = await ctx.get('workspaces').create({ path })
```

`pick()` 返回绝对路径，用户取消时返回 `null`（此时什么都不做）。`workspaces.create({ path })` 会把已存在的绝对路径解析成一个 Workspace 行，并且客户端模型**立刻**把新行并入快照，所以树会自己刷新，不用重载。失败（比如路径不可用）会在树顶显示一条可关闭的错误条。

数据全部来自客户端 Cordis 服务，**没有任何 RPC**：

```js
ctx.get('workspaces').list   // { items: [{ workspaceId, path, title, sessionIds, ... }], archivedSessionIds, pinnedSessionIds, phase }
ctx.get('sessions').list     // { ids, byId: { [id]: { id, displayTitle, running, retainedBy, updatedAt } }, phase }
ctx.get('uiWorkspace')       // openSession(id) / startSession(workspaceId) / pickDirectory() / forkSession(id)
ctx.get('workspaces')        // create({ path }) / rename / delete / insertBefore / archiveSession …
```

分类是纯 UI 元数据，存在浏览器 `localStorage`，因此**没有 host 侧状态**、不写 profile 存储。host 半 `lib/index.js` 只是一个空 `apply()`——它存在的唯一目的是让 Loader 有一个条目、从而让 `dsh.client` 扫描能发现 `./client`。

## 安装

已发布到 npm：**`dsh-workspace-categories`**

```bash
# 推荐：走包管理器，会自动写进该 profile 的 dsh.profile.bundles
dsh plugin --profile desktop add dsh-workspace-categories
```

也可以在应用内「设置 → 插件」里添加插件，填包名 `dsh-workspace-categories`。

然后**重启桌面应用**。`cordis.yml` 是生成物，不要手改。

卸载：`dsh plugin --profile desktop remove dsh-workspace-categories` 然后重启。

### 从源码开发时

```bash
# 1) 软链进 profile 的 node_modules
ln -sfn /path/to/dsh-workspace-categories \
        ~/.dsh/profiles/desktop/node_modules/dsh-workspace-categories

# 2) 把包名追加到 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 末尾
#    （末尾 = 优先级最高）
```

用完记得切回 npm 安装，别让软链版和 npm 版并存。

## 文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.bundle.patch` 指向 bundle patch；`dsh.client` 声明客户端半（`platform: web`） |
| `cordis.patch.yml` | bundle 层 patch，`insert` 一条 loader 条目；带 `disabled: !!js` 防重挂守卫（照抄 `dsh-better-sidebar` 的做法） |
| `lib/index.js` | host 半，空实现 |
| `lib/client.js` | 客户端半，全部 UI 逻辑。**不是 ESM**：`window.__ModuleLoader__.load({ id, factory })` 形态，factory 内只允许 `require` 平台种子模块（这里只用 `react`） |

## 加入自己的扩展点

如果你的插件想在这棵树里加东西，`priority: -100` 之下还有空间；也可以直接把本插件作为 `sidebar.workspaces` 的实现来改造。注意 `sidebar.workspaces` 的 props 是 `{ wide, expandSidebar }`——`wide === false` 表示侧边栏已折叠，本插件在这种宽度下退化为图标轨道。

## 已知限制

- 拖拽只支持「工作区 → 分类」，不支持分类排序、不支持工作区在分类内手动排序（排序始终是置顶 + 时间倒序）。
- 新建工作区用的是**系统目录选择器**（官方 `native` picker 同款），所以只能选已存在的目录；没有做官方 `browse` 那种应用内浏览（要浏览可以用 `uiWorkspace.listDirectory` / `createDirectory` 另做）。
- 分类名没有长度限制，但行内会省略号截断。
- 归档会话不出现在树里（官方浏览器有「显示归档」三态过滤，本插件未实现）。想恢复用官方列表即可。
- 不做跨设备同步：分类存在本机 `localStorage`，换机器/清缓存会丢。
