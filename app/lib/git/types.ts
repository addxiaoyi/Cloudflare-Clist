// 多平台 Git 存储的统一抽象契约。
// 设计取向：Provider + Adapter——编排层（git-repository-client.ts）实现与平台无关的
// StorageClient 流程（前缀映射、HEAD 缓存、分页续传、Range 切片、大小校验），
// 平台差异全部下沉到 GitPlatformAdapter 的语义操作，避免 GitTrees/Contents 形状被硬编码。

/** 与其它 StorageClient 对齐的对象描述。 */
export interface DriveObject {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  etag?: string;
}

export interface ListObjectsResult {
  objects: DriveObject[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

/** 解析后的连接配置，各 adapter 共享。 */
export interface GitConnection {
  /** 仓库标识段：GitHub 为 [owner, repo]，GitLab 可为 [group, subdir, project]。 */
  repo: string[];
  token: string;
  /** 无尾斜杠的 API 根，如 https://api.github.com。 */
  apiBase: string;
  branch: string;
  /** 仓库内子目录，无前后斜杠；空串代表仓库根。 */
  rootPath: string;
}

/** 目录条目（归一化后；size 平台拿不到时为 0）。 */
export interface GitDirEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "other";
}

/** 提交元信息（HEAD 解析 + 列表 lastModified 用）。 */
export interface GitCommitMeta {
  sha: string;
  date: string;
}

/** 文件元信息。 */
export interface GitFileStat {
  sha: string;
  size: number;
}

/** 平台语义适配器：把各平台原生 API 翻译成统一操作。 */
export interface GitPlatformAdapter {
  type: string;
  label: string;

  /** 从 storage.config 构建连接；缺少 token/仓库等必填项时抛出中文提示。 */
  buildConnection(config?: Record<string, any>): GitConnection;

  /** 连接测试：成功返回 null，失败返回错误消息（可选探测写权限）。 */
  ping(conn: GitConnection): Promise<string | null>;

  /** 解析 HEAD 提交。 */
  headCommit(conn: GitConnection): Promise<GitCommitMeta>;

  /**
   * 拉取目录（可含分页）。返回 null 表示目录不存在。
   * token 为不透明续传标记（上层会透传回 listDir），nextToken 非空表示还有更多页。
   */
  listDir(
    conn: GitConnection,
    repoPath: string,
    opts: { maxItems?: number; token?: string }
  ): Promise<{ entries: GitDirEntry[]; nextToken: string | null } | null>;

  /** 递归列出全部 blob；平台不支持或超限时返回 null（编排层回退到逐目录遍历）。 */
  listTree(conn: GitConnection): Promise<GitDirEntry[] | null>;

  /** 文件元信息；目录或不存在返回 null。 */
  statFile(conn: GitConnection, repoPath: string): Promise<GitFileStat | null>;

  /** 读原始内容（尽量走 blob sha 端点绕开 1MB 限制）。 */
  readFile(conn: GitConnection, repoPath: string): Promise<{ bytes: ArrayBuffer; size: number }>;

  /** 写文件（新建或覆盖，adapter 内部处理 create/update 差异）。 */
  writeFile(conn: GitConnection, repoPath: string, bytes: Uint8Array, message: string): Promise<void>;

  /** 删除文件；不存在时静默成功。 */
  deleteFile(conn: GitConnection, repoPath: string, message: string): Promise<void>;

  /** 签名下载 URL（fallback 用，无法签名时返回 API 原始端点）。 */
  signedUrl(conn: GitConnection, repoPath: string): string;

  /** 单文件字节上限及标签。 */
  maxFileBytes: number;
  maxFileLabel: string;

  /** 平台是否支持递归 tree（用于编排层决定 bulk 模式策略）。 */
  supportsListTree: boolean;
}
