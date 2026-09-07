import { S3Client } from "./s3-client";
import { WebdevClient } from "./webdev-client";
import { OneDriveClient } from "./onedrive-client";
import { GoogleDriveClient } from "./gdrive-client";
import { AliyunDriveClient } from "./alicloud-client";
import { BaiduYunClient } from "./baiduyun-client";
import { R2Client } from "./r2-client";

export type StorageClient =
  | S3Client
  | WebdevClient
  | OneDriveClient
  | GoogleDriveClient
  | AliyunDriveClient
  | BaiduYunClient
  | R2Client;

export type StorageLike = {
  type: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  basePath: string;
  config?: Record<string, any>;
  saving?: Record<string, any>;
};

export type ClientEnv = { R2?: R2Bucket };

// 按存储类型构造对应客户端。r2 类型需要 worker 的 R2 binding。
export function createClient(
  storage: StorageLike,
  env?: ClientEnv,
  storageId?: number
): StorageClient {
  if (storage.type === "r2") {
    if (!env?.R2) {
      throw new Error("R2 绑定未配置，请先在 wrangler 配置 r2_buckets 并部署");
    }
    return new R2Client(env.R2, {
      bucketName: storage.bucket || "R2",
      storageId: storageId || 0,
      basePath: storage.basePath,
    });
  }
  if (storage.type === "webdev") {
    return new WebdevClient({
      endpoint: storage.endpoint,
      username: storage.accessKeyId,
      password: storage.secretAccessKey,
      basePath: storage.basePath,
    });
  }
  if (storage.type === "onedrive") {
    return new OneDriveClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "gdrive") {
    return new GoogleDriveClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "alicloud") {
    return new AliyunDriveClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "baiduyun") {
    return new BaiduYunClient({ config: storage.config, saving: storage.saving });
  }
  return new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
    bucket: storage.bucket,
    basePath: storage.basePath,
  });
}
