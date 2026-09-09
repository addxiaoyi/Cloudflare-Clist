# 七牛云 KODO S3 配置指南

## 常见问题

### 错误 530 / 1016 解决方法

| 问题 | 解决方法 |
|------|----------|
| AccessKey/SecretKey 错误 | 在七牛云控制台 → 个人中心 → 密钥管理 获取 |
| Bucket 名称错误 | 使用 **S3 空间名** 而非 KODO 空间名 |
| 区域不匹配 | 区域必须和 bucket 创建时的区域一致 |

## 获取凭证

1. 登录 [七牛云控制台](https://portal.qiniu.com/)
2. 个人中心 → 密钥管理
3. 获取 `Access Key` 和 `Secret Key`

## 获取 S3 空间名

S3 空间名（Bucket）获取方式：

1. **控制台查看**：对象存储 → 空间管理 → 空间概览
2. **API 获取**：调用 [Get Service](https://developer.qiniu.com/kodo/manual/4087/compatible-s3-api#service-operation) 接口

> S3 空间名 = KODO 空间名（如果全局唯一）
> 如果不唯一，系统会自动生成 S3 空间名

## 区域配置

| 区域选择 | AWS Region | S3 端点 |
|----------|------------|---------|
| 华东 | z0（默认） | s3.cn-east-1.qiniucs.com |
| 华北 | z1 | s3.cn-north-1.qiniucs.com |
| 华南 | z2 | s3.cn-south-1.qiniucs.com |
| 北美 | na0 | s3.us-north-1.qiniucs.com |
| 亚太 | as0 | s3.ap-southeast-1.qiniucs.com |

## 配置示例

在存储配置中填写：

- **区域**：选择对应的区域
- **存储桶名**：填入 S3 空间名
- **Access Key**：身份凭证
- **Secret Key**：身份凭证
- **域名**：CDN 域名（可选）

## 参考文档

- [AWS S3 兼容 - 七牛云](https://developer.qiniu.com/kodo/4086/aws-s3-compatible)
- [S3 签名认证](https://developer.qiniu.com/kodo/4093/s3-authentication)