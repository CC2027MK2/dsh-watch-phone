# 发布清单 · dsh-watch-phone

这份文件说明如何把这个 bundle 发布到 DSH 插件生态里。它本身不会打进 tarball
（`package.json` 的 `files` 没列它）。

## 0. 结论先说

DSH **没有** 官方审核制应用商店。社区的做法是三步：

1. 把包发到 **npm**（`dsh-watch-phone` 目前没人占用）；
2. 在 **GitHub** 建公开仓库，并给仓库打上 **`dsh-plugin`** topic；
3. 收录进社区索引 —— `awesome-dsh-plugin`（`dsh-plugin-catalog` 的 `index.json`，
   站点 `awesome-dsh-plugin.com` / `dshmarket.com`）。索引是按 GitHub topic + npm
   自动扫的，也可提 PR 手动加条目。

Harness 仍处于 developer preview，官方明说会有破坏性变更。所以这个包在
`package.json` 里锁了 `engines.dsh: ">=0.2.1-rc.2 <0.3.0-0"`，并在
DSH 0.2.2-rc.x 上做过真实安装测试。

## 1. 发布前自检（本机可跑）

```powershell
cd C:\Users\excal\Documents\deepseek-harness\default-workspace\packages
node _smoke.mjs                       # 桩 ctx 冒烟：/health、/watch/app.apk、403、404
cd dsh-watch-phone
node --check index.js
npm pack                              # 产出 dsh-watch-phone-0.1.1.tgz（约 2.2MB）
```

真机安装冒烟（推荐，任何一台 DSH 上）：

```
plugin_manager install_bundle target="file:C:\...\dsh-watch-phone-0.1.1.tgz"
# 然后 GET http://127.0.0.1:38402/health，应看到 service=dsh-watch-phone
plugin_manager set_bundle target="dsh-watch-phone" enabled=false   # 收尾卸掉
```

## 2. 发到 npm

需要 npm 账号（包名 `dsh-watch-phone` 未占用）。有两条路，**优先级从高到低**：

### 路线 A（推荐，长期）：Trusted Publishing，零 token

npm 从 2026-08 起限制「绕过 2FA 的 token」做账户级操作，**2027-01 起连直接发布也停**。
长期方案是让 CI 用 OIDC 证明身份，不存任何 token。这个包里已经写好：

`.github/workflows/publish.yml` —— push `v*` tag 就发布，带 `--provenance`。

一次性配置：npmjs.com → 包 `dsh-watch-phone` → Settings → **Trusted Publisher**
→ 填 GitHub 仓库与 workflow 名 `publish.yml`。之后 `git tag v0.1.2 && git push --tags` 即可。
本机 `npm 11.9.0` 已支持（需要 ≥ 11.5.1）。

### 路线 B（现在就能用）：Granular Access Token

在 **Access Tokens → Generate New Token → Granular**，三个坑：

1. **Permissions 必须选 `Read and write (publish and stage)`** —— 留在 `Read only`
   会 403（截图里就是这个状态）；
2. 勾 **Bypass two-factor authentication (2FA)**，否则非交互 `npm publish` 必然停在 OTP；
3. 能选包范围就只选 `dsh-watch-phone`，期限给 30–90 天。

```powershell
$env:NPM_TOKEN = "npm_xxx"
cd C:\Users\excal\Documents\deepseek-harness\default-workspace\packages
.\publish.ps1                 # 自检 → pack → publish（默认还会建 GitHub 仓库）
```

交互式（本机有浏览器/OTP）也可以直接：

```powershell
npm login
cd ...\packages\dsh-watch-phone
npm publish --access public
```

`npm publish` 带上 token 的非交互写法：

```powershell
$env:npm_config_cache = "C:\Users\excal\Documents\deepseek-harness\default-workspace\.npm-cache"
npm publish --access public --//registry.npmjs.org/:_authToken=$env:NPM_TOKEN
```

发布后用户就能：

```
dsh plugin --profile <profile> add dsh-watch-phone
```

## 3. 建 GitHub 仓库 + 打 topic

仓库根目录就用 `packages/dsh-watch-phone/` 这一份（README、LICENSE、icon、源码、
assets 都在里面）。

```powershell
cd C:\Users\excal\Documents\deepseek-harness\default-workspace\packages\dsh-watch-phone
git init -b main
git add .
git commit -m "feat: dsh-watch-phone 0.1.1 — 小米手表 5 对话桥"
gh repo create dsh-watch-phone --public --source=. --push
gh repo edit --add-topic dsh-plugin,deepseek-harness,wearos,voice,tts,stt
```

没有 `gh` 时用网页建仓，再 `git remote add origin ...` + `git push -u origin main`，
然后在仓库页 **About → Topics** 里加 `dsh-plugin`（这个 topic 是社区索引的入口）。

## 4. 进社区索引

- 自动路径：`dshbase.com`、`awesome-dsh-plugin.com` 会扫 GitHub 上带 `dsh-plugin`
  topic 的仓库，通常几天内自动出现。
- 手动路径：给 `awesome-dsh-plugin` 提 PR，索引条目形状如下（摘自
  `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）：

```json
{
  "name": "dsh-watch-phone",
  "title": "<你的GitHub账号>/dsh-watch-phone",
  "description": {
    "en": "Talk to DeepSeek Harness from a Xiaomi Watch over Wi-Fi, with local speech-to-text and text-to-speech on the phone.",
    "zh": "用小米手表通过局域网和 DSH 对话：手机本地做语音识别与朗读，手表只负责录音、显示与播放。"
  },
  "homepage": "https://awesome-dsh-plugin.com/p/<账号>/dsh-watch-phone/",
  "repository": { "url": "https://github.com/<账号>/dsh-watch-phone" },
  "metadata": { "category": "remote", "keywords": [], "labels": [], "sortKeys": {} },
  "versions": [{ "version": "0.1.1", "source": { "type": "npm" }, "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" } }]
}
```

`metadata.category` 建议 `remote`（Remote & Mobile，远程与移动端）；`voice` 也说得通，
但手表这个形态更贴 `remote`。

在 DSH 里加索引源：**插件 → 发现 → 索引源**
→ `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`（dsh 0.2.1 起支持）。

## 5. 之后每次更新

1. 改 `package.json` 版本号（语义化版本）；
2. `node --check index.js` + `node _smoke.mjs`；
3. `npm publish`；
4. 打 tag：`git tag v0.1.2 && git push --tags`。

索引里的 `versions[]` 由扫描器更新，`engines.dsh` 变化时记得同步。

## 6. 需要用户提供的东西

| 事项 | 需要 |
| --- | --- |
| npm 发布 | npm 账号登录，或 `NPM_TOKEN`（Automation token，勾 publish 权限） |
| GitHub 仓库 | 仓库名与账号确认；`gh auth login` 或 `GITHUB_TOKEN`（repo 权限） |
| 索引 PR（可选） | 与上面同一个 GitHub 账号即可 |

**这个包内含一份 APK**（`assets/dsh-watch-chat.apk`，2.4MB），所以 tarball 有 2.2MB。
如果不想在 npm 里放二进制，可以把 `assets/` 从 `files` 去掉、改用 GitHub Release
附件，`/watch/app.apk` 就会返回 404 并提示去 Release 下载。
