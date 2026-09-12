# 本仓库说明

这里是 [one-ip](https://github.com/zhihui-hu/one-ip) 的 Cloudflare Workers 部署版。

应用本身（IP 查询、网络诊断、浏览器检测、AI 服务状态）由上游 `zhihui-hu/one-ip` 维护，功能开发、在线体验和数据源都指向上游。本仓库维护两件东西：让这套部署在 Workers 上稳定跑起来的配置，以及支撑它的技术栈跟进。

上游项目与作者：[zhihui-hu/one-ip](https://github.com/zhihui-hu/one-ip)，AGPL-3.0-only。

## 相对上游的改动

技术栈。pnpm 12、TypeScript 7（原生编译器）、TanStack Table 9、React 19.3、Vite 8.3、wrangler 4.131.1 等全部跟随最新发行版，依赖说明符钉为 `^x.y.z` 以保证可复现。CI 动作同步升级，`pnpm/action-setup` 改为读取 `packageManager`，避免流水线与本地版本漂移。

界面与读数。页头统一为 console-bar 结构，首页、分流出口、IP 详情与延迟徽章随之调整；信誉分阈值与配色收敛到 `ipScoreState` 单一来源，读数改用文本安全的 `--data-*` 墨色。

验收工具。`scripts/verify-ui.mjs` 用无头浏览器量化复核布局、对比度与背景网格，输出目录 `docs/screenshots/ui-review/` 已列入 `.gitignore`：它属于可再生产物，且画面会带出运行机器的归属地、ASN 与浏览器指纹标识。

部署形态与上游一致（见下节的决策记录），另有两处需要记录的偏离，见"与上游的已知偏离"。

## 部署形态的决策记录

本仓库一度把前端产物嵌进 Worker 脚本：移除 `[assets]` 绑定与 `public/_headers`，由 `scripts/build-worker-assets.mjs` 在构建末把 `dist/` 逐文件转成 `public/worker/assets.generated.js`，再用 `public/worker/static-assets.js` 在运行时提供 SPA 回退、内容哈希 ETag 与 304、长缓存和安全响应头。该方案已退役，回到上游的 Static Assets 形态。

退役的理由，按分量排：

Cloudflare 对静态资源的计费口径是"Requests to static assets are free and unlimited"，而 Worker 请求计入 Workers 配额，免费计划为每天 10 万次、超出返回 Error 1027。嵌入方案下每一个 JS、CSS、字体和图片请求都是一次 Worker 调用；首页产物有 77 个文件，一次访问就消耗十几个配额。上游的 `run_worker_first = ["/api/*", "/worker", "/worker/*"]` 恰好相反：页面与资源不进 Worker，只有接口计入。

Cloudflare 官方在"减小 Worker 体积"的建议里点名了这种做法，要求把配置、静态资源和二进制数据放到 KV、R2、D1 或 Workers Static Assets，而不是打进 bundle。

实测代价：嵌入后 `wrangler deploy --dry-run` 报 `Total Upload: 2903.78 KiB / gzip: 1073.10 KiB`，整站以 base64 字面量躺在模块顶层，每次 isolate 启动都要解析这约 2.8 MB JS，而文档同一页写明更大的 bundle 会影响启动时间。

维护面上，那 134 行运行时服务是在重造平台已经保证的能力（SPA 回退、ETag 与条件请求、content-type、缓存策略、安全头），并且需要自己跟进边界；交给 Static Assets 后这些是平台行为。

而"去掉 `[assets]`"并没有换来新的部署能力：上游形态本来就是 Workers 部署，`pnpm deploy` 一条命令同时发布脚本与资源。

将来若出现必须自托管资源的具体约束（部署通道不支持资源上传、需要把站点挂在已有 Worker 的路由前缀下、账号拿不到 Static Assets、或要在资源响应前插入鉴权与改写），再重新评估嵌入方案，并把约束写回本节。

## 与上游的已知偏离

`--env` 标志。上游在 `59b53bb` 新增 `[env.local]` 之后，`wrangler deploy --env=''` 会被判为"找不到名为 '' 的环境"而直接失败，因为 wrangler 一旦看到任何 `[env.*]` 段就会校验环境名。受影响的是三处：`package.json` 的 `test` 脚本、`make/deploy.mk`、以及 CI 的部署命令。本仓库把这三处的 `--env=''` 去掉，因为不带 `--env` 本来就是顶层（生产）配置。这是上游自身的缺陷，值得回报一个 Issue 或直接提 PR。

缺失资源的状态码。自研那版资源服务会区分"应用路由"与"文件请求"：`/network/ip/1.1.1.1` 回 SPA 壳，而 `/assets/missing.js` 回 404，避免脚本或字体 404 时浏览器拿到 HTML 并报出难懂的语法错误。Static Assets 的 `not_found_handling = "single-page-application"` 对任何未匹配路径一律回 SPA 壳加 200，包括带扩展名的缺失文件。这是平台语义，本仓库接受，不再自行兜一层。

## 上游跟踪点

当前基线：`9df298b`（2026-09-12），与上游持平。

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

合并时若 `wrangler.toml` 冲突，默认取上游：本仓库不再维护该文件的差异。只有当上游改动会破坏"静态请求不进 Worker"这一前提（例如把 `run_worker_first` 改回 `true`）时才需要提出异议，那会让上面的计费与冷启动结论反转。

## 部署

前提：先 `pnpm build` 产出 `dist`，`pnpm deploy` 会同时上传 Worker 脚本与 Static Assets 目录。基础功能不需要任何应用环境变量或 API Key。

方式一，Workers Builds（推荐，跟随提交自动发布）。在 Cloudflare 控制台 Workers & Pages 导入本仓库，生产分支 `main`，构建命令 `pnpm build`，部署命令 `pnpm deploy`，Node.js 24、pnpm 12.4.1，根目录保持默认。

方式二，GitHub Actions。在仓库 Settings 的 Secrets and variables 中添加 secret `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 与 variable `ENABLE_CF_DEPLOY=true`。构建与测试始终执行，只有开启该变量才进入部署作业；部署作业下载构建作业产出的 `dist` 后执行 `wrangler deploy`。

两种方式选一种，避免重复发布。自定义域名在 Worker 设置中绑定。

验证体验（Turnstile、reCAPTCHA v3）为可选能力，需要配置 Site Key、Secret 与允许域名，本地用 `.dev.vars`、线上用 Worker 变量与密钥，细节见 README 的对应章节。

## 本地开发

```bash
pnpm install
pnpm worker:dev
```

`http://127.0.0.1:8787` 同时提供页面与 `/api/*`。它由 Vite（5137）与 `wrangler dev --env local` 组成：`[env.local]` 把 `run_worker_first` 设为 `true`，所以本地所有请求都先过 Worker，再由 `LOCAL_DEV` 分支转发到 Vite，这与线上"静态请求不进 Worker"的行为不同，属有意为之。

若通过命名域名代理访问（例如 portless），注意 Vite 的 HMR 端口配置为 8787，HTTPS 页面下的 `ws://` 热更新连接会被混合内容策略拦截，需要手动刷新；脚本内写死的端口也不会被 portless 重写，用 `portless alias <名> 8787` 挂已运行的服务即可。

## 命名

Worker 名保持 `one-ip`、包名保持 `ip`，与上游一致，便于对照上游文档与教程。部署到已有同名 Worker 的账号时，在 `wrangler.toml` 自行改名即可。
