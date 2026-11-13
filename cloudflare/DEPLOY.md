# CKUN Studio · 免费测试版部署

目标地址：**https://ckun.cc/ckunstudio**。API：`/ckunstudio/api/`。使用现有 Cloudflare Pages 项目 `gerenzhan`，由 `/CK_STUDIO` 页面提供“团队协作”入口。

## 当前方案

采用 Pages Functions + D1，不需要 R2 订阅，也不需要独立服务器或持续开机的电脑。账号、任务、BUG、思路及小图附件均保存于 D1。字体默认微软雅黑。

- 每条最多 5 张图片，每张最多 512KB。
- 大图在浏览器内自动缩放并转为 WebP，再上传；小图保留原文件。
- 图片仍需登录读取，不放在公开静态资源目录。
- 标题、详情、执行人、状态、优先级、截止日期、搜索及统计功能不变。
- 每 6 秒同步列表；版本号和原子条件更新防止并发覆盖。

R2 虽有免费使用额度，但需开通订阅结算且超额收费，因此此版没有启用 R2。D1 免费计划的当前额度是每天 500 万行读取、10 万行写入、账户共 5GB 存储，单个免费数据库最大 500MB。免费额度用尽时请求受限，不会自动升级付费。Pages Functions 也受账号免费请求和运行额度约束。实际以账号套餐及 Cloudflare 最新规则为准。

官方来源：[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[R2 开通要求](https://developers.cloudflare.com/r2/get-started/)。

## 已配置资源

- 既有 Pages 项目：`gerenzhan`，域名 `ckun.cc`、`www.ckun.cc`。
- 新建 D1：`ckunstudio`，绑定 `STUDIO_DB`。
- 数据迁移：`0001_studio.sql`、`0002_d1_image_data.sql`。
- Pages 加密 Secret：`STUDIO_AUTH_SECRET`、`STUDIO_SETUP_KEY`。
- 正式绑定声明：个人站 `wrangler.jsonc`。没有 R2 绑定。
- 随机密钥备份：个人站 `.env.ckunstudio.production`（已被 Git 忽略，勿提交、公开或随静态资源上传）。

请保管 `STUDIO_AUTH_SECRET`，更换会使已有密码无法验证。初始化密钥只用于第一次创建团队，不能当作普通登录密码。

## 发布与首次使用

在个人站目录运行 `npm run build`，通过既有 Git 集成发布，或使用：

```powershell
npx wrangler pages deploy dist --project-name gerenzhan --branch master
```

不要仅上传静态 ZIP：Pages Functions 需要由 Wrangler 或 Git 构建处理。发布后访问 `/ckunstudio`，使用 `.env.ckunstudio.production` 中 `STUDIO_SETUP_KEY` 的值创建第一个账号。随后点击“团队成员与邀请”，邀请另外两位成员各自注册。

公开页面首次创建账号受初始化密钥保护，不会被访客抢先创建团队。其他成员需邀请码加入；所有成员共享一个空间，并可编辑、删除团队记录。

## 本地验证

仅使用本地模拟资源，不触碰线上数据：

```powershell
npm run build
npx wrangler d1 migrations apply STUDIO_DB --local --config wrangler.studio.local.jsonc
npx wrangler pages dev dist --port 8790 --d1 STUDIO_DB=00000000-0000-0000-0000-000000000001 --binding STUDIO_AUTH_SECRET=local-development-only-not-a-production-secret-2026 --binding STUDIO_SETUP_KEY=local-setup-key-do-not-use-in-production --compatibility-date 2026-11-13
```

本地入口：`http://localhost:8790/ckunstudio`。当前 Pages 不接受自定义配置路径，因此本地开发通过参数指定绑定；迁移使用本地配置。示例密钥只用于本地测试，不可写入生产环境。`.wrangler/` 为模拟数据，Git 已忽略。

协作软件目录中的 `node cloudflare/smoke.mjs http://127.0.0.1:8790` 可验证完整流程；脚本禁止对公网地址运行，避免污染线上数据。

## 范围及后续

本版用于 3 人小团队的免费测试，图片压缩会影响原图细节，不能用作源素材仓库。大文件和原始美术资源仍通过现有版本管理工具保存。尚未提供多团队隔离、管理员管理、密码找回、评论和编辑历史。

原 Node.js 本地版的数据不会自动迁移到云端。生产团队由用户自行首次初始化；本地测试账号不会上传。
