# WebDAV 405 错误修复指南

## 问题描述

连接 WebDAV 时出现错误：

```
WebDAV PROPFIND 失败: 405 Method Not Allowed
```

## 快速修复步骤

### 第一步：检查环境变量

在 Cloudflare Workers 中设置以下环境变量：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 选择你的 Worker 项目
4. 点击 **Settings** → **Variables**
5. 添加/修改以下变量：

```
WEBDAV_ENABLED = true
WEBDAV_USERNAME = 你的用户名
WEBDAV_PASSWORD = 你的密码
```

⚠️ **重要提示**：

- `WEBDAV_ENABLED` 的值必须是字符串 `"true"`，不是布尔值
- 用户名和密码不要包含特殊字符

### 第二步：检查 URL 格式

WebDAV URL **必须**以斜杠 `/` 结尾！

**正确格式**：

```
https://mirrors.ohyraw.dpdns.org/dav/11/
```

**错误格式**：

```
https://mirrors.ohyraw.dpdns.org/dav/11  ❌ 缺少尾部斜杠
```

### 第三步：重新部署

修改环境变量后，需要重新部署：

```bash
npm run build
npm run deploy
```

或者使用：

```bash
wrangler deploy
```

### 第四步：测试连接

#### 方法 A：使用命令行测试

**Windows PowerShell**：

```powershell
# 测试 WebDAV 是否启用
Invoke-WebRequest -Uri "https://mirrors.ohyraw.dpdns.org/dav/11/" -Method OPTIONS

# 应该看到：
# StatusCode: 200
# Headers: DAV: 1, 2
```

**Linux/macOS**：

```bash
# 测试 WebDAV 是否启用
curl -i -X OPTIONS https://mirrors.ohyraw.dpdns.org/dav/11/

# 应该看到：
# HTTP/2 200
# DAV: 1, 2
# Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE
```

#### 方法 B：使用 WebDAV 客户端

确保在客户端中输入的 URL **以斜杠结尾**：

```
https://mirrors.ohyraw.dpdns.org/dav/11/
```

## 常见问题

### Q1: 仍然显示 405 错误

**解决方案**：

1. **清除缓存**：
   - 浏览器：清除缓存和 Cookie
   - WebDAV 客户端：断开连接重新连接
   - DNS 缓存：`ipconfig /flushdns` (Windows) 或 `sudo killall -HUP mDNSResponder` (macOS)

2. **等待部署生效**：
   - Cloudflare 全球部署需要几分钟
   - 等待 2-5 分钟后重试

3. **检查是否正确设置**：
   ```bash
   # 测试环境变量是否生效
   curl -i https://mirrors.ohyraw.dpdns.org/dav/11/

   # 如果返回 403 "WebDAV is disabled"，说明环境变量未生效
   # 如果返回 401 "Unauthorized"，说明 WebDAV 已启用，但认证失败
   ```

### Q2: 401 Unauthorized 错误

**原因**：用户名或密码不正确

**解决方案**：

1. 确认在 Cloudflare Dashboard 中设置的用户名密码
2. 如果没有设置 `WEBDAV_USERNAME` 和 `WEBDAV_PASSWORD`，使用管理员凭据（`ADMIN_USERNAME` 和 `ADMIN_PASSWORD`）
3. 确保密码没有特殊字符引起的编码问题

### Q3: 403 Forbidden 错误

**原因**：WebDAV 未启用

**解决方案**：
确保 `WEBDAV_ENABLED = "true"` (字符串形式)

### Q4: 404 Not Found 错误

**原因**：存储 ID 不存在

**解决方案**：

1. 访问 `https://mirrors.ohyraw.dpdns.org/dav/0/` 查看所有可用的存储
2. 确认存储 ID 11 是否存在
3. 尝试使用其他存储 ID

## 完整测试流程

### 使用测试脚本（推荐）

**Windows**：

```powershell
# 下载并运行测试脚本
.\scripts\test-webdav.ps1 -BaseUrl "https://mirrors.ohyraw.dpdns.org" -Username "你的用户名" -Password "你的密码" -StorageId 11
```

**Linux/macOS**：

```bash
# 下载并运行测试脚本
chmod +x scripts/test-webdav.sh
./scripts/test-webdav.sh https://mirrors.ohyraw.dpdns.org 你的用户名 你的密码 11
```

### 手动测试步骤

```bash
# 设置变量（替换为你的实际值）
DOMAIN="mirrors.ohyraw.dpdns.org"
USERNAME="你的用户名"
PASSWORD="你的密码"
STORAGE_ID="11"

# 1. 测试 WebDAV 是否启用
curl -i -X OPTIONS "https://$DOMAIN/dav/$STORAGE_ID/"

# 2. 测试认证和列表功能
curl -i -X PROPFIND \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  -H "Depth: 1" \
  "https://$DOMAIN/dav/$STORAGE_ID/"

# 3. 测试上传文件
echo "测试内容" | curl -i -X PUT \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  --data-binary @- \
  "https://$DOMAIN/dav/$STORAGE_ID/test.txt"

# 4. 测试下载文件
curl -X GET \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  "https://$DOMAIN/dav/$STORAGE_ID/test.txt"

# 5. 清理测试文件
curl -i -X DELETE \
  -H "Authorization: Basic $(echo -n "$USERNAME:$PASSWORD" | base64)" \
  "https://$DOMAIN/dav/$STORAGE_ID/test.txt"
```

## 客户端配置

### Windows 客户端推荐

由于 Windows 对 WebDAV 支持有限，推荐使用第三方客户端：

1. **RaiDrive** (免费)
   - 下载：https://www.raidrive.com/
   - 支持 HTTPS WebDAV
   - 界面友好

2. **NetDrive** (付费)
   - 下载：https://www.netdrive.net/
   - 功能强大

3. **Cyberduck** (免费)
   - 下载：https://cyberduck.io/
   - 跨平台支持

### macOS 配置

1. 打开 **Finder**
2. 菜单栏：**前往** → **连接服务器** (⌘K)
3. 输入：`https://mirrors.ohyraw.dpdns.org/dav/11/`
4. 点击 **连接**
5. 选择 **注册用户**
6. 输入用户名和密码

### Linux 配置

#### 使用 davfs2

```bash
# 安装
sudo apt-get install davfs2

# 创建挂载点
sudo mkdir -p /mnt/webdav

# 挂载
sudo mount -t davfs https://mirrors.ohyraw.dpdns.org/dav/11/ /mnt/webdav
```

#### 使用文件管理器

大多数 Linux 文件管理器都支持 WebDAV：

1. 打开文件管理器
2. 连接到服务器
3. 输入：`davs://mirrors.ohyraw.dpdns.org/dav/11/`

## 检查清单

在联系技术支持前，请确认以下项目：

- [ ] `WEBDAV_ENABLED` 设置为字符串 `"true"`
- [ ] `WEBDAV_USERNAME` 和 `WEBDAV_PASSWORD` 已设置
- [ ] URL 以斜杠 `/` 结尾
- [ ] 已重新部署 Worker
- [ ] 已等待 2-5 分钟让部署生效
- [ ] 已清除浏览器/客户端缓存
- [ ] OPTIONS 请求返回 200 状态码
- [ ] 用户名密码正确
- [ ] 存储 ID 存在

## 获取帮助

如果按照以上步骤仍无法解决问题：

1. 查看详细文档：
   - [完整配置指南](./WEBDAV_SETUP.md)
   - [故障排查清单](./WEBDAV_TROUBLESHOOTING.md)

2. 查看 Cloudflare Workers 日志：

   ```bash
   wrangler tail
   ```

3. 提交 Issue：
   - GitHub: https://github.com/ooyyh/Cloudflare-Clist/issues
   - 请包含：
     - 错误信息的完整截图
     - 使用的客户端和版本
     - OPTIONS 请求的响应

## 技术支持

- 邮箱：laowan345@gmail.com
- GitHub Issues：https://github.com/ooyyh/Cloudflare-Clist/issues

---

**最后更新**：2026-06-12
