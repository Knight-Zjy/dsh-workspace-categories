# 发布到「DSH 插件市场」——完整流程

> 状态：包名已定为 `dsh-workspace-categories`，上传清单（manifest）已按官方要求补齐并通过
> `npm pack --dry-run` 校验（9 个文件 / 17.1 kB）；剩下的动作是 npm 登录发布 + 去
> awesome-dsh-plugin 提 PR。

## 0. 先纠正一个前提：DSH 没有官方第三方插件市场

应用内「设置 → 插件」页只是**安装器**（npm 源 / GitHub / tarball / 本地路径），不是市场。
你在设置里看到的「插件市场」是**社区插件** `dshmarket`（本机 profile 里已装 `v1.66.15`）。
它的目录不来自 DeepSeek，而来自社区精选列表 **awesome-dsh-plugin**。

链路：

```
作者仓库/ npm 包
      │  人工 PR 收录（唯一的「上架」动作）
      ▼
awesome-dsh-plugin（GitHub 仓库）
      │  自动构建（约一天）
      ├──▶ https://awesome-dsh-plugin.com/plugins.json     ← 站点
      └──▶ npm 包 dsh-plugin-catalog/plugins.json          ← 镜像线路用
                    │
                    ▼
            dshmarket（市场 UI）拉取 → 卡片 / 一键安装 / 更新检测
```

`dshmarket` 自己的 README「Submit your plugin」原文：**这个仓库是市场应用本身，不是插件目录**；
插件列表来自精选列表 awesome-dsh-plugin——想上架请去**那边**提 PR（在列表里加一条即可，
站点和本市场会自动收录，通常一天内生效）。不要往 `dsh-market/dsh-market` 提插件条目。

## 1. 上架的三个必要条件

1. **一个可安装的来源**（市场按此优先级选择）：
   repo 校验通过的 **npm 包** → 作者提供的 **GitHub Release 预构建 tar** → **整仓 GitHub 源码**。
   目录里 `pipipigu/dsh-workspace-tree` 就是 `npm: null` 的 GitHub-only 条目（能装，但用户侧要现场拉源码）。
2. **被 awesome-dsh-plugin 收录**（人工 PR，唯一需要你做的「上架」动作）。
3. **清单里声明宿主兼容性 + 卡片元数据**：`engines.dsh`（或同版本线的 `@deepseek-ai/dsh-*` peer）
   + `locale/*.json` 的 `meta.title` / `meta.description` + 可选的顶层 `icon`。

## 2. ⚠️ 发布前必须先处理的两件事

### 2.1 包名 `dsh-workspace-tree` 已被别人占用

目录里已有 `pipipigu/dsh-workspace-tree`（2026-08-29 收录，描述是「虚拟会话分类树」，
`npm: null`）。它的 npm 包在 **2026-08-24 撤包**了，所以 `npm view dsh-workspace-tree` 看着像 404 空位，
但**名字在目录里已归属他人**——市场按 `name` 建索引，撞名会让安装/更新/校验指向错误的来源。
**已改名**：本仓库现在的包名是 `dsh-workspace-categories`，远端仓库
`https://github.com/Knight-Zjy/dsh-workspace-categories`（与原条目不再撞名）。

已验证（npm 官方 registry 与目录都空）的候选名：

| 候选名 | npm | 目录 |
|---|---|---|
| `dsh-workspace-categories` | 空 ✓ | 无 ✓ |
| `dsh-category-tree` | 空 ✓ | 无 ✓ |
| `dsh-workspace-groups` | 空 ✓ | 无 ✓ |
| `dsh-workspace-folders` | 空 ✓ | 无 ✓ |

改名已执行完毕，同步了四处：`package.json` 的 `name`、`cordis.patch.yml` 里 loader 行的 `name:`、
客户端 bundle 的 `id`（**必须**与包名一致，否则宿主按包名 import 不到这个模块）、
以及本机 profile 的软链名与 `dsh.profile.bundles` 条目。
注意 `localStorage` 的状态键 `dsh.workspace-tree.state.v1` **故意没改**，这样你现有的分类不丢。

### 2.2 已有高度相似的竞品

`dsh-better-workspace`（作者 KannaKuron，18★ / 6821 下载，2026-09-02 收录，分类 `ui`）：
「工作区/会话标题里的 `/` 即虚拟分组，任意多级」。

**差异化（写进 PR 描述里）**：本插件的分类是**显式、用户自建**的（新建/重命名/删除分类 + 拖拽归类 +
在分类内直接新建工作区 + 未分类收件桶），不是从标题里的斜杠推导出来的；并且随时一键切回官方列表。

## 3. 清单要求（本仓库已补齐）

| 字段 | 值 | 作用 |
|---|---|---|
| `license` | `MIT` | 必需 |
| `author` | knight | 卡片署名 |
| `engines.dsh` | `>=0.2.0-rc.2` | 市场的「按宿主发现」据此判兼容（对应你本机 0.2.0-rc.2） |
| `peerDependencies` | `@deepseek-ai/cordis` / `-dsh-client-ui-sidebar` / `-dsh-client-ui-slots` / `-dsh-client-ui-workspace` | 同上；**不会真被安装**（profile 的 `pnpm-workspace.yaml` 是 `autoInstallPeers: false`，宿主从 app.asar 提供这些包） |
| `icon` | `./icon.svg` | 市场/插件页卡片图标（SVG/PNG/JPEG/WebP，<256 KiB） |
| `locale/zh.json`、`locale/en.json` | `{meta:{title,description}}` | 卡片标题与文案（中英跟随界面语言） |
| `exports["./locale/*.json"]` | — | 宿主按此路径读 locale |
| `files` | `lib` `locale` `cordis.patch.yml` `icon.svg` `README.md` `LICENSE` | 控制 npm tarball 内容 |
| `private` | **已删除** | 不移除就发布不了 |

`npm pack --dry-run` 实测 tarball：9 个文件 / 17.0 kB（`lib/client.js` 41.5 kB 解压后）。

## 4. 发布步骤

```sh
# 1) 建 GitHub 仓库（公开）并推送
git init && git add -A && git commit -m "dsh-workspace-categories 0.1.0"
git remote add origin https://github.com/Knight-Zjy/dsh-workspace-categories.git
git push -u origin main
#    package.json 里的 homepage / repository 已按此地址填好；
#    市场用它做 repo 校验、抓 README 截图、算 star 数。

# 2) 切回官方 registry 再登录（本机默认是 npmmirror，镜像不能发布）
npm config set registry https://registry.npmjs.org
npm login

# 3) 预演 + 发布
npm publish --dry-run
npm publish --access public

# 4) 去 awesome-dsh-plugin 提 PR，在列表里加一条
#    贡献说明：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
#    你只需给：name / owner / url(GitHub) / category / description{en,zh} / 可选 screenshots[]
#    version、stars、downloads、install、capabilities、added 全部自动生成。

# 5) 收录后（约一天）在「设置 → 插件市场」搜到；也可命令行直接装：
dsh plugin --profile desktop add dsh-workspace-categories
```

分类取值（目录现有分布）：`ui` 807 · `tools` 598 · `dev` 331 · `session` 307 · `workflow` 277 …
本插件属 **`ui`**。

## 5. 后续更新

```sh
npm version patch && npm publish
```

市场按 npm 版本号比对，用户侧出现「更新」并可一键升级。仓库里也可以放
GitHub Actions 在打 tag 时自动 `npm publish`（`secrets.NPM_TOKEN`）。

## 6. 坑

- **先撤掉本地软链安装**：删 `~/.dsh/profiles/desktop/node_modules/<包名>` 软链 +
  `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里那一条，
  否则市场装的 npm 版和软链版会打架。（本机现在正是软链安装状态：
  `node_modules/dsh-workspace-categories` → 插件源码目录。）
- **不要 `dependencies` 里放 `@deepseek-ai/*`**：宿主从 `app.asar` 提供，写了会去 registry 找不存在的包。
  声明成 `peerDependencies` 只是给市场做兼容性判断用。
- **guardian 的「缺少依赖」警告是假阳性**：`dsh-better-sidebar`、`dsh-context`、`dsh-cost-meter`
  全都被报同样的 `缺少依赖 @deepseek-ai/cordis` 等，与是否发布无关，不影响加载。
- **客户端 bundle 只能 `require` 静态种子模块**：`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`。
  本插件只 `require('react')`，所以无需在 `dsh.client.external` 里声明任何边。
- **不发 npm 也能分发**：条目 `npm: null` 时用户装法是
  `dsh plugin --profile desktop add github:<你>/<repo>`（走整仓源码下载，慢，且没有版本更新检测）。
- **收录 ≠ 背书**：市场 README 明说不背书第三方插件。

## 7. 其他社区目录（可选，一起投）

- [dsh-plugin-hub](https://github.com/dshplugin/dsh-plugin-hub) — 内置于 Harness「设置 → 插件中心」
- [DSH Get](https://www.dshget.com/) — 网页检索目录，规范化快照公开在
  [bobby-sheng/dshget-data](https://github.com/bobby-sheng/dshget-data)
- [dshmarket.com](https://dshmarket.com) / [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) — 同一份目录的两种呈现
