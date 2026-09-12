# 本仓库说明

这里是 [one-ip](https://github.com/zhihui-hu/one-ip) 的 Cloudflare Workers 部署版。

应用本身（IP 查询、网络诊断、浏览器检测、AI 服务状态）由上游 `zhihui-hu/one-ip` 维护，功能开发、在线体验和数据源都指向上游。本仓库只维护两件东西：让它以单个 Worker 完成部署所需的改动，以及支撑这套部署的技术栈跟进。

上游项目与作者：[zhihui-hu/one-ip](https://github.com/zhihui-hu/one-ip)，AGPL-3.0-only。

## 相对上游的改动

部署形态。移除了 Cloudflare 的 `[assets]` 绑定与 `public/_headers`。`pnpm build` 的最后一步由 `scripts/build-worker-assets.mjs` 把 `dist/` 逐文件嵌入 `public/worker/assets.generated.js`（构建产物，不入库），`public/worker/static-assets.js` 在运行时接管前端请求，实现原本由 Static Assets 提供的能力：SPA 回退、内容哈希 ETag 与 304、`/assets/*` 长缓存、安全响应头。一次 `pnpm deploy` 同时发布页面与 `/api/*`，部署配置里不需要再声明资源目录。

技术栈。pnpm 12、TypeScript 7（原生编译器）、TanStack Table 9、React 19.3、Vite 8.3、wrangler 4.131.1 等全部跟随最新发行版，依赖说明符钉为 `^x.y.z` 以保证可复现。CI 动作同步升级，`pnpm/action-setup` 改为读取 `packageManager`，避免流水线与本地版本漂移。

界面与读数。页头统一为 console-bar 结构，首页、分流出口、IP 详情与延迟徽章随之调整；信誉分阈值与配色收敛到 `ipScoreState` 单一来源，读数改用文本安全的 `--data-*` 墨色。

验收工具。`scripts/verify-ui.mjs` 用无头浏览器量化复核布局、对比度与背景网格，输出目录 `docs/screenshots/ui-review/` 已列入 `.gitignore`：它属于可再生产物，且画面会带出运行机器的归属地、ASN 与浏览器指纹标识。

## 上游跟踪点

当前基线：`df67fd8`（2026-09-11）。

```bash
git remote add upstream https://github.com/zhihui-hu/one-ip.git
git remote set-url --push upstream DISABLED   # 上游只读，防止误推
git fetch upstream
git rev-list --count HEAD..upstream/main      # 落后多少个提交
```

本仓库不做自动同步。继承自上游的 `.github/workflows/sync-upstream.yml` 在这里不会生效：它第一步就校验仓库是否为 `zhihui-hu/one-ip` 的 fork，而本仓库是独立仓库，工作流会直接退出。保留文件只为与上游一致，需要的话可以删除。

手动同步：

```bash
git fetch upstream
git merge upstream/main
pnpm install
pnpm build && pnpm test
git push
```

### 已知的合并分歧

截至基线之后，上游有 2 个提交（`59b53bb`、`9df298b`），合并会在 `wrangler.toml` 冲突，而且这不是文本错位，是两种部署形态的选择：

上游在 `59b53bb` 把 `run_worker_first = true` 收窄为 `["/api/*", "/worker", "/worker/*"]`，并新增 `[env.local.assets]` 用于本地开发。这意味着上游选择保留 Static Assets、只让接口走 Worker，页面与静态资源由 CDN 直接服务，不在每个请求上消耗 Worker CPU。本仓库走的是另一条路：没有 `[assets]` 绑定，资源嵌在 Worker 脚本里，每个请求都会执行 Worker 代码。

合并时需要二选一，或者明确分层：若沿用本仓库形态，丢弃上游的 `[assets]` 与 `run_worker_first` 配置；若接受上游形态，本仓库的核心改动（`static-assets.js` 与嵌入脚本）就失去意义，应当退役。两种都能部署到 Workers，差别在于是否需要资源绑定、以及静态请求的开销落点。

另一个提交 `9df298b` 是 Telegram 状态监测，涉及 `public/worker/services.json`、`public/worker/telegram-status.js`、状态页与文案，与本仓库改动不冲突，可直接并入。

## 部署

前提：本仓库的构建产物依赖 `pnpm build`，Worker 脚本内含前端资源，因此不需要配置 Static Assets、也不需要额外的 API Key 即可跑通基础功能。

方式一，Workers Builds（推荐，跟随提交自动发布）。在 Cloudflare 控制台 Workers & Pages 导入本仓库，生产分支 `main`，构建命令 `pnpm build`，部署命令 `pnpm deploy`，Node.js 24、pnpm 12.4.1，根目录保持默认。

方式二，GitHub Actions。在仓库 Settings 的 Secrets and variables 中添加 secret `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 与 variable `ENABLE_CF_DEPLOY=true`。构建与测试始终执行，只有开启该变量才进入部署作业。

两种方式选一种，避免重复发布。自定义域名在 Worker 设置中绑定。

验证体验（Turnstile、reCAPTCHA v3）为可选能力，需要配置 Site Key、Secret 与允许域名，本地用 `.dev.vars`、线上用 Worker 变量与密钥，细节见 README 的对应章节。

## 本地开发

```bash
pnpm install
pnpm worker:dev
```

`http://127.0.0.1:8787` 同时提供页面与 `/api/*`，内部由 Vite（5137）与本地 Worker 组成，支持热更新。若通过命名域名代理访问，注意 Vite 的 HMR 端口配置为 8787，HTTPS 页面下热更新会被混合内容策略拦截，需手动刷新。

## 命名

Worker 名保持 `one-ip`、包名保持 `ip`，与上游一致，便于对照上游文档与教程。部署到已有同名 Worker 的账号时，在 `wrangler.toml` 自行改名即可。
