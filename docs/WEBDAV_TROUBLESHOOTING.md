# WebDAV 故障排查快速检查清单

## 问题：405 Method Not Allowed

### 检查步骤

#### ✅ 1. 检查环境变量配置

**本地开发环境** (`.dev.vars`):

```env
WEBDAV_ENABLED=true
WEBDAV_USERNAME=your_username
WEBDAV_PASSWORD=your_password
```

**生产环境** (Cloudflare Dashboard):

1. 登录 Cloudflare Dashboard
2. Workers & Pages → 你的 Worker → Settings → Variables
3. 确认存在：
   - `WEBDAV_ENABLED` = `true` (字符串，不是布尔值)
   - `WEBDAV_USERNAME` = 你的用户名
   - `WEBDAV_PASSWORD` = 你的密码

#### ✅ 2. 检查 URL 格式

**正确格式**：

- ✅ `https://your-domain/dav/11/` (有尾部斜杠)
- ✅ `https://your-domain/dav/0/` (访问所有存储)

**错误格式**：

- ❌ `https://your-domain/dav/11` (缺少尾部斜杠)
- ❌ `http://your-domain/dav/11/` (使用 HTTP 而不是 HTTPS)

#### ✅ 3. 测试 WebDAV 是否启用

**方法 A: 使用 curl**

```bash
curl -i -X OPTIONS https://your-domain/dav/11/
```

**期望结果**：

```
HTTP/2 200
DAV: 1, 2
Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE
```

**方法 B: 使用 PowerShell**

```powershell
Invoke-WebRequest -Uri "https://your-domain/dav/11/" -Method OPTIONS
```

#### ✅ 4. 测试认证

```bash
# 替换 username:password
curl -i -X PROPFIND \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  -H "Depth: 1" \
  https://your-domain/dav/11/
```

**期望结果**：

- 状态码：`207 Multi-Status`
- 响应体：XML 格式的文件列表

**如果返回 401**：

- 检查用户名密码是否正确
- 确认 Base64 编码正确

#### ✅ 5. 检查部署状态

```bash
# 确保代码已部署
wrangler deploy

# 或者查看部署历史
wrangler deployments list
```

#### ✅ 6. 检查路由配置

确认 `app/routes.ts` 中存在：

```typescript
route("dav/:storageId/*", "routes/dav.$storageId.$.ts"),
```

#### ✅ 7. 重新部署 (如果修改了代码)

```bash
# 构建并部署
npm run build
npm run deploy

# 或者使用 wrangler
wrangler deploy
```

## 常见错误及解决方案

### 错误：`WEBDAV_ENABLED is not true`

**原因**：环境变量配置错误

**解决**：

1. 检查拼写：`WEBDAV_ENABLED` (全大写)
2. 值必须是字符串 `"true"`，不是布尔值 `true`
3. 重新部署

### 错误：`401 Unauthorized`

**原因**：认证失败

**解决**：

1. 检查用户名密码
2. 确认环境变量已设置
3. 尝试使用管理员凭据（如果未设置 WebDAV 凭据）

### 错误：`404 Not Found`

**原因**：Storage ID 不存在或路径错误

**解决**：

1. 确认 Storage ID 存在
2. 检查 URL 路径格式
3. 尝试访问 `/dav/0/` 查看所有存储

### 错误：`403 Forbidden`

**原因**：尝试修改根目录

**解决**：

- 不能直接修改 `/dav/0/`
- 必须指定具体的 Storage ID，如 `/dav/11/`

## 快速诊断命令

### 完整测试流程

```bash
# 设置变量
DOMAIN="your-domain"
USERNAME="your_username"
PASSWORD="your_password"
STORAGE_ID="11"

# 1. 测试连接
curl -i -X OPTIONS "https://$DOMAIN/dav/$STORAGE_ID/"

# 2. 测试认证和列表
curl -i -X PROPFIND \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  -H "Depth: 1" \
  "https://$DOMAIN/dav/$STORAGE_ID/"

# 3. 上传测试
echo "test" | curl -i -X PUT \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  --data-binary @- \
  "https://$DOMAIN/dav/$STORAGE_ID/test.txt"

# 4. 下载测试
curl -X GET \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  "https://$DOMAIN/dav/$STORAGE_ID/test.txt"

# 5. 清理
curl -i -X DELETE \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  "https://$DOMAIN/dav/$STORAGE_ID/test.txt"
```

### 使用测试脚本

**Linux/macOS**:

```bash
chmod +x scripts/test-webdav.sh
./scripts/test-webdav.sh https://your-domain username password 11
```

**Windows**:

```powershell
.\scripts\test-webdav.ps1 -BaseUrl "https://your-domain" -Username "username" -Password "password" -StorageId 11
```

## 检查 Cloudflare Workers 日志

```bash
# 实时查看日志
wrangler tail

# 或者在 Cloudflare Dashboard 查看
# Workers & Pages → 你的 Worker → Logs
```

## 验证代码更新

### 检查文件是否有最新修复

1. 检查 `app/routes/dav.$storageId.$.ts`:
   - 应该有 `handleWebdavRequest` 函数
   - `loader` 和 `action` 都调用 `handleWebdavRequest`
   - OPTIONS 响应包含 CORS 头
   - PROPFIND 响应包含 `DAV: 1, 2` 头

2. 确认文件没有重复的代码块

3. 重新构建和部署：
   ```bash
   npm run build
   npm run deploy
   ```

## 仍然无法解决？

1. 查看完整文档：`docs/WEBDAV_SETUP.md`
2. 检查 Cloudflare Workers 配额和限制
3. 尝试使用不同的 WebDAV 客户端
4. 提交 Issue 到 GitHub 仓库

## 成功标志

当一切正常时，你应该能够：

1. ✅ OPTIONS 请求返回 200 和 DAV 头
2. ✅ PROPFIND 请求返回 207 和 XML 列表
3. ✅ PUT 请求返回 201 (文件上传成功)
4. ✅ GET 请求返回 200 和文件内容
5. ✅ DELETE 请求返回 204 (删除成功)
6. ✅ WebDAV 客户端能够成功连接和浏览文件

---

**最后更新**: 2026-06-12
**版本**: 1.0
