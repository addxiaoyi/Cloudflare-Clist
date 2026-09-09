# Starx - 云存储聚合服务

一个基于 Cloudflare Workers 和 D1 数据库部署的云存储聚合服务平台。

[English](./index.md) | 简体中文

## 功能介绍

- **文件上传与下载**：支持大文件分块上传，可自定义分块大小
- **文件预览**：内置文件预览功能，支持多种文件格式的在线查看
- **目录管理**：完整的目录结构管理，支持创建、删除、移动文件和文件夹
- **多存储后端支持**：支持任何兼容 S3 协议的存储服务
- **WebDAV 服务支持**：将 Starx 存储通过 WebDAV 协议对外提供服务
- **访问控制与安全**：基于用户名和密码的管理员身份验证系统

## 快速开始

### 前置要求

- Node.js (v18 或更高版本)
- npm 或 yarn 包管理器
- 已启用 Workers 的 Cloudflare 账户
- 全局安装 Wrangler CLI：`npm install -g wrangler`

### 安装步骤

1. 克隆仓库：

```bash
git clone https://github.com/ooyyh/Cloudflare-Clist.git
cd Cloudflare-Clist
```

2. 安装依赖：

```bash
npm install
```

### 配置

1. 登录 Cloudflare：

```bash
wrangler login
```

2. 创建 D1 数据库：

```bash
wrangler d1 create clist
```

3. 在 `wrangler.jsonc` 文件中更新您的数据库 ID 和环境变量。

### 开发

```bash
npm run dev
```

### 构建

```bash
npm run build
```

### 部署

```bash
npm run deploy
```

更多部署方式，请参阅 [部署指南](./deployment.md)。

## 文档

- [部署指南](./deployment.md)
- [配置参考](./configuration.md)
- [WebDAV 配置](./webdav.md)

## 使用的技术

- React Router v7
- Cloudflare Workers
- Cloudflare D1 Database
- Vite
- TypeScript
- Tailwind CSS

## 支持与联系

- GitHub: [https://github.com/ooyyh](https://github.com/ooyyh)
- Email: laowan345@gmail.com

## 许可证

本项目按照仓库中指定的条款进行许可。
