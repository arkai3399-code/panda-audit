# 让排查图自动跟着仓库更新（可选）

现在线上（claude.ai Artifact）放的是 **快照**：main@24b595f。要让同事看到「跟着最新 commit 走」的版本，需要一个会定时重扫的地方。
PANDA 仓库本身不改动、不加 workflow；重扫放在一个**独立的审计仓库**里。

## 会自动更新的 / 不会的
| 自动更新（每次重扫重算） | 不会自动更新（需人工） |
|---|---|
| ① 本体、② 社内ツール 的操作点、接口、「接口没入口」「部件没接上」、本次变化列表、commit 与版本号 | 8 张 archify 图（要在有 archify 的机器上重画） |
| | 人工登记的条目：逻辑类问题、待核验、三者衔接、③ 的问题（行号按 24b595f / c15ce5f 写的，源码变动后要复核） |

## 步骤（GitHub Pages 方案）
1. 新建私有仓库 `panda-audit`，把本目录整个放进去（含 `tools/`、`gp/`、8 张图、`index.html`）。
2. 复制 `tools/ci/rescan.yml` 到 `.github/workflows/rescan.yml`。
3. 在 GitHub 上生成 fine-grained personal access token：只勾 `Panda-Fortune2` 仓库、权限只给 **Contents: Read**。存为仓库 secret `PANDA_READ_TOKEN`。
4. Settings → Pages → Source 选 **GitHub Actions**。
5. Actions 里手动跑一次 `rescan-and-publish`，之后每天 06:00 JST 自动跑；数据没变就不提交。
6. 把 Pages 地址发给同事。

注意：免费的 GitHub 账户下，私有仓库的 Pages 站点仍是**公开可访问**（知道地址就能看）。要限制访问，用付费方案的 private Pages，或改用 Cloudflare Pages + Cloudflare Access（公司已经在用 Cloudflare Pages 放社内ツール）。排查数据里含社内ツール的地址与「開放モード」说明，分享前先决定范围。

## 不搭 CI 时
需要更新就在这台 Mac 上跑 `tools/sync.sh <仓库> gp`，再让 Claude 重新发布同一个 Artifact 地址（地址不变，打开的人自动看到新版）。
