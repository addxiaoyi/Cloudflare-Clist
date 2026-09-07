# 使用 GitHub Actions Workflow 部署 CList

本文档说明如何使用仓库内置的 GitHub Actions 工作流自动部署到 Cloudflare Workers，并在部署前自动执行 D1 migrations。

## 工作流概览

内置工作流位于 `./.github/workflows/deploy.yml`，触发方式与流程如下：

- 触发：`main`/`master` 分支 push，或手动 `workflow_dispatch`
- 流程：Checkout → Node 24 → `npm ci` → 生成 `wrangler.jsonc` → `npm run build` → D1 migrations → `wrangler deploy` → 配置管理员 Secrets

## 前置条件

1. Cloudflare 账号已启用 Workers 与 D1
2. 已创建 D1 数据库
3. 已生成 Cloudflare API Token（需要访问 Workers 和 D1 的权限）
4. 代码已推送到 GitHub 仓库

## 1. 准备 Cloudflare 资源

在本地完成登录与数据库创建（如已创建可跳过）：

```bash
wrangler login
wrangler d1 create clist
```

如需手动获取数据库 ID：

```bash
wrangler d1 list
```

## 2. 配置 GitHub Secrets

在 GitHub 仓库设置中找到 “Secrets and variables → Actions → Secrets”，添加以下密钥：

| Secret | 用途 | 必填 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | 是 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | 是 |
| `ADMIN_USERNAME` | 管理员账号 | 是 |
| `ADMIN_PASSWORD` | 管理员密码 | 是 |
| `WEBDAV_USERNAME` | WebDAV 用户名 | 否 |
| `WEBDAV_PASSWORD` | WebDAV 密码 | 否 |

## 3. 配置 GitHub Variables

在 “Secrets and variables → Actions → Variables” 中添加变量。以下为默认值（可按需调整）：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `WORKER_NAME` | `clist` | Worker 名称 |
| `WORKER_MAIN` | `./workers/app.ts` | Worker 入口 |
| `COMPATIBILITY_DATE` | `2025-04-04` | Workers 兼容日期 |
| `D1_DATABASE_NAME` | `clist` | D1 数据库名称 |
| `D1_DATABASE_ID` | 空 | 留空则通过 API 自动查找 |
| `D1_BINDING` | `DB` | D1 绑定名 |
| `D1_MIGRATIONS_DIR` | `./migrations` | migrations 目录 |
| `OBSERVABILITY_ENABLED` | `true` | 可观测性开关 |
| `VALUE_FROM_CLOUDFLARE` | 空 | 示例变量 |
| `SITE_TITLE` | 空 | 站点标题 |
| `SITE_ANNOUNCEMENT` | 空 | 站点公告 |
| `CHUNK_SIZE_MB` | 空 | 上传分片大小 |
| `WEBDAV_ENABLED` | 空 | `true`/`false` |

说明：

- 若未设置 `D1_DATABASE_ID`，工作流会使用 API Token + Account ID 自动查找数据库 ID。
- `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` 未设置时，将沿用管理员账号密码。
- 管理员凭据通过 `wrangler secret` 写入（经 stdin，不经过命令行参数），密码含 `$`、反引号等特殊字符也不会被破坏；`ADMIN_USERNAME`/`ADMIN_PASSWORD` 缺失时工作流会直接失败，避免“部署成功但登录不了”。

## 4. 触发部署

二选一：

1. 推送代码到 `main` 或 `master` 分支触发自动部署。
2. 进入 GitHub Actions，选择 “Deploy to Cloudflare Workers”，点击 “Run workflow” 手动触发。

## 5. 部署后检查

1. 在 Cloudflare Workers 控制台确认脚本已更新。
2. 访问你的域名或 Workers 默认域名，检查页面与 API 是否正常。

## 常见问题

- D1 查找失败：确认 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 正确，或手动填写 `D1_DATABASE_ID`。
- migrations 失败：确认 `D1_DATABASE_NAME` 与 `D1_MIGRATIONS_DIR` 正确。
- 部署失败：检查必填 Secrets 是否缺失，特别是管理员账号密码相关配置。
