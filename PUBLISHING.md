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

# 4) 去 awesome-dsh-plugin 提 PR
#    贡献说明：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
#    只加「一个文件」：data/plugins/<owner>__<repo>.yml，内容是
#      url: https://github.com/Knight-Zjy/dsh-workspace-categories
#      name: Knight-Zjy/dsh-workspace-categories
#      category: ui
#      description:
#        en: ...        # 唯一必填项，以句号结尾；含 ": " 必须加引号
#        zh: ...        # 可选，不写维护者会补
#    两个 README 是脚本从 data/plugins/*.yml 生成的，不要手改。
#    version / stars / downloads / install / capabilities / added 全部由 CI 自动生成。
#
#    硬性前置（CI 会查，缺一即红）：
#      - 仓库创建满 1 天  ← 本仓库 created_at=2026-10-14T04:20:19Z，
#                           最早可提 PR 时间 = 2026-10-15T04:20:19Z（北京时间 10-15 12:20）
#      - 仓库带 dsh-plugin topic（已加）
#      - package.json 声明 dsh.bundle.patch（已有）——只声明 dsh.client 会被拒

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

- **`npm publish` 返回 202 = 已受理，但异步**（本机 2026-10-14 实测）：
  ```
  npm notice Your package is being processed and may take a few minutes to become available.
  npm http fetch PUT 202 https://registry.npmjs.org/dsh-workspace-categories
  ```
  此刻 registry 上只有占位版本 `0.0.0-stage`
  （`"stub": true`，描述 `Temporary package placeholder for staged publishing`），
  真版本 `0.1.0` 要 **约 100 秒**后才出现在 `dist-tags.latest` 并让版本端点返回 200。
  这期间重发会报
  `409 Conflict - Cannot publish over previously staged version "0.1.0"` 或
  `EPUBLISHCONFLICT: You cannot publish over the previously published versions: 0.1.0.`
  —— **这不是失败，别改版本号重发**。用 `npm view <pkg> versions dist-tags --prefer-online`
  或直接 `curl .../dsh-workspace-categories/0.1.0` 复查即可。
  `npm stage list`（需 npm ≥ 12，如 `npx npm@12.2.0 stage list`）队列为空也正常，那是人工审批用的暂存区，与本流程无关。
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

## 8. 踩坑：`git push` 推不上去（本机真实案例）

第一次 `git push -u origin main` 会失败在**认证之前**，报：

```
error: unable to read askpass response ...
fatal: could not read Username for 'https://gh-proxy.com': terminal prompts disabled
```

注意主机名是 **gh-proxy.com**，不是 github.com。原因：本机全局 git 配置里有一条 GitHub 加速代理重写规则

```bash
$ git config --global --get-regexp '^url\.'
url.https://gh-proxy.com/https://github.com/.insteadof https://github.com/
```

它把**所有** `https://github.com/...` 改写成 `https://gh-proxy.com/https://github.com/...`。
gh-proxy 是**只读下载代理**，不支持 push，所以 push 永远到不了 GitHub —— 这跟权限、token 都无关。

排查命令（看 push 到底发往哪个主机）：

```bash
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false git push --dry-run origin main 2>&1 | head -3
```

### 三种修法

**A. 只修当前仓库（本次采用，不动全局）** —— 给 URL 显式写 443 端口，这样它不再以
`https://github.com/` 开头，重写规则匹配不到，又不影响任何行为：

```bash
git remote set-url origin https://github.com:443/Knight-Zjy/dsh-workspace-categories.git
```

**B. 全局删掉这条重写**（推荐，否则以后每个仓库的 push 都要再踩一次）：

```bash
git config --global --unset url.https://gh-proxy.com/https://github.com/.insteadOf
```

前提是你不再需要它加速 `git clone`。实测本机直连 GitHub 是通的（`api.github.com` → 200），
如果 clone 变慢再加回去。

**C. 改用 SSH（完全绕开 HTTPS 重写）** —— 本机 22 端口被封（banner 超时），
但 GitHub 官方备用端口 443 是通的，remote 写：

```bash
git remote set-url origin ssh://git@ssh.github.com:443/Knight-Zjy/dsh-workspace-categories.git
```

前提是把公钥加到 GitHub 账号（见下）。

### 另一个坑：SSH 报 `Permission denied (publickey)`

```
debug1: Offering public key: /Users/knight/.ssh/id_rsa RSA SHA256:hqImm+P3mXcUbWxkpG9YkvoQ8OB3Ab7QHPOal1h9+Q0
git@ssh.github.com: Permission denied (publickey).
```

传输是通的、key 也递上去了，但 GitHub **不认这把 key** —— 需要把
`~/.ssh/id_rsa.pub` 的内容加到 https://github.com/settings/ssh/new 。

### 凭据会被 macOS 钥匙串记住

本仓库已设 `git config --local credential.helper osxkeychain`，所以第一次 push 时
输入用户名 + Personal Access Token（GitHub 早已不接受账号密码）之后就不必再输。

如果报 401/403，是钥匙串里存了旧的失效凭据，先擦掉：

```bash
printf "protocol=https\nhost=github.com\n\n" | git credential-osxkeychain erase
```

### 本机最终解法（2026-10-14 实测记录）

- **fine-grained token（`github_pat_...`）要两次点击才对**：新建时选好仓库还不够，必须进入
  token 编辑页 → `Permissions` → `Repository permissions` → **`Contents` 改成 `Read and write`**
  → **拉到页面最底部点 `Save changes`**（只改下拉框不点保存不生效）。否则 push 报
  `remote: Permission to <owner>/<repo>.git denied to <owner>` + `HTTP 403`。
  想确认到底缺哪项，打一个写探测：
  ```bash
  curl -sS -D- -o /dev/null -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"ref":"refs/heads/__probe__","sha":"<任意commit>"}' \
    https://api.github.com/repos/<owner>/<repo>/git/refs
  ```
  响应头里的 `x-accepted-github-permissions: contents=write` 就是缺的那项权限。
  （另注：仓库为空时这个探测会返回 `409 Git Repository is empty`，那是正常的，不是权限问题。）
- **classic token（`ghp_...`）只勾一个 `repo` 就够**，本机一次成功。省事就选它。
- 凭据存钥匙串：`git config --local credential.helper osxkeychain`，首次 push 输一次即记住。
