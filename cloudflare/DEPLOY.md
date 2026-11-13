# CKUN Studio · Cloudflare 网页部署

目标地址：**https://ckun.cc/ckunstudio**。API 为 `/ckunstudio/api/`。应用是现有 Astro 网站的一部分，`/CK_STUDIO` 增加“团队协作”入口；个人站其他页面继续使用静态生成。

## 结构

- `public/ckunstudio/`：独立网页、样式与脚本，默认微软雅黑。
- `functions/ckunstudio/api/[[path]].js`：Cloudflare Pages Functions 入口。
- `lib/studio-api.mjs`：认证及团队协作 API。
- `migrations/studio/0001_studio.sql`：账号、会话、任务、图片索引及限流数据。
- `public/_routes.json`：只有 `/ckunstudio/api/*` 调用 Functions；其他页面静态服务。
- `public/_headers`：仅对协作应用设置安全头、禁止搜索引擎索引。

## 在现有 Cloudflare Pages 项目中配置

沿用当前绑定 `ckun.cc` 的项目，不创建替代网站，不更换域名。不需要独立服务器或 Windows 持续开机。

1. 在 Cloudflare 创建 D1 数据库，例如 `ckunstudio`，执行 `migrations/studio/0001_studio.sql`。可以在 D1 控制台执行 SQL，或使用 Wrangler：`npx wrangler d1 execute ckunstudio --remote --file migrations/studio/0001_studio.sql`。
2. 创建 R2 桶，例如 `ckunstudio-images`，保持私有，**不要开启公开访问**。附件由登录接口读取。R2 需在账号中可用，若账号要求开通服务，请由账号所有者处理。
3. 在当前 Pages 项目的 Settings → Bindings 添加 D1 绑定 **`STUDIO_DB`** 和 R2 绑定 **`STUDIO_IMAGES`**。Production 与 Preview 独立配置，预览使用独立测试数据库和桶。
4. 在生产环境添加两个加密 Secret：**`STUDIO_AUTH_SECRET`**（至少 32 个随机字符，建议 64 字符）和 **`STUDIO_SETUP_KEY`**（至少 24 个随机字符，建议 48 字符）。两个值应不同，均不提交到 Git。`STUDIO_AUTH_SECRET` 用作密码 pepper，务必长期保管，改变它会导致已有密码失效。`STUDIO_SETUP_KEY` 只用于首次初始化，不是日常登录密码。
5. 保持构建命令 `npm run build`、输出目录 `dist`、项目根目录为当前 Astro 项目目录。Pages Git 集成会从根目录 `functions/` 构建 Functions；若使用直接上传，使用 `wrangler pages deploy dist --project-name <实际已有项目名>`，不要仅上传 `dist` 的 ZIP，因为 ZIP 静态上传不会构建 Functions。
6. 将本次提交发布到现有生产分支，或按当前网站原有发布方式部署。在绑定或 Secret 变动后重新部署，确保生效。
7. 打开 `/ckunstudio`，用初始化密钥创建第一个账号。然后点击“团队成员与邀请”，向另外两位成员提供应用地址和邀请码。其余成员各自注册，不共享登录密码。

未配置绑定或 Secret 时，API 会返回 503 及说明，不会使用浏览器本地存储假装多人同步。首次初始化由密钥保护，防止公开 URL 被其他人抢先注册。数据库中初始化标记、首个账号及邀请码通过 D1 批处理原子提交。

## 本地 Cloudflare 运行时验证

`wrangler.studio.local.jsonc` **仅用于本地模拟**，里面全是公开测试值，不可用于线上部署。安装 Wrangler 后：

```powershell
npm run build
npx wrangler d1 migrations apply STUDIO_DB --local --config wrangler.studio.local.jsonc
npx wrangler pages dev dist --port 8790 --d1 STUDIO_DB=00000000-0000-0000-0000-000000000001 --r2 STUDIO_IMAGES --binding STUDIO_AUTH_SECRET=local-development-only-not-a-production-secret-2026 --binding STUDIO_SETUP_KEY=local-setup-key-do-not-use-in-production --compatibility-date 2026-11-13
```

打开 `http://localhost:8790/ckunstudio`。本地首次初始化密钥见本地配置中的 `STUDIO_SETUP_KEY`。当前 Pages 不支持 `--config` 自定义路径，因此本地运行通过上述参数绑定，迁移则使用配置文件。不要对该配置添加 `--remote`，不要将其用作生产配置。`.wrangler/` 为本地模拟数据，已忽略。

## 数据及使用范围

所有成员共享一个团队空间，均可编辑和删除记录。每 6 秒同步列表；编辑时通过数据库条件更新及版本号避免互相覆盖。每条最多 5 张 PNG/JPEG/WebP 图片，总计 8MB；R2 保存图片本体，D1 保存元数据。删除记录会删除关联元数据，并异步清理 R2 对象；若对象清理失败可能遗留不可通过应用访问的孤立对象，需要运维清理。

现有 Node.js 本地版本的数据不会自动迁移到云端。部署后首次创建新的团队账号。会话 Cookie 限于 `/ckunstudio` 路径、HttpOnly、SameSite=Strict，HTTPS 下启用 Secure。密码使用带 Secret pepper 的 PBKDF2-SHA256，不保存明文。

上线后应启用 Cloudflare 账号的备份与访问保护，记录 D1 与 R2 资源对应关系。此版本未提供密码找回、管理员成员管理、历史版本或附件回收站。

## 验证状态

代码与本地模拟验证结果见协作软件项目的 `cloudflare/验证记录.md`。只有 Cloudflare 发布完成并访问生产接口后，才能确认线上可用；本地构建通过不代表已上线。
