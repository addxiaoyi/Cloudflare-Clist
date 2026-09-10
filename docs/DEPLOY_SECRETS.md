# GitHub Secrets 配置

项目自动部署需要配置以下 GitHub Secrets：

## 1. Cloudflare 账户信息

### 获取方式

1. 登录 Cloudflare Dashboard
2. 进入 Workers & Pages → Overview
3. 点击右上角 API Tokens
4. 创建 Custom Token

### 需要的权限

```
- Account / Cloudflare Workers Scripts / Edit
```

## 2. 添加 Secrets

进入 GitHub 仓库 → Settings → Secrets and variables → Actions

添加以下两个 Secrets：

| Secret 名称 | 说明 | 示例值 |
|------------|------|--------|
| `CF_API_TOKEN` | Cloudflare API Token | `xxxx-xxxx-xxxx` |
| `CF_ACCOUNT_ID` | Cloudflare Account ID | `1234567890abcdef` |

## 3. 查找 Account ID

在 Cloudflare Dashboard 右下角或 Workers & Pages 页面左侧，找到 Account ID

## 4. 触发部署

推送到 master/main 分支后自动触发：
- workers/ 目录变更
- app/ 目录变更
- package.json 变更
- wrangler.jsonc 变更

手动触发：
```bash
git push
```

## 注意事项

- 首次部署前需要先在 Cloudflare 创建对应的 D1 数据库
- 环境变量和 Secrets 需要在 wrangler.jsonc 或 wrangler secret 中预先配置
- 如果部署失败，检查 GitHub Actions 日志并确认 Secrets 正确配置

## MySQL / Hyperdrive 配置

要支持 MySQL 数据库存储类型，需要配置 Cloudflare Hyperdrive。

### 1. 创建远程 MySQL 数据库

准备一个可公网访问的 MySQL 数据库（如 PlanetScale、Railway、Aiven、自建服务器）。

### 2. 创建 Hyperdrive 实例

```bash
# 安装 wrangler（如未安装）
npm install -g wrangler

# 登录 Cloudflare
wrangler login

# 创建 Hyperdrive 配置，替换连接串为实际值
wrangler hyperdrive create clist-hyperdrive \
  --connection-string="mysql://USER:PASSWORD@HOST:PORT/DATABASE_NAME"
```

输出会包含一个 Hyperdrive ID：
```
✅ Created Hyperdrive configuration
{
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "name": "clist-hyperdrive",
  ...
}
```

### 3. 更新 wrangler.jsonc

将生成的 ID 填入配置：

```jsonc
"hyperdrive": [
  {
    "binding": "HD",
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
]
```

### 4. 部署

```bash
npx wrangler deploy
```

### 5. 使用

在 Starx 首页 → 添加存储 → 类型选择 "MySQL 数据库" → 填写：

| 字段 | 说明 | 示例 |
|------|------|------|
| 显示名称 | 自定义存储名 | "生产数据库" |
| 描述 | 可选说明文字 | "订单系统 MySQL" |
| Hyperdrive 连接串 | 可留空，自动用 binding 配置 | （留空） |
| 数据库名 | 默认连接的数据库 | "my_database" |
| 表前缀 | 可选，过滤业务表 | "wp_" |

保存后点击存储，会跳转 `/mysql/{id}` 浏览表结构和执行 SQL 查询。

### 本地开发

`wrangler dev` 不会真正连接 Hyperdrive，需要 `localConnectionString` 指向本地 MySQL 或开发数据库：

```jsonc
{
  "binding": "HD",
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "localConnectionString": "mysql://root@localhost:3306/db"
}
```

### 安全建议

- Hyperdrive 凭据不要直接放在连接串里，使用 Cloudflare Secret
- 查询界面仅供管理，不要暴露到公网
- 如需只读浏览，给 MySQL 账号只授予 `SELECT` 权限

## R2 OAuth 环境变量

要支持通过 OAuth 授权访问他人 Cloudflare R2 存储桶，需要配置以下环境变量：

| 变量 | 说明 | 示例 |
|------|------|------|
| `CF_CLIENT_ID` | Cloudflare OAuth 客户端 ID | `xxxx.access` |
| `CF_CLIENT_SECRET` | Cloudflare OAuth 客户端密钥 | `xxxxx` |
| `CF_REDIRECT_URI` | 授权回调地址 | `https://your-domain/api/r2-oauth` |

### 获取 OAuth 凭证

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. API Tokens → Create Token
3. 选择 "Create Custom Token"，权限：
   - Account / R2 / Edit（或仅 Read）
4. 创建后获取 Client ID 和 Secret

或者使用 [Cloudflare Workers OAuth](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/oauth/) 应用：

1. Cloudflare Zero Trust → Applications → Add an application
2. 选择 OAuth 应用类型，回调地址填 `/api/r2-oauth`
3. 获取 Client ID / Client Secret

### 使用

1. 在存储配置中选择 "R2 存储桶（他人 OAuth）"
2. 填写对方 Cloudflare 账户 ID 和存储桶名
3. 点击 "通过 Cloudflare 授权"，登录对方账户授权后自动保存 token
4. 授权成功即可浏览对方 R2 存储桶文件

### 注意

- 授权后的 access token 保存在存储配置中，请确保管理员权限安全
- OAuth token 有效期有限，需要定期重新授权