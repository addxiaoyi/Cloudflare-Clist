# WebDAV 完整配置指南

## 问题诊断

### 常见错误

#### 1. 405 Method Not Allowed

**原因**：

- WebDAV 未启用（`WEBDAV_ENABLED` 不是 "true"）
- 路由配置问题
- URL 格式不正确

**解决方案**：

1. 确保 Cloudflare Workers 环境变量中设置了 `WEBDAV_ENABLED = "true"`
2. 确保 URL 格式正确（需要以斜杠结尾）：
   - ✅ 正确：`https://your-domain/dav/11/`
   - ❌ 错误：`https://your-domain/dav/11`（缺少尾部斜杠）

#### 2. 401 Unauthorized

**原因**：认证失败

**解决方案**：

- 检查用户名密码是否正确
- 确认环境变量 `WEBDAV_USERNAME` 和 `WEBDAV_PASSWORD` 已设置

#### 3. 403 Forbidden

**原因**：WebDAV 功能未启用

**解决方案**：
在 Cloudflare Workers 中设置环境变量 `WEBDAV_ENABLED = "true"`

## 配置步骤

### 1. 本地开发环境配置

创建或修改 `.dev.vars` 文件（不要提交到 git）：

```env
WEBDAV_ENABLED=true
WEBDAV_USERNAME=your_username
WEBDAV_PASSWORD=your_password
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin_password
```

### 2. Cloudflare Workers 生产环境配置

#### 方法 A：通过 Cloudflare Dashboard

1. 登录 Cloudflare Dashboard
2. 进入 Workers & Pages
3. 选择你的 Worker
4. 进入 Settings → Variables
5. 添加以下环境变量：

```
WEBDAV_ENABLED = true
WEBDAV_USERNAME = your_username
WEBDAV_PASSWORD = your_password
```

#### 方法 B：通过 wrangler 命令行

```bash
wrangler secret put WEBDAV_PASSWORD
wrangler secret put WEBDAV_USERNAME
```

然后在 `wrangler.toml` 或 `wrangler.jsonc` 中添加：

```json
{
  "vars": {
    "WEBDAV_ENABLED": "true",
    "WEBDAV_USERNAME": "your_username",
    "WEBDAV_PASSWORD": "your_password"
  }
}
```

### 3. WebDAV 访问 URL

WebDAV 服务提供两种访问方式：

#### A. 访问所有存储（根目录）

```
https://your-domain/dav/0/
```

这会列出所有可用的存储，每个存储显示为一个文件夹。

#### B. 访问特定存储

```
https://your-domain/dav/{storage_id}/
```

例如：

```
https://your-domain/dav/11/
```

⚠️ **重要**：URL 必须以斜杠 `/` 结尾！

## 客户端配置

### Windows

#### 方法 1：映射网络驱动器

1. 打开"此电脑"
2. 点击"映射网络驱动器"
3. 输入 WebDAV URL：`https://your-domain/dav/11/`
4. 勾选"使用其他凭据连接"
5. 输入用户名和密码

#### 方法 2：添加网络位置

1. 打开"此电脑"
2. 右键点击空白处 → "添加一个网络位置"
3. 输入 WebDAV URL
4. 输入用户名和密码

**Windows 注意事项**：

- Windows 默认不支持 HTTPS 基本认证的 WebDAV，可能需要修改注册表
- 或者使用第三方 WebDAV 客户端如 RaiDrive、NetDrive 等

### macOS

#### Finder 连接

1. 打开 Finder
2. 菜单栏：前往 → 连接服务器（Command+K）
3. 输入服务器地址：`https://your-domain/dav/11/`
4. 点击"连接"
5. 选择"注册用户"
6. 输入用户名和密码

### Linux

#### 使用 davfs2

```bash
# 安装 davfs2
sudo apt-get install davfs2  # Ubuntu/Debian
sudo yum install davfs2       # CentOS/RHEL

# 创建挂载点
sudo mkdir -p /mnt/webdav

# 挂载
sudo mount -t davfs https://your-domain/dav/11/ /mnt/webdav
```

#### 使用文件管理器

大多数 Linux 文件管理器（Nautilus、Dolphin 等）都支持 WebDAV：

1. 打开文件管理器
2. 连接到服务器
3. 输入：`davs://your-domain/dav/11/`（注意使用 davs:// 协议）

### 移动设备

#### iOS

推荐应用：

- Documents by Readdle
- FE File Explorer
- Owlfiles

#### Android

推荐应用：

- Solid Explorer
- FX File Explorer
- Total Commander（需要 WebDAV 插件）

## 故障排查

### 检查清单

1. **WebDAV 是否已启用？**

   ```bash
   # 测试 OPTIONS 请求
   curl -i -X OPTIONS https://your-domain/dav/11/

   # 应该返回：
   # DAV: 1, 2
   # Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE
   ```

2. **认证是否正确？**

   ```bash
   # 测试 PROPFIND 请求
   curl -i -X PROPFIND \
     -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
     -H "Depth: 1" \
     https://your-domain/dav/11/

   # 应该返回 207 Multi-Status
   ```

3. **URL 格式是否正确？**
   - 确保 URL 以 `/` 结尾
   - 确保使用 HTTPS（不是 HTTP）
   - 确保 storage_id 是数字

4. **防火墙/代理问题？**
   - 某些网络可能阻止 WebDAV 协议
   - 尝试使用不同的网络连接

### 调试命令

```bash
# 列出根目录下的所有存储
curl -i -X PROPFIND \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  --data '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' \
  https://your-domain/dav/0/

# 列出特定存储的内容
curl -i -X PROPFIND \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  --data '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' \
  https://your-domain/dav/11/

# 上传文件
curl -i -X PUT \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  --data-binary @test.txt \
  https://your-domain/dav/11/test.txt

# 下载文件
curl -i -X GET \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  https://your-domain/dav/11/test.txt

# 创建文件夹
curl -i -X MKCOL \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  https://your-domain/dav/11/newfolder/

# 删除文件
curl -i -X DELETE \
  -H "Authorization: Basic $(echo -n 'username:password' | base64)" \
  https://your-domain/dav/11/test.txt
```

## 性能优化

### 客户端优化

- 使用批量操作而不是逐个文件操作
- 启用客户端缓存
- 对大文件使用分块传输

### 服务器端优化

- 已实现：使用 `Depth: 1` 限制 PROPFIND 深度
- 已实现：支持 HEAD 请求以减少流量
- 建议：配置 CDN 缓存静态文件

## 安全建议

1. **使用强密码**：WebDAV 密码应该足够复杂
2. **HTTPS 必需**：永远不要在 HTTP 上使用 WebDAV
3. **限制访问**：考虑添加 IP 白名单或其他访问控制
4. **定期轮换密码**：定期更新 WebDAV 凭据
5. **监控日志**：监控异常的访问模式

## 支持的 WebDAV 方法

| 方法     | 说明             | 状态      |
| -------- | ---------------- | --------- |
| OPTIONS  | 发现 WebDAV 能力 | ✅ 支持   |
| PROPFIND | 列出文件/文件夹  | ✅ 支持   |
| GET      | 下载文件         | ✅ 支持   |
| HEAD     | 获取文件元数据   | ✅ 支持   |
| PUT      | 上传文件         | ✅ 支持   |
| DELETE   | 删除文件/文件夹  | ✅ 支持   |
| MKCOL    | 创建文件夹       | ✅ 支持   |
| COPY     | 复制文件         | ✅ 支持   |
| MOVE     | 移动/重命名文件  | ✅ 支持   |
| LOCK     | 文件锁定         | ❌ 未实现 |
| UNLOCK   | 解锁文件         | ❌ 未实现 |

## 常见问题 FAQ

### Q: 为什么连接时显示 405 错误？

A: 检查三点：

1. `WEBDAV_ENABLED` 必须是字符串 `"true"`（不是布尔值）
2. URL 必须以 `/` 结尾
3. 确保已重新部署 Worker

### Q: 可以同时使用多个客户端吗？

A: 可以，但注意文件冲突。当前实现不支持文件锁定（LOCK/UNLOCK）。

### Q: 支持大文件上传吗？

A: 支持，但受 Cloudflare Workers 限制：

- 请求体大小限制（免费版 100MB，付费版更高）
- 执行时间限制

### Q: 为什么 Windows 连接失败？

A: Windows 对 WebDAV 支持有限，建议：

1. 使用第三方客户端（RaiDrive、NetDrive）
2. 或修改注册表启用基本认证

### Q: 可以设置只读访问吗？

A: 当前版本不支持，所有认证用户都有完全访问权限。可以通过修改代码实现。

## 技术细节

### 架构说明

- 基于 React Router 7 的路由系统
- 使用统一的 `handleWebdavRequest` 函数处理所有 WebDAV 方法
- 支持多种存储后端（S3、WebDAV、OneDrive、Google Drive 等）
- 使用 HTTP Basic Authentication

### 代码位置

- 路由定义：`app/routes.ts`
- WebDAV 实现：`app/routes/dav.$storageId.$.ts`
- WebDAV 客户端：`app/lib/webdev-client.ts`

## 更新日志

### 最新更新

- ✅ 修复：统一 loader 和 action 处理所有 WebDAV 方法
- ✅ 修复：OPTIONS 请求添加 CORS 头
- ✅ 修复：PROPFIND 响应添加 DAV 头
- ✅ 改进：错误处理和日志记录

## 需要帮助？

如果遇到问题：

1. 查看本文档的故障排查部分
2. 检查 Cloudflare Workers 日志
3. 使用调试命令测试各个 WebDAV 方法
4. 提交 Issue 到项目 GitHub 仓库
