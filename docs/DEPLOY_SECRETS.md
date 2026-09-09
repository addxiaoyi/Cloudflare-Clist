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