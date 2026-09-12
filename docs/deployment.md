# 部署指南

## 方式一：Cloudflare Git 集成（推荐，一键部署）

在 Cloudflare 控制台把 GitHub 仓库连接到 Worker 后，每次 `git push` 都会自动构建并部署，无需 API Token，也无需手动创建 D1 / R2。

### 操作步骤

1. 将仓库推送到 GitHub（确保 `wrangler.jsonc` 已提交，它是部署配置的来源）。
2. 打开 [Cloudflare 控制台](https://dash.cloudflare.com) → **Workers 和 Pages** → **创建** → **Workers** → **连接 Git 仓库**。
3. 选择仓库与分支（默认 `main`）。
4. 在构建设置中填写：

   | 配置项 | 值 |
   | --- | --- |
   | 构建命令 | `npm run build` |
   | 部署命令 | `npx wrangler deploy --config build/server/wrangler.json` |
   | 根目录 | 留空 |

5. 保存后，推送代码即自动部署。

### 自动创建的资源

- **D1 数据库**：`wrangler.jsonc` 中只声明了 `database_name`（未写 `database_id`），wrangler 部署时按名称自动查找或创建；应用首次访问时自动建表（`CREATE TABLE IF NOT EXISTS`），无需手动迁移。
- **R2 桶**：同理，按 `bucket_name` 自动创建。
- 因此首次部署**零配置**即可运行，默认管理员 `admin / changeme`。

### 修改默认凭据

上线后请在 **Cloudflare 控制台 → Worker → Settings → Variables and Secrets** 中：

- 将 `ADMIN_PASSWORD` 改为自定义强密码（Secret）。
- 启用 WebDAV / Google Drive / OneDrive / R2 OAuth 时，把 `WEBDAV_USERNAME`、`WEBDAV_PASSWORD`、`GOOGLE_CLIENT_SECRET`、`ONEDRIVE_CLIENT_SECRET`、`CF_CLIENT_SECRET` 等敏感项添加为 Secret。

### 启用 MySQL 存储（可选）

MySQL 存储必须通过 Cloudflare **Hyperdrive** 访问（Workers 无法直接建立到公网 3306 的 TCP 连接）：

1. 在 Cloudflare 控制台 → **Hyperdrive** → **创建**，指向你的 MySQL 数据库（或使用 CLI）：

   ```bash
   npx wrangler hyperdrive create clist-mysql --connection-string="mysql://user:pass@host:3306/dbname"
   ```

2. 将返回的 **Hyperdrive ID** 填入 `wrangler.jsonc`（取消注释并替换占位符）：

   ```json
   "hyperdrive": [
     {
       "binding": "HD",
       "id": "你的-Hyperdrive-ID",
       "localConnectionString": "mysql://root:password@localhost:3306/db"
     }
   ]
   ```

3. 提交并推送，触发重新部署。
4. 在「存储管理」中添加 **MySQL 数据库** 类型存储，只需填写**数据库名**即可；连接自动走已绑定的 Hyperdrive（连接串为运行时动态值，无需手填）。

> 未绑定 Hyperdrive 时，存储表单可填「直连连接串」作为回退，但仅适用于本地/开发场景。

## 方式二：本地 CLI 部署

```bash
npm run deploy
```

等价于：

```bash
npm run build
wrangler deploy --config build/server/wrangler.json
```

首次使用需先 `wrangler login`（或在 `CLOUDFLARE_API_TOKEN` 环境变量中提供 Token）。D1 与 R2 同样会在首次部署时自动创建。

## 部署后检查

1. 在 Cloudflare Workers 控制台确认 Worker 已更新。
2. 访问你的域名或 `*.workers.dev` 默认域名，检查页面与 API 是否正常。
3. 使用默认管理员 `admin / changeme` 登录，进入「存储管理」挂载存储；R2 桶会自动出现。
4. 修改默认管理员密码（见上文）。
