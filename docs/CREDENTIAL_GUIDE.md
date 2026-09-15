# 凭证获取指南

每个渠道的访问凭证获取方法、官方入口与注意事项。本指南覆盖所有 18 个存储渠道，帮助你快速创建并填入正确的密钥。

> UI 侧已在每个字段旁补充了 `help` / `link` 提示，配合本文档使用更顺滑。

## 目录

1. [通用 S3 兼容](#通用-s3-兼容)
2. [OneDrive](#onedrive)
3. [Google Drive](#google-drive)
4. [阿里云盘](#阿里云盘)
5. [百度网盘](#百度网盘)
6. [夸克网盘](#夸克网盘)
7. [Tigris 对象存储](#tigris-对象存储)
8. [七牛云 KODO](#七牛云-kodo)
9. [Cloudflare R2](#cloudflare-r2)
10. [R2 OAuth（他人存储桶）](#r2-oauth他人存储桶)
11. [FTP / SFTP 文件网关](#ftp--sftp-文件网关)
12. [MySQL 数据库（Hyperdrive）](#mysql-数据库hyperdrive)
13. [Dropbox](#dropbox)
14. [GitHub](#github)
15. [GitLab](#gitlab)
16. [Gitea / Forgejo](#gitea--forgejo)
17. [Gitee](#gitee)
18. [WebDAV](#webdav)

---

## 通用 S3 兼容

适用于 AWS S3、MinIO、自建 S3、以及所有 S3 API 兼容服务。

**需要的字段**
- Endpoint（如 `https://s3.us-east-1.amazonaws.com`）
- Access Key / Secret Key
- Bucket
- 区域（Region，MinIO 可留空 `auto`）
- 签名版本（SigV4 默认，旧服务选 SigV2）
- 会话令牌（Session Token，STS 临时凭证）

**获取 Access Key & Secret**
- **AWS**：控制台 → IAM → Users → `Create Access Key` → `Access Key` / `Secret Access Key`。STS 临时凭证在 IAM → `Create Access Key` → `Temporary credentials` 或通过 STS AssumeRole 获取，拿到 `AccessKeyId`、`SecretAccessKey`、`SessionToken`。
  - 入口：https://console.aws.amazon.com/iam/home#/security_credentials
- **MinIO / 自建**：控制台 → Access Keys → `Create Access Key`。
- **R2**：官方入口见下节。

**注意事项**
- 临时凭证必须同时填入 `Session Token`，否则签名会失效。
- Endpoint 与区域必须匹配，否则返回 403。
- 路径风格（Path Style）对部分自建服务必需；虚拟主机风格对应 `bucket.endpoint/key`。

---

## OneDrive

**方式一：本地直连**
需要 `Client ID` / `Client Secret` / `Refresh Token`。

1. Microsoft 应用注册：https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
2. 创建应用 → `Authentication` 添加重定向 URI：`https://your-domain/api/onedrive/callback`
3. `Certificates & secrets` 新建 `Client secret`（记得保存）。
4. 使用工具获取 `refresh_token`（或在登录流程中自动获取）。

**方式二：在线 API 代理**
- UI 中打开 `使用在线 API`，无需自行创建凭证。
- 推荐默认接口：`https://api.oplist.org/onedrive/renewapi`。如需自建，参考项目 `api_address` 字段。

文档 & 链接：
- Microsoft 开发者注册入口：https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
- Graph API 文档：https://learn.microsoft.com/en-us/graph/

---

## Google Drive

**方式一：本地直连**
需要 `Client ID` / `Client Secret` / `Refresh Token`。

1. Google Cloud Console：https://console.cloud.google.com/apis/
2. 创建项目 → `OAuth consent screen` → 创建 OAuth 客户端（应用类型 Web）。
3. `Authorized redirect URIs` 填写：`https://your-domain/api/gdrive/callback`
4. 下载凭据获取 `client_id` 与 `client_secret`。
5. 通过授权链接获取 `refresh_token`。

**方式二：在线 API 代理**
- UI 中打开 `使用在线 API`。
- 默认接口：`https://api.oplist.org/gdrive/renewapi`。

链接：
- Google Cloud Console：https://console.cloud.google.com/apis/
- OAuth 客户端创建：https://console.cloud.google.com/apis/credentials

---

## 阿里云盘

使用官方 OpenAPI 授权，推荐 `使用在线 API`。

- 如需自建：阿里云盘开发者中心 → 应用管理 → 创建应用 → 获取 `Client ID` / `Client Secret`。
- 刷新令牌（`refresh_token`）需通过 OAuth 授权流程获取。

链接：
- 阿里云盘文档：https://help.aliyundrive.com/
- 开发论坛：https://developer.aliyundrive.com/

---

## 百度网盘

使用官方 OpenAPI，推荐 `使用在线 API`。

**自建凭证流程**：
1. 百度开发者中心：https://developer.baidu.com/console
2. 创建应用 → 应用管理 → 获取 `API Key` (Client ID) / `Secret Key` (Client Secret)。
3. 授权获取 `refresh_token`。

链接：
- 百度开发者中心：https://developer.baidu.com/console
- 百度开放平台文档：https://developer.baidu.com/

---

## 夸克网盘

**扫码登录（推荐）**
- 在存储配置表单里点击「扫码登录获取 Cookie」按钮，弹出二维码。
- 用夸克 App 扫码并确认登录，系统会自动取回登录 Cookie 并填入表单。
- 仅管理员可用该功能，Cookie 有效期约 30 天，过期后重新扫码即可。

**手动方式**
- 登录 https://pan.quark.cn/ → 浏览器开发者工具 → `Application / Storage` 导出 `cookie` 字符串。
- 直接填入 `cookie` 字段即可使用。

---

## Tigris 对象存储

S3 兼容，支持 STS 临时凭证。

**获取凭证**
1. 登录 https://console.storage.dev/
2. 左侧菜单 `Access Keys` → `Create New Access Key`
3. 记录 `Access Key ID` / `Secret Access Key`
4. 如使用 STS，创建临时凭证后填入 `Session Token`

链接：
- Tigris 控制台：https://console.storage.dev/
- Tigris 文档：https://docs.tigrisdata.com/

---

## 七牛云 KODO

S3 兼容服务，区域与 Endpoint 必须一致。

**获取凭证**
1. 登录 https://portal.qiniu.com/
2. 个人中心 → 密钥管理 → 复制 `Access Key` / `Secret Key`

**S3 空间名**
- 对象存储 → 空间管理 → 空间概览，查看 `S3 空间名`（非 KODO 空间名）。

**区域映射**
- 华东 z0 → `s3.cn-east-1.qiniucs.com`
- 华北 z1 → `s3.cn-north-1.qiniucs.com`
- 华南 z2 → `s3.cn-south-1.qiniucs.com`
- 北美 na0 → `s3.us-north-1.qiniucs.com`
- 亚太 as0 → `s3.ap-southeast-1.qiniucs.com`

详细配置见：[QINIU_CONFIG.md](./QINIU_CONFIG.md)

链接：
- 七牛云控制台：https://portal.qiniu.com/
- S3 兼容文档：https://developer.qiniu.com/kodo/4086/aws-s3-compatible

---

## Cloudflare R2

**绑定方式**
- Worker 内使用 `r2_buckets` 绑定，无需密钥。配置方式见 `DEPLOY_SECRETS.md`。

**手动访问**
- Endpoint 形如：`https://<account_id>.r2.cloudflarestorage.com`
- 需创建 API Token：Cloudflare Dashboard → My Profile → API Tokens → `Create Token` → `R2:Read/Write`。

链接：
- Cloudflare R2 文档：https://developers.cloudflare.com/r2/

---

## R2 OAuth（他人存储桶）

通过 Cloudflare OAuth 授权访问他人的 R2 存储桶。

**部署前置**
- 在 `wrangler.jsonc` 中配置环境变量：`CF_CLIENT_ID`、`CF_CLIENT_SECRET`、`CF_REDIRECT_URI`。
- OAuth 客户端创建步骤详见 `DEPLOY_SECRETS.md`。

**获取 OAuth 客户端**
1. Cloudflare Dashboard → Manage Account → OAuth clients → `Create client`
2. `Response type`：Code
3. `Grant type`：Authorization Code + Refresh Token
4. `Redirect URLs`：`https://your-domain/api/r2-oauth`
5. Scope 勾选 `r2:obj_read`、`r2:obj_write`、`r2:obj_list`
6. 创建后保存 Client ID / Client Secret

使用后在 UI 点击 `通过 Cloudflare 授权` 即可自动保存 token。

链接：
- 创建 OAuth 客户端官方文档：https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/

---

## FTP / SFTP 文件网关

**需要的字段**
- Endpoint（例如 `ftp.example.com` 或 `sftp://...`）
- 用户名 / 密码
- 根路径（可选）

**获取方式**
- 由你的 FTP / SFTP 服务器提供，通常在服务商控制台创建用户账号。
- Nginx/Apache 搭配 `mod_ftp`、Nextcloud、坚果云 等均可提供 WebDAV/FTP。

---

## MySQL 数据库（Hyperdrive）

通过 Cloudflare Hyperdrive 代理 MySQL，避免暴露公网。

**步骤**
1. 准备可公网访问的 MySQL（如 PlanetScale、Railway、自建）。
2. `wrangler hyperdrive create` 创建 Hyperdrive 配置，记下 ID。
3. 在 `wrangler.jsonc` 中配置绑定：
   ```jsonc
   "hyperdrive": [{ "binding": "HD", "id": "xxxxxxxx" }]
   ```
4. UI 中选择 `MySQL 数据库`，填写数据库名、`表前缀`，连接串可留空自动使用绑定。

**本地开发**
- `wrangler dev` 需要 `localConnectionString` 指向本地或开发数据库。

安全建议：
- 不要在连接串里明文写密码，建议使用 Cloudflare Secret。
- 查询界面仅供管理，不要暴露到公网。

详细步骤见：`DEPLOY_SECRETS.md` § MySQL / Hyperdrive 配置。

链接：
- Cloudflare Hyperdrive 文档：https://developers.cloudflare.com/hyperdrive/

---

## Dropbox

**获取访问令牌**
1. 访问 https://www.dropbox.com/developers/apps
2. `Create app` → 选择 `Scoped Access` → 选择 `Full Dropbox` 或 `App Folder`
3. `Generate access token` 复制 `Access Token`

**根路径**
- 默认使用根目录，可指定子路径。

链接：
- Dropbox 开发者控制台：https://www.dropbox.com/developers/apps

---

## GitHub

通过 Personal Access Token 访问仓库。

**获取 Token**
1. https://github.com/settings/tokens → `Generate new token (classic)`
2. 权限勾选 `repo`、`contents`、`metadata`
3. 复制 Token 到 `access_token`

使用 Token 前绑定仓库后可浏览文件树。

链接：
- GitHub Token 创建：https://github.com/settings/tokens/new?scopes=repo

---

## GitLab

**创建 Personal Access Token**
1. https://gitlab.com/-/user_settings/personal_access_tokens
2. 新建 Token，Scope 勾选 `read_api`、`read_repository`
3. 复制 Token 到 `access_token`

链接：
- GitLab Token 页面：https://gitlab.com/-/user_settings/personal_access_tokens

---

## Gitea / Forgejo

**创建 OAuth 应用**
1. 进入 Gitea 管理后台 → `Applications` → `New Application`
2. 填写名称、回调地址、授权类型
3. 保存 `client_id` / `client_secret`
4. 通过授权获取 `access_token`

链接：
- Gitea 文档：https://docs.gitea.com/

---

## Gitee

**创建 Personal Access Token**
1. https://gitee.com/profile/personal_access_tokens
2. 新建 Token，范围勾选 `repo`、`user`
3. 复制 Token 到 `access_token`

链接：
- Gitee Token 页面：https://gitee.com/profile/personal_access_tokens

---

## WebDAV

**获取凭证**
- 由你的 WebDAV 服务器提供用户名 / 密码。
- 典型服务：Nginx/Apache WebDAV、Nextcloud、坚果云、群晖 NAS。

**配置示例**
- 地址：`https://example.com/webdav`
- 用户名 / 密码 由服务器生成
- 根路径 可选

部署与排查指南：`docs/WEBDAV_SETUP.md`

---

### 通用安全提示

- Access Key / Secret Key / Token 不要提交到代码仓库，建议使用环境变量或 `.env` 管理。
- 临时凭证（STS）有效期短，定期刷新。
- Token 仅显示一次，创建后请立即备份。
- 定期轮换密钥，撤销不再使用的 Token。

### 参考文档

- MySQL/Hyperdrive & R2 OAuth 部署细节：[`DEPLOY_SECRETS.md`](./DEPLOY_SECRETS.md)
- 七牛云 S3 配置细节：[`QINIU_CONFIG.md`](./QINIU_CONFIG.md)
- WebDAV 部署指南：[`docs/WEBDAV_SETUP.md`](./WEBDAV_SETUP.md)

更新日期：2026-09-15
