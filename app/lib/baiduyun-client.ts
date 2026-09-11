import {
  getConfigString,
  getRefreshToken,
  joinRootPath,
  shouldUseOnlineApi,
  stripLeadingSlash,
  stripTrailingSlash,
} from "./drive-utils";
import { md5Hex } from "./md5";

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

const BAIDU_API_BASE = "https://pan.baidu.com/rest/2.0";
const BAIDU_OAUTH_URL = "https://openapi.baidu.com/oauth/2.0/token";
const BAIDU_PCS_BASE = "https://d.pcs.baidu.com";
const DEFAULT_BAIDU_API_ADDRESS = "https://api.oplist.org/baiduyun/renewapi";

interface BaiduFile {
  fs_id: number;
  path: string;
  server_filename: string;
  size: number;
  isdir: number;
  server_mtime: number;
  server_ctime: number;
}

interface BaiduListResponse {
  errno: number;
  list: BaiduFile[];
}

export class BaiduYunClient {
  private config: Record<string, any>;
  private saving: Record<string, any>;
  private savingChanged = false;
  private configChanged = false;

  constructor(options: { config?: Record<string, any>; saving?: Record<string, any> }) {
    this.config = options.config || {};
    this.saving = options.saving || {};
  }

  getStateUpdates(): { config?: Record<string, any>; saving?: Record<string, any> } | null {
    if (!this.savingChanged && !this.configChanged) {
      return null;
    }
    return {
      config: this.configChanged ? this.config : undefined,
      saving: this.savingChanged ? this.saving : undefined,
    };
  }

  private markSavingChanged(): void {
    this.savingChanged = true;
  }

  private markConfigChanged(): void {
    this.configChanged = true;
  }

  private isTokenExpired(): boolean {
    if (!this.saving.expires_at) {
      return false;
    }
    return Date.now() >= this.saving.expires_at - 5 * 60 * 1000;
  }

  private async ensureToken(): Promise<void> {
    if (!this.saving.access_token || this.isTokenExpired()) {
      await this.refreshToken();
    }
  }

  private async refreshToken(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.refreshTokenOnce();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Baidu refresh failed");
  }

  private async refreshTokenOnce(): Promise<void> {
    if (shouldUseOnlineApi(this.config)) {
      await this.refreshTokenOnline();
      return;
    }
    await this.refreshTokenLocal();
  }

  private async refreshTokenOnline(): Promise<void> {
    const refreshToken = getRefreshToken(this.config, this.saving);
    if (!refreshToken) {
      throw new Error("Missing refresh_token");
    }

    const url = new URL(getConfigString(this.config, ["api_address", "api_url_address"], DEFAULT_BAIDU_API_ADDRESS));
    url.searchParams.set("refresh_ui", refreshToken);
    url.searchParams.set("server_use", "true");
    url.searchParams.set("driver_txt", "baiduyun_go");

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Baidu online refresh failed: ${response.status} ${text}`);
    }

    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; text?: string };
    if (!data.access_token || !data.refresh_token) {
      throw new Error(data.text || "Baidu online refresh returned empty token");
    }

    this.saving.access_token = data.access_token;
    this.saving.refresh_token = data.refresh_token;
    this.saving.expires_at = data.expires_in ? Date.now() + data.expires_in * 1000 : undefined;
    this.config.refresh_token = data.refresh_token;
    this.markSavingChanged();
    this.markConfigChanged();
  }

  private async refreshTokenLocal(): Promise<void> {
    const clientId = getConfigString(this.config, "client_id");
    const clientSecret = getConfigString(this.config, "client_secret");
    const refreshToken = getRefreshToken(this.config, this.saving);
    if (!clientId || !clientSecret) {
      throw new Error("Missing client_id or client_secret");
    }
    if (!refreshToken) {
      throw new Error("Missing refresh_token");
    }

    const url = new URL(BAIDU_OAUTH_URL);
    url.searchParams.set("grant_type", "refresh_token");
    url.searchParams.set("refresh_token", refreshToken);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("client_secret", clientSecret);

    const response = await fetch(url.toString(), { method: "GET" });
    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || data.error) {
      throw new Error(data.error_description || data.error || "Baidu refresh failed");
    }
    if (!data.access_token || !data.refresh_token) {
      throw new Error("Baidu refresh returned empty token");
    }

    this.saving.access_token = data.access_token;
    this.saving.refresh_token = data.refresh_token;
    this.saving.expires_at = data.expires_in ? Date.now() + data.expires_in * 1000 : undefined;
    this.config.refresh_token = data.refresh_token;
    this.markSavingChanged();
    this.markConfigChanged();
  }

  private resolvePath(path: string): string {
    const rootPath = this.config.root_path || "/";
    const joined = joinRootPath(rootPath, path);
    if (!joined.startsWith("/")) {
      return `/${joined}`;
    }
    return joined;
  }

  private async request(
    pathname: string,
    method: string = "GET",
    params?: Record<string, string>,
    body?: any,
    retryAuth: boolean = true
  ): Promise<any> {
    await this.ensureToken();
    const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const url = new URL(`${BAIDU_API_BASE}${cleanPath}`);
    url.searchParams.set("access_token", this.saving.access_token || "");
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      "User-Agent": "pan.baidu.com",
    };
    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      if (body instanceof FormData) {
        options.body = body;
      } else if (typeof body === "object") {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        options.body = new URLSearchParams(body as Record<string, string>).toString();
      } else {
        options.body = body;
      }
    }

    const response = await fetch(url.toString(), options);
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(`Baidu API error: ${response.status} ${text}`);
      }
      throw new Error(`Baidu API parse failed: ${text.substring(0, 200)}`);
    }

    if (data.errno !== undefined && data.errno !== 0) {
      if ((data.errno === 111 || data.errno === -6) && retryAuth) {
        await this.refreshToken();
        return this.request(pathname, method, params, body, false);
      }
      throw new Error(`Baidu API errno=${data.errno}`);
    }

    return data;
  }

  private async listFiles(dir: string): Promise<BaiduFile[]> {
    const result: BaiduListResponse = await this.request("/xpan/file", "GET", {
      method: "list",
      dir,
      web: "web",
      start: "0",
      limit: "200",
      order: this.config.order_by || "name",
      desc: this.config.order_direction === "desc" ? "1" : "0",
    });
    return result.list || [];
  }

  private async findFileByPath(path: string): Promise<BaiduFile | null> {
    const normalized = stripLeadingSlash(path);
    if (!normalized) {
      return null;
    }
    const parts = normalized.split("/").filter(Boolean);
    const fileName = parts.pop() || "";
    const dirPath = this.resolvePath(parts.length ? `/${parts.join("/")}` : "/");
    const files = await this.listFiles(dirPath);
    const found = files.find((f) => f.server_filename === fileName);
    return found || null;
  }

  async listObjects(
    prefix: string = "",
    _delimiter: string = "/",
    _maxKeys: number = 1000,
    _continuationToken?: string
  ): Promise<ListObjectsResult> {
    const path = this.resolvePath(prefix ? `/${stripLeadingSlash(prefix)}` : "/");
    const files = await this.listFiles(path);
    const objects: DriveObject[] = [];
    const prefixes: string[] = [];
    const keyBase = prefix ? `${stripTrailingSlash(stripLeadingSlash(prefix))}/` : "";

    for (const file of files) {
      const isDirectory = file.isdir === 1;
      const key = isDirectory ? `${keyBase}${file.server_filename}/` : `${keyBase}${file.server_filename}`;
      objects.push({
        key,
        name: file.server_filename,
        size: file.size || 0,
        lastModified: new Date(file.server_mtime * 1000).toISOString(),
        isDirectory,
      });
      if (isDirectory) {
        prefixes.push(key);
      }
    }

    return {
      objects: objects.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      }),
      prefixes,
      isTruncated: false,
    };
  }

  async getObject(key: string): Promise<Response> {
    const file = await this.findFileByPath(key);
    if (!file) {
      throw new Error("Baidu file not found");
    }
    const result = await this.request("/xpan/multimedia", "GET", {
      method: "filemetas",
      fsids: `[${file.fs_id}]`,
      dlink: "1",
    });
    const dlink = result?.list?.[0]?.dlink;
    if (!dlink) {
      throw new Error("Baidu download link missing");
    }

    const url = `${dlink}&access_token=${this.saving.access_token}`;
    return fetch(url, {
      headers: {
        "User-Agent": "pan.baidu.com",
        "Referer": "https://pan.baidu.com/",
      },
    });
  }

  async getSignedUrl(key: string): Promise<string> {
    const file = await this.findFileByPath(key);
    if (!file) {
      throw new Error("Baidu file not found");
    }
    const result = await this.request("/xpan/multimedia", "GET", {
      method: "filemetas",
      fsids: `[${file.fs_id}]`,
      dlink: "1",
    });
    const dlink = result?.list?.[0]?.dlink;
    if (!dlink) {
      throw new Error("Baidu download link missing");
    }
    return `${dlink}&access_token=${this.saving.access_token}`;
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const file = await this.findFileByPath(key);
    if (!file || file.isdir === 1) {
      return null;
    }
    return {
      contentLength: file.size || 0,
      contentType: "application/octet-stream",
      lastModified: new Date(file.server_mtime * 1000).toISOString(),
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, _contentType?: string): Promise<void> {
    const path = this.resolvePath(key);
    const data = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
    const fileSize = data.byteLength;

    const sliceSize = this.getSliceSize(fileSize);
    const blockList: string[] = [];
    for (let offset = 0; offset < fileSize; offset += sliceSize) {
      const chunk = data.slice(offset, Math.min(offset + sliceSize, fileSize));
      blockList.push(md5Hex(chunk));
    }

    const contentMd5 = md5Hex(data);
    const sliceMd5 = md5Hex(data.slice(0, Math.min(256 * 1024, fileSize)));

    const precreate = await this.request("/xpan/file", "POST", { method: "precreate" }, {
      path,
      size: String(fileSize),
      isdir: "0",
      autoinit: "1",
      rtype: "3",
      block_list: JSON.stringify(blockList),
      "content-md5": contentMd5,
      "slice-md5": sliceMd5,
    });

    if (precreate.return_type === 2) {
      return;
    }

    const uploadid = precreate.uploadid;
    if (!uploadid) {
      throw new Error("Baidu upload id missing");
    }

    for (let partseq = 0; partseq < blockList.length; partseq++) {
      const start = partseq * sliceSize;
      const end = Math.min(start + sliceSize, fileSize);
      const chunk = data.slice(start, end);
      const uploadUrl = new URL(`${BAIDU_PCS_BASE}/rest/2.0/pcs/superfile2`);
      uploadUrl.searchParams.set("method", "upload");
      uploadUrl.searchParams.set("access_token", this.saving.access_token || "");
      uploadUrl.searchParams.set("type", "tmpfile");
      uploadUrl.searchParams.set("path", path);
      uploadUrl.searchParams.set("uploadid", uploadid);
      uploadUrl.searchParams.set("partseq", String(partseq));

      const formData = new FormData();
      formData.append("file", new Blob([chunk]), "file");

      const response = await fetch(uploadUrl.toString(), {
        method: "POST",
        body: formData,
      });
      const result = await response.json() as { errno?: number; error_code?: number };
      if (result.errno !== 0 && result.error_code !== 0) {
        throw new Error(`Baidu upload slice failed: ${JSON.stringify(result)}`);
      }
    }

    await this.request("/xpan/file", "POST", { method: "create" }, {
      path,
      size: String(fileSize),
      isdir: "0",
      uploadid,
      block_list: JSON.stringify(blockList),
      rtype: "3",
    });
  }

  async deleteObject(key: string): Promise<void> {
    const path = this.resolvePath(key);
    await this.request("/xpan/file", "POST", { method: "filemanager", opera: "delete" }, {
      async: "0",
      filelist: JSON.stringify([path]),
      ondup: "fail",
    });
  }

  async createFolder(folderPath: string): Promise<void> {
    const path = this.resolvePath(stripTrailingSlash(folderPath));
    await this.request("/xpan/file", "POST", { method: "create" }, {
      path,
      size: "0",
      isdir: "1",
      rtype: "3",
    });
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const source = this.resolvePath(sourceKey);
    const destFullPath = this.resolvePath(destKey);
    const dest = destFullPath.substring(0, destFullPath.lastIndexOf("/")) || "/";
    const newName = destFullPath.split("/").pop() || "";
    await this.request("/xpan/file", "POST", { method: "filemanager", opera: "copy" }, {
      async: "0",
      filelist: JSON.stringify([{ path: source, dest, newname: newName }]),
      ondup: "fail",
    });
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const sourcePath = this.resolvePath(path);
    const dest = sourcePath.substring(0, sourcePath.lastIndexOf("/")) || "/";
    await this.request("/xpan/file", "POST", { method: "filemanager", opera: "rename" }, {
      async: "0",
      filelist: JSON.stringify([{ path: sourcePath, dest, newname: newName }]),
      ondup: "fail",
    });
  }

  async moveObject(path: string, destPath: string): Promise<void> {
    const sourcePath = this.resolvePath(path);
    const destFullPath = this.resolvePath(destPath);
    const dest = destFullPath.substring(0, destFullPath.lastIndexOf("/")) || "/";
    const fileName = destFullPath.split("/").pop() || sourcePath.split("/").pop() || "";
    await this.request("/xpan/file", "POST", { method: "filemanager", opera: "move" }, {
      async: "0",
      filelist: JSON.stringify([{ path: sourcePath, dest, newname: fileName }]),
      ondup: "fail",
    });
  }

  async initiateMultipartUpload(
    _key: string,
    _contentType: string,
    _options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    throw new Error("BaiduYun does not support multipart upload in this mode");
  }

  async uploadPart(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _body: ReadableStream | ArrayBuffer,
    _contentLength?: number
  ): Promise<string> {
    throw new Error("BaiduYun does not support multipart upload in this mode");
  }

  async completeMultipartUpload(
    _key: string,
    _uploadId: string,
    _parts: { partNumber: number; etag: string }[]
  ): Promise<void> {
    return;
  }

  async abortMultipartUpload(_key: string, _uploadId: string): Promise<void> {
    return;
  }

  async getSignedUploadPartUrl(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _expiresIn: number = 3600
  ): Promise<string> {
    throw new Error("BaiduYun does not support direct signed upload URLs");
  }

  private getSliceSize(fileSize: number): number {
    const defaultSlice = 4 * 1024 * 1024;
    const vipSlice = 16 * 1024 * 1024;
    const svipSlice = 32 * 1024 * 1024;
    const vipType = this.saving.vip_type || 0;
    const custom = Number(this.config.custom_upload_part_size || 0);

    if (custom > 0) {
      return Math.max(defaultSlice, Math.min(custom * 1024 * 1024, svipSlice));
    }

    if (vipType === 2) {
      return svipSlice;
    }
    if (vipType === 1) {
      return vipSlice;
    }
    return defaultSlice;
  }
}
