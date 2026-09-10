import { S3Client } from "./s3-client";
import { WebdevClient } from "./webdev-client";
import { OneDriveClient } from "./onedrive-client";
import { GoogleDriveClient } from "./gdrive-client";
import { AliyunDriveClient } from "./alicloud-client";
import { BaiduYunClient } from "./baiduyun-client";
import { R2Client } from "./r2-client";
import { R2OAuthClient } from "./r2-oauth-client";
import { QuarkClient } from "./quark-client";
import { DropboxClient } from "./dropbox-client";
import { MySqlClient, type MySqlConfig } from "./mysql-client";

export type { MySqlConfig };

export type StorageClient =
  | S3Client
  | WebdevClient
  | OneDriveClient
  | GoogleDriveClient
  | AliyunDriveClient
  | BaiduYunClient
  | R2Client
  | R2OAuthClient
  | QuarkClient
  | DropboxClient;

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

export type ClientEnv = { R2?: R2Bucket; HYPERDRIVE?: { connectionString: string } };

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
  if (storage.type === "tigris") {
    const cfg = storage.config || {};
    return new S3Client({
      endpoint: cfg.endpoint || "https://fly.storage",
      region: cfg.region || "us-east-1",
      accessKeyId: cfg.access_key_id || storage.accessKeyId || "",
      secretAccessKey: cfg.secret_access_key || storage.secretAccessKey || "",
      bucket: cfg.bucket || storage.bucket || "",
      basePath: cfg.root_folder_path || storage.basePath || "/",
    });
  }
  if (storage.type === "qiniu") {
    const cfg = storage.config || {};
    const regionMap: Record<string, string> = {
      z0: "cn-east-1",
      z1: "cn-north-1",
      z2: "cn-south-1",
      "cn-east-2": "cn-east-2",
      na0: "us-north-1",
      as0: "ap-southeast-1",
      as2: "ap-southeast-3",
    };
    const awsRegion = regionMap[cfg.region || "z0"] || regionMap.z0;
    return new S3Client({
      endpoint: `https://s3.${awsRegion}.qiniucs.com`,
      region: awsRegion,
      accessKeyId: cfg.access_key || storage.accessKeyId || "",
      secretAccessKey: cfg.secret_key || storage.secretAccessKey || "",
      bucket: cfg.bucket || storage.bucket || "",
      basePath: cfg.root_folder_path || storage.basePath || "/",
      usePathStyle: cfg.path_style ?? true,
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
  if (storage.type === "quark") {
    return new QuarkClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "dropbox") {
    return new DropboxClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "ftp") {
    return new WebdevClient({
      endpoint: storage.config?.endpoint || storage.endpoint,
      username: storage.config?.username || storage.accessKeyId,
      password: storage.config?.password || storage.secretAccessKey,
      basePath: storage.config?.base_path || storage.basePath,
    });
  }
  if (storage.type === "r2-oauth") {
    const cfg = storage.config || {};
    const accountId = cfg.cloudflare_account_id || "";
    const bucketName = cfg.bucket || storage.bucket || "";
    const accessToken = cfg.cloudflare_access_token || "";
    if (!accountId || !bucketName || !accessToken) {
      throw new Error("R2 OAuth 未授权，请先完成 Cloudflare 授权");
    }
    return new R2OAuthClient({
      accountId,
      bucketName,
      accessToken,
      basePath: cfg.root_folder_path || storage.basePath || "",
    });
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

// MySQL 通过 Hyperdrive 访问，接口与文件存储不同，单独构造
export function createMysqlClient(
  storage: StorageLike,
  env?: ClientEnv
): MySqlClient {
  const cfg = storage.config || {};
  return new MySqlClient(
    {
      connectionString: cfg.connection_string || cfg.endpoint || storage.endpoint || "",
      database: cfg.database || storage.bucket,
      tablePrefix: cfg.table_prefix,
    },
    env
  );
}
