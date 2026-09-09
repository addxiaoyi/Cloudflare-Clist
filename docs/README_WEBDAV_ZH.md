# Starx - WebDAV 功能说明

## 概述

Starx 现在完全支持 WebDAV 协议，允许你通过标准的 WebDAV 客户端访问云存储。

## 快速开始

### 1. 启用 WebDAV

在 Cloudflare Workers 环境变量中设置：

```json
{
  "WEBDAV_ENABLED": "true",
  "WEBDAV_USERNAME": "你的用户名",
  "WEBDAV_PASSWORD": "你的密码"
}
```

### 2. 获取 WebDAV URL

- 访问所有存储：`https://你的域名/dav/0/`
- 访问特定存储：`https://你的域名/dav/{存储ID}/`

⚠️ **重要**：URL 必须以 `/` 结尾！

### 3. 连接客户端

#### Windows
推荐使用：RaiDrive、NetDrive 或 Cyberduck

#### macOS
1. Finder → 前往 → 连接到服务器 (⌘K)
2. 输入 WebDAV URL
3. 输入用户名和密码

#### Linux
```bash
sudo mount -t davfs https://你的域名/dav/11/ /mnt/webdav
```

#### 移动设备
- iOS: Documents by Readdle
- Android: Solid Explorer、FX File Explorer

## 常见问题

### 405 Method Not Allowed 错误

**快速解决**：
1. 确认 `WEBDAV_ENABLED = "true"` (必须是字符串)
2. 确保 URL 以 `/` 结尾
3. 重新部署 Worker：`npm run deploy`

详细解决方案：[WebDAV 快速修复指南](./WEBDAV_快速修复.md)

### 401 Unauthorized 错误

检查用户名和密码是否正确。

### 404 Not Found 错误

访问 `https://你的域名/dav/0/` 查看所有可用的存储 ID。

## 支持的操作

| 操作 | 说明 | 状态 |
|------|------|------|
| 浏览文件 | 列出文件和文件夹 | ✅ |
| 下载文件 | 获取文件内容 | ✅ |
| 上传文件 | 创建或覆盖文件 | ✅ |
| 删除 | 删除文件或文件夹 | ✅ |
| 创建文件夹 | 新建目录 | ✅ |
| 复制 | 复制文件 | ✅ |
| 移动/重命名 | 移动或重命名文件 | ✅ |

## 测试工具

### 快速测试

**Windows PowerShell**：
```powershell
Invoke-WebRequest -Uri "https://你的域名/dav/11/" -Method OPTIONS
```

**Linux/macOS**：
```bash
curl -i -X OPTIONS https://你的域名/dav/11/
```

应该返回状态码 200 和 `DAV: 1, 2` 头部。

### 完整测试

**Windows**：
```powershell
.\scripts\test-webdav.ps1 -BaseUrl "https://你的域名" -Username "用户名" -Password "密码" -StorageId 11
```

**Linux/macOS**：
```bash
./scripts/test-webdav.sh https://你的域名 用户名 密码 11
```

## 文档

- 📖 [完整配置指南](./WEBDAV_SETUP.md) - 详细的配置和使用说明
- 🔧 [故障排查清单](./WEBDAV_TROUBLESHOOTING.md) - 常见问题解决方案
- 🚀 [快速修复指南](./WEBDAV_快速修复.md) - 针对 405 错误的快速解决
- 📋 [修复总结](./WEBDAV_FIX_SUMMARY.md) - 技术细节和改进说明

## 安全建议

1. ✅ 使用强密码
2. ✅ 仅通过 HTTPS 访问
3. ✅ 定期更换密码
4. ✅ 监控访问日志
5. ⚠️ 不要在公共网络使用

## 性能提示

- 批量操作优于逐个操作
- 启用客户端缓存
- 大文件使用分块传输
- 避免频繁的 PROPFIND 请求

## 限制

- 不支持文件锁定（LOCK/UNLOCK）
- 受 Cloudflare Workers 限制：
  - 请求体大小限制（免费版 100MB）
  - 执行时间限制
- 并发写入可能导致冲突

## 获取帮助

- 📧 邮箱：laowan345@gmail.com
- 🐛 GitHub Issues：https://github.com/ooyyh/Cloudflare-Clist/issues
- 📚 文档：查看 `docs/` 目录下的详细文档

## 更新日志

查看 [CHANGELOG_WEBDAV.md](../CHANGELOG_WEBDAV.md) 了解最新更新。

---

**最后更新**：2026-06-12  
**版本**：1.1.0
