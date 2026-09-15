# WebDAV 快速配置

## 启用 WebDAV

在 Cloudflare Workers 环境变量中设置：

```json
{
  "vars": {
    "WEBDAV_ENABLED": "true",
    "WEBDAV_USERNAME": "your_webdav_username",
    "WEBDAV_PASSWORD": "your_webdav_password"
  }
}
```

> `WEBDAV_USERNAME` 和 `WEBDAV_PASSWORD` 是可选的。如果不设置，将使用管理员凭据。

## WebDAV 访问 URL

启用后，通过以下方式访问存储：

- 所有存储根目录: `https://your-domain/dav/0/`
- 特定存储: `https://your-domain/dav/{storage_id}/`

⚠️ **重要**: URL 必须以斜杠 `/` 结尾！

例如：

- ✅ 正确：`https://your-domain/dav/11/`
- ❌ 错误：`https://your-domain/dav/11`

## 客户端连接

### Windows

映射网络驱动器，使用 WebDAV URL。

**推荐第三方客户端**：

- RaiDrive
- NetDrive
- Cyberduck

### macOS

Finder → 前往 → 连接到服务器，输入 WebDAV URL。

### Linux

使用 `davfs2` 或文件管理器的内置 WebDAV 支持。

### 移动设备

使用任何支持 WebDAV 的文件管理器应用（例如：Documents、FE File Explorer）。

## 故障排查

### 错误 405 Method Not Allowed

**原因**：

1. `WEBDAV_ENABLED` 未设置为 `"true"`
2. URL 格式不正确（缺少尾部斜杠）
3. WebDAV 功能未正确部署

**解决方案**：

1. 确认环境变量 `WEBDAV_ENABLED = "true"`（必须是字符串）
2. 确保 URL 以 `/` 结尾
3. 重新部署 Worker

### 测试连接

```bash
# 测试 WebDAV 是否启用
curl -i -X OPTIONS https://your-domain/dav/11/

# 应该返回：
# DAV: 1, 2
# Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE

# 测试认证和列表
curl -i -X PROPFIND \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  -H "Depth: 1" \
  https://your-domain/dav/11/
```

## 完整文档

更多配置选项、客户端设置和故障排查，请参阅 [完整 WebDAV 配置指南](./WEBDAV_SETUP.md)。
