import {
  joinRootPath,
  stripLeadingSlash,
  stripTrailingSlash,
} from "./drive-utils";
import { getMimeType } from "./file-utils";

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

const API_BASE = "https://drive.quark.cn";
const DEFAULT_API_ADDRESS = "https://api.oplist.org/quark/renewapi";

interface QuarkFile {
  fid: number;
  name: string;
  type: number;
  size?: number;
  modified_time?: number;
  is_dir?: number;
  parent_fid?: number;
  download_info?: {
    url?: string;
    mergetoken?: string;
  };
}

interface QuarkListResponse {
  data: Array<{ fid: number; name: string; type: number; size?: number; modified_time?: number; is_dir?: number }>;
  total?: number;
  cursor?: string;
}

export class QuarkClient {
  private config: Record<string, any>;
  private saving: Record<string, any>;
  private basePath: string;

  constructor(options: { config?: Record<string, any>; saving?: Record<string, any> }) {
    this.config = options.config || {};
    this.saving = options.saving || {};
    this.basePath = this.config.root_path?.replace(/^\/|\/$/g, "") || "";
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

  private savingChanged = false;
  private configChanged = false;
  private markSavingChanged() {
    this.savingChanged = true;
  }
  private markConfigChanged() {
    this.configChanged = true;
  }

  private getCookie(): string {
    return this.config.cookie || this.saving.cookie || "";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Cookie: this.getCookie(),
    };
    const apiAddress = this.config.use_online_api
      ? (this.config.api_address || DEFAULT_API_ADDRESS)
      : null;
    if (apiAddress) {
      h["X-API-Address"] = apiAddress;
    }
    return h;
  }

  private getFullPath(path: string): string {
    const cleanPath = stripLeadingSlash(path);
    return this.basePath ? `${this.basePath}/${cleanPath}` : cleanPath;
  }

  private getDisplayPath(fullKey: string): string {
    if (!this.basePath) return fullKey;
    return fullKey.startsWith(this.basePath + "/")
      ? fullKey.slice(this.basePath.length + 1)
      : fullKey.replace(/^\/+/, "");
  }

  private request(
    pathname: string,
    method: string = "GET",
    params?: Record<string, string>,
    body?: string
  ): Promise<any> {
    const url = new URL(`${API_BASE}${pathname}`);
    url.searchParams.set("pr", "ucpro");
    url.searchParams.set("fr", "pc");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const options: RequestInit = {
      method,
      headers: this.headers(),
    };

    if (body) {
      options.headers = { ...options.headers as Record<string, string>, "Content-Type": "application/json" };
      options.body = body;
    }

    return fetch(url.toString(), options).then(async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Quark API error: ${res.status} ${text.substring(0, 200)}`);
      }
      const data: Record<string, any> = await res.json();
      if (data.code && data.code !== "0") {
        throw new Error(`Quark API error: ${data.code} ${data.message || ""}`);
      }
      return data;
    });
  }

  private async listFiles(dir: string): Promise<QuarkFile[]> {
    const pdirFid = dir === "/" || !dir ? "0" : String(await this.findFidByPath(dir));
    const result: QuarkListResponse = await this.request("/1/clouddrive/file/sort", "GET", {
      pdir_fid: pdirFid,
      _page: "1",
      _size: "1000",
      _sort: "file_path:asc",
    });
    return result.data || [];
  }

  private async findFidByPath(path: string): Promise<number> {
    const normalized = stripTrailingSlash(stripLeadingSlash(path));
    if (!normalized) return 0;
    const parts = normalized.split("/").filter(Boolean);
    let fid = "0";
    for (const part of parts) {
      const files = await this.listFiles(`/${fid === "0" ? "" : fid}`);
      const found = files.find((f) => f.name === part);
      if (!found) return -1;
      fid = String(found.fid);
    }
    return Number(fid);
  }

  async listObjects(
    prefix: string = "",
    _delimiter: string = "/",
    maxKeys: number = 1000,
    _continuationToken?: string
  ): Promise<ListObjectsResult> {
    const targetPath = this.getFullPath(prefix || "/");
    const files = await this.listFiles(targetPath);
    const objects: DriveObject[] = [];
    const prefixes: string[] = [];

    for (const file of files) {
      const key = this.getDisplayPath(`${targetPath}/${file.name}`);
      const isDir = file.type === 1 || file.is_dir === 1;
      objects.push({
        key: isDir ? `${key}/` : key,
        name: file.name,
        size: file.size || 0,
        lastModified: file.modified_time
          ? new Date(file.modified_time * 1000).toISOString()
          : new Date().toISOString(),
        isDirectory: isDir,
        etag: String(file.fid),
      });
      if (isDir) {
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

  private async getFidByKey(key: string): Promise<number> {
    const fullPath = `/` + stripLeadingSlash(key);
    return this.findFidByPath(fullPath);
  }

  async getObject(key: string): Promise<Response> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) {
      return new Response("Not Found", { status: 404 });
    }

    const result = await this.request("/1/clouddrive/file/download", "POST", undefined, JSON.stringify({ fids: [fid] }));
    const downloadInfo = result?.data?.info?.urls?.[0] || result?.data?.info?.url;
    if (!downloadInfo) {
      throw new Error("Quark download url missing");
    }

    const downloadUrl = downloadInfo.url || downloadInfo;
    return fetch(downloadUrl, { headers: { Referer: API_BASE } });
  }

  async getSignedUrl(key: string, _expiresIn: number = 3600): Promise<string> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) {
      throw new Error("Not Found");
    }
    const result = await this.request("/1/clouddrive/file/download", "POST", undefined, JSON.stringify({ fids: [fid] }));
    const downloadInfo = result?.data?.info?.urls?.[0] || result?.data?.info?.url;
    return downloadInfo?.url || downloadInfo || "";
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) return null;
    const result = await this.request("/1/clouddrive/file/detail", "GET", { fid: String(fid) });
    const file = result?.data?.files?.[0] || result?.data;
    if (!file) return null;
    return {
      contentLength: file.size || 0,
      contentType: getMimeType(key),
      lastModified: file.modified_time ? new Date(file.modified_time * 1000).toISOString() : new Date().toISOString(),
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const fid = await this.getFidByKey(stripLeadingSlash(key));
    if (fid < 0) {
      await this.createFolder(stripTrailingSlash(key));
    }
    // 上传在 initPutObject 中完成，这里只做占位
    throw new Error("Quark: putObject requires multipart flow, use multipart upload");
  }

  async deleteObject(key: string): Promise<void> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) return;
    await this.request("/1/clouddrive/file/delete", "POST", undefined, JSON.stringify({ fid_list: [fid] }));
  }

  async createFolder(folderPath: string): Promise<void> {
    const parent = joinRootPath(this.basePath, folderPath);
    const parentId = await this.findFidByPath(parent);
    const name = stripTrailingSlash(folderPath).split("/").pop() || "";
    if (!name) return;
    await this.request("/1/clouddrive/file", "POST", undefined, JSON.stringify({
      pdir_fid: parentId,
      file_name: name,
      file_dir: 1,
      module_id: "1505827882588285954",
    }));
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const fid = await this.getFidByKey(sourceKey);
    const parentPath = stripTrailingSlash(stripLeadingSlash(joinRootPath(this.basePath, destKey).replace(/[^/]*$/, "")));
    const parentId = await this.findFidByPath(parentPath);
    const name = stripTrailingSlash(destKey).split("/").pop() || "";
    await this.request("/1/clouddrive/share/sharepage/token", "POST", undefined, JSON.stringify({
      fid: fid,
      dstParentFid: parentId,
      fileName: name,
      shareType: 1,
    }));
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const fid = await this.getFidByKey(path);
    await this.request("/1/clouddrive/file/rename", "POST", undefined, JSON.stringify({ fid, fileName: newName }));
  }

  async moveObject(path: string, newPath: string): Promise<void> {
    // 夸克没有直接 move，copy后delete
    await this.copyObject(path, newPath);
    await this.deleteObject(path);
  }

  // Multipart upload：直接抛错，引导使用站内代理
  async initiateMultipartUpload(
    _key: string,
    _contentType: string,
    _options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    // 夸克网盘无标准 multipart API，需通过站内代理或分片上传
    throw new Error("Quark multipart upload not supported via direct API, use proxy upload");
  }
  async uploadPart(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _body: ReadableStream | ArrayBuffer,
    _contentLength?: number
  ): Promise<string> {
    throw new Error("Quark multipart upload not supported via direct API, use proxy upload");
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
    return "";
  }
}