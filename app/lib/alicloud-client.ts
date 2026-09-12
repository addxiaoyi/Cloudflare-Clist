import {
  decodeUploadState,
  encodeUploadState,
  getConfigString,
  getRefreshToken,
  shouldUseOnlineApi,
  stripLeadingSlash,
  stripTrailingSlash,
} from "./drive-utils";

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

const API_URL = "https://openapi.alipan.com";
const DEFAULT_ALICLOUD_API_ADDRESS = "https://api.oplist.org/alicloud/renewapi";

const API_ENDPOINTS = {
  GET_DRIVE_INFO: "/adrive/v1.0/user/getDriveInfo",
  FILE_LIST: "/adrive/v1.0/openFile/list",
  FILE_CREATE: "/adrive/v1.0/openFile/create",
  FILE_UPDATE: "/adrive/v1.0/openFile/update",
  FILE_DELETE: "/adrive/v1.0/openFile/delete",
  FILE_TRASH: "/adrive/v1.0/openFile/recyclebin/trash",
  FILE_MOVE: "/adrive/v1.0/openFile/move",
  FILE_COPY: "/adrive/v1.0/openFile/copy",
  FILE_GET_DOWNLOAD_URL: "/adrive/v1.0/openFile/getDownloadUrl",
  FILE_COMPLETE: "/adrive/v1.0/openFile/complete",
  OAUTH_TOKEN: "/oauth/access_token",
};

interface AliyunFile {
  file_id: string;
  name: string;
  type: string;
  size?: number;
  updated_at?: string;
  content_hash?: string;
  thumbnail?: string;
}

interface AliyunListResponse {
  items: AliyunFile[];
  next_marker?: string;
}

interface AliyunCreateResponse {
  file_id: string;
  upload_id?: string;
  part_info_list?: Array<{ part_number: number; upload_url: string }>;
  rapid_upload?: boolean;
}

interface AliyunDownloadResponse {
  url?: string;
  streams_url?: Record<string, string>;
  streamsUrl?: Record<string, string>;
}

export class AliyunDriveClient {
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
      return true;
    }
    return Date.now() >= this.saving.expires_at - 5 * 60 * 1000;
  }

  private async ensureAccessToken(): Promise<void> {
    if (!this.saving.access_token || this.isTokenExpired()) {
      await this.refreshToken();
    }
  }

  private async ensureToken(): Promise<void> {
    await this.ensureAccessToken();
    if (!this.saving.drive_id) {
      await this.loadDriveInfo();
    }
  }

  private async refreshToken(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.refreshTokenOnce();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Aliyun refresh failed");
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

    const url = new URL(getConfigString(this.config, ["api_address", "api_url_address"], DEFAULT_ALICLOUD_API_ADDRESS));
    url.searchParams.set("refresh_ui", refreshToken);
    url.searchParams.set("server_use", "true");
    const driverTxt = this.config.alipan_type === "alipanTV" ? "alicloud_tv" : "alicloud_qr";
    url.searchParams.set("driver_txt", driverTxt);

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Aliyun online refresh failed: ${response.status} ${text}`);
    }
    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; text?: string };
    if (!data.access_token || !data.refresh_token) {
      throw new Error(data.text || "Aliyun online refresh returned empty token");
    }

    this.saving.access_token = data.access_token;
    this.saving.refresh_token = data.refresh_token;
    this.saving.expires_at = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
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

    const response = await fetch(`${API_URL}${API_ENDPOINTS.OAUTH_TOKEN}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; message?: string; code?: string };
    if (!response.ok || data.code) {
      throw new Error(data.message || "Aliyun refresh failed");
    }
    if (!data.access_token || !data.refresh_token) {
      throw new Error("Aliyun refresh returned empty token");
    }
    this.saving.access_token = data.access_token;
    this.saving.refresh_token = data.refresh_token;
    this.saving.expires_at = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
    this.config.refresh_token = data.refresh_token;
    this.markSavingChanged();
    this.markConfigChanged();
  }

  private async loadDriveInfo(): Promise<void> {
    await this.ensureAccessToken();
    const data = await this.requestJsonRaw(API_ENDPOINTS.GET_DRIVE_INFO, "POST", {});
    const driveType = this.config.drive_type || "resource";
    const driveIdKey = `${driveType}_drive_id`;
    const driveId = data[driveIdKey];
    if (!driveId) {
      throw new Error("Aliyun drive_id missing");
    }
    this.saving.drive_id = driveId;
    this.saving.user_id = data.user_id;
    this.markSavingChanged();
  }

  private async request(
    endpoint: string,
    method: string = "POST",
    body?: any,
    retryAuth: boolean = true
  ): Promise<Response> {
    await this.ensureToken();
    return this.requestRaw(endpoint, method, body, retryAuth);
  }

  private async requestRaw(
    endpoint: string,
    method: string = "POST",
    body?: any,
    retryAuth: boolean = true
  ): Promise<Response> {
    const url = `${API_URL}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.saving.access_token}`,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    const options: RequestInit = {
      method,
      headers,
    };
    if (body && method === "POST") {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    if (response.status === 401 && retryAuth) {
      await this.refreshToken();
      return this.requestRaw(endpoint, method, body, false);
    }
    return response;
  }

  private async requestJson(
    endpoint: string,
    method: string = "POST",
    body?: any,
    retryAuth: boolean = true
  ): Promise<any> {
    const response = await this.request(endpoint, method, body);
    const data = await this.parseJsonResponse(response);
    if (this.isAuthErrorCode(data.code) && retryAuth) {
      await this.refreshToken();
      return this.requestJson(endpoint, method, body, false);
    }
    this.assertApiSuccess(response, data);
    return data;
  }

  private async requestJsonRaw(
    endpoint: string,
    method: string = "POST",
    body?: any,
    retryAuth: boolean = true
  ): Promise<any> {
    const response = await this.requestRaw(endpoint, method, body);
    const data = await this.parseJsonResponse(response);
    if (this.isAuthErrorCode(data.code) && retryAuth) {
      await this.refreshToken();
      return this.requestJsonRaw(endpoint, method, body, false);
    }
    this.assertApiSuccess(response, data);
    return data;
  }

  private async parseJsonResponse(response: Response): Promise<any> {
    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Aliyun API parse failed: ${text.substring(0, 200)}`);
    }
    return data;
  }

  private isAuthErrorCode(code: unknown): boolean {
    return code === "AccessTokenInvalid" || code === "AccessTokenExpired" || code === "I400JD";
  }

  private assertApiSuccess(response: Response, data: any): void {
    if (!response.ok || data.code) {
      throw new Error(data.message || "Aliyun API error");
    }
  }

  private getRootId(): string {
    return this.config.root_folder_id || "root";
  }

  private async findFileIdByPath(path: string): Promise<string | null> {
    const normalized = stripLeadingSlash(path);
    if (!normalized) {
      return this.getRootId();
    }

    const parts = normalized.split("/").filter(Boolean);
    let currentId = this.getRootId();
    for (const part of parts) {
      const list = await this.listFiles(currentId);
      const found = list.find((f) => f.name === part);
      if (!found) {
        return null;
      }
      currentId = found.file_id;
    }
    return currentId;
  }

  private async listFiles(parentId: string, marker?: string): Promise<AliyunFile[]> {
    const result: AliyunFile[] = [];
    let nextMarker = marker || "";
    do {
      const body: Record<string, any> = {
        drive_id: this.saving.drive_id,
        parent_file_id: parentId,
        limit: 200,
        order_by: this.config.order_by || "name",
        order_direction: this.config.order_direction || "ASC",
      };
      if (nextMarker) {
        body.marker = nextMarker;
      }
      const response = await this.requestJson(API_ENDPOINTS.FILE_LIST, "POST", body) as AliyunListResponse;
      result.push(...response.items);
      nextMarker = response.next_marker || "";
    } while (nextMarker);
    return result;
  }

  async listObjects(
    prefix: string = "",
    _delimiter: string = "/",
    _maxKeys: number = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    const normalized = stripLeadingSlash(prefix || "");
    const folderId = await this.findFileIdByPath(normalized);
    if (!folderId) {
      return { objects: [], prefixes: [], isTruncated: false };
    }

    const response = await this.requestJson(API_ENDPOINTS.FILE_LIST, "POST", {
      drive_id: this.saving.drive_id,
      parent_file_id: folderId,
      limit: 200,
      order_by: this.config.order_by || "name",
      order_direction: this.config.order_direction || "ASC",
      marker: continuationToken || undefined,
    }) as AliyunListResponse;

    const objects: DriveObject[] = [];
    const prefixes: string[] = [];
    const keyBase = normalized ? `${stripTrailingSlash(normalized)}/` : "";

    for (const item of response.items || []) {
      const isDirectory = item.type === "folder";
      const key = isDirectory ? `${keyBase}${item.name}/` : `${keyBase}${item.name}`;
      objects.push({
        key,
        name: item.name,
        size: item.size || 0,
        lastModified: item.updated_at || "",
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
      isTruncated: !!response.next_marker,
      nextContinuationToken: response.next_marker,
    };
  }

  async getObject(key: string, _options?: { range?: string }): Promise<Response> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      throw new Error("Aliyun file not found");
    }
    const response = await this.requestJson(API_ENDPOINTS.FILE_GET_DOWNLOAD_URL, "POST", {
      drive_id: this.saving.drive_id,
      file_id: fileId,
      expire_sec: 14400,
    }) as AliyunDownloadResponse;
    const streams = response.streamsUrl || response.streams_url;
    const url = response.url || streams?.[this.config.livp_download_format || "jpeg"];
    if (!url) {
      throw new Error("Aliyun download URL missing");
    }
    // 阿里云盘下载 URL 不支持自定义 Range 透传，_options 仅保持签名一致
    return fetch(url);
  }

  async getSignedUrl(key: string): Promise<string> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      throw new Error("Aliyun file not found");
    }
    const response = await this.requestJson(API_ENDPOINTS.FILE_GET_DOWNLOAD_URL, "POST", {
      drive_id: this.saving.drive_id,
      file_id: fileId,
      expire_sec: 14400,
    }) as AliyunDownloadResponse;
    const streams = response.streamsUrl || response.streams_url;
    const url = response.url || streams?.[this.config.livp_download_format || "jpeg"];
    if (!url) {
      throw new Error("Aliyun download URL missing");
    }
    return url;
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      return null;
    }
    const parentPath = stripLeadingSlash(key).split("/").slice(0, -1).join("/");
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      return null;
    }
    const files = await this.listFiles(parentId);
    const name = stripLeadingSlash(key).split("/").pop() || "";
    const file = files.find((item) => item.name === name);
    if (!file) {
      return null;
    }
    return {
      contentLength: file.size || 0,
      contentType: "application/octet-stream",
      lastModified: file.updated_at || "",
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const normalized = stripLeadingSlash(key);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "upload";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Aliyun parent not found");
    }

    const data = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
    const size = data.byteLength;
    const create = await this.requestJson(API_ENDPOINTS.FILE_CREATE, "POST", {
      drive_id: this.saving.drive_id,
      parent_file_id: parentId,
      name: fileName,
      type: "file",
      size,
      part_info_list: [{ part_number: 1 }],
    }) as AliyunCreateResponse;

    if (!create.part_info_list || create.part_info_list.length === 0) {
      throw new Error("Aliyun upload url missing");
    }

    await fetch(create.part_info_list[0].upload_url, {
      method: "PUT",
      body: data,
      headers: {
        "Content-Type": contentType || "application/octet-stream",
      },
    });

    if (create.upload_id) {
      await this.requestJson(API_ENDPOINTS.FILE_COMPLETE, "POST", {
        drive_id: this.saving.drive_id,
        file_id: create.file_id,
        upload_id: create.upload_id,
      });
    }
  }

  async deleteObject(key: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      return;
    }
    const endpoint = this.config.remove_way === "delete" ? API_ENDPOINTS.FILE_DELETE : API_ENDPOINTS.FILE_TRASH;
    await this.requestJson(endpoint, "POST", {
      drive_id: this.saving.drive_id,
      file_id: fileId,
    });
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = stripTrailingSlash(stripLeadingSlash(folderPath));
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const folderName = normalized.split("/").pop() || "New Folder";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Aliyun parent not found");
    }
    await this.requestJson(API_ENDPOINTS.FILE_CREATE, "POST", {
      drive_id: this.saving.drive_id,
      parent_file_id: parentId,
      name: folderName,
      type: "folder",
      check_name_mode: "rename",
    });
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(sourceKey));
    if (!fileId) {
      throw new Error("Aliyun source not found");
    }
    const normalized = stripLeadingSlash(destKey);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "copy";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Aliyun parent not found");
    }
    await this.requestJson(API_ENDPOINTS.FILE_COPY, "POST", {
      drive_id: this.saving.drive_id,
      file_id: fileId,
      to_parent_file_id: parentId,
      auto_rename: false,
      name: fileName,
    });
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(path));
    if (!fileId) {
      throw new Error("Aliyun file not found");
    }
    await this.requestJson(API_ENDPOINTS.FILE_UPDATE, "POST", {
      drive_id: this.saving.drive_id,
      file_id: fileId,
      name: newName,
    });
  }

  async moveObject(path: string, destPath: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(path));
    if (!fileId) {
      throw new Error("Aliyun file not found");
    }
    const normalizedDest = stripTrailingSlash(stripLeadingSlash(destPath));
    const parentPath = normalizedDest.includes("/") ? normalizedDest.slice(0, normalizedDest.lastIndexOf("/")) : "";
    const oldName = stripLeadingSlash(path).split("/").pop() || "";
    const fileName = normalizedDest.split("/").pop() || oldName;
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Aliyun destination not found");
    }
    await this.requestJson(API_ENDPOINTS.FILE_MOVE, "POST", {
      drive_id: this.saving.drive_id,
      file_id: fileId,
      to_parent_file_id: parentId,
      check_name_mode: "rename",
    });
    if (fileName && fileName !== oldName) {
      const movedPath = parentPath ? `${parentPath}/${oldName}` : oldName;
      await this.renameObject(movedPath, fileName);
    }
  }

  async initiateMultipartUpload(
    key: string,
    _contentType: string,
    options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    const normalized = stripLeadingSlash(key);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "upload";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Aliyun parent not found");
    }

    const fileSize = options?.size || 0;
    const chunkSize = options?.chunkSize || 20 * 1024 * 1024;
    const partCount = Math.max(1, Math.ceil(fileSize / chunkSize));
    const partInfoList = Array.from({ length: partCount }, (_, idx) => ({ part_number: idx + 1 }));

    const create = await this.requestJson(API_ENDPOINTS.FILE_CREATE, "POST", {
      drive_id: this.saving.drive_id,
      parent_file_id: parentId,
      name: fileName,
      type: "file",
      size: fileSize,
      part_info_list: partInfoList,
      check_name_mode: "rename",
    }) as AliyunCreateResponse;

    if (!create.upload_id || !create.part_info_list) {
      throw new Error("Aliyun upload session missing");
    }

    return encodeUploadState({
      provider: "alicloud",
      fileId: create.file_id,
      uploadId: create.upload_id,
      partInfo: create.part_info_list,
      chunkSize,
      fileSize,
    });
  }

  async uploadPart(
    _key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream | ArrayBuffer,
    _contentLength?: number
  ): Promise<string> {
    const state = decodeUploadState(uploadId);
    const partInfo = (state.partInfo as Array<{ part_number: number; upload_url: string }>) || [];
    const part = partInfo.find((p) => p.part_number === partNumber);
    if (!part) {
      throw new Error("Aliyun part info missing");
    }

    const response = await fetch(part.upload_url, {
      method: "PUT",
      body: body as BodyInit,
      // @ts-expect-error duplex required for streams
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });

    if (!response.ok && response.status !== 409) {
      const text = await response.text();
      throw new Error(`Aliyun upload part failed: ${response.status} ${text}`);
    }

    return response.headers.get("ETag")?.replace(/"/g, "") || `${partNumber}`;
  }

  async completeMultipartUpload(_key: string, uploadId: string, _parts: { partNumber: number; etag: string }[]): Promise<void> {
    const state = decodeUploadState(uploadId);
    await this.requestJson(API_ENDPOINTS.FILE_COMPLETE, "POST", {
      drive_id: this.saving.drive_id,
      file_id: state.fileId,
      upload_id: state.uploadId,
    });
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    const state = decodeUploadState(uploadId);
    if (!state.fileId) {
      return;
    }
    const endpoint = this.config.remove_way === "delete" ? API_ENDPOINTS.FILE_DELETE : API_ENDPOINTS.FILE_TRASH;
    await this.requestJson(endpoint, "POST", {
      drive_id: this.saving.drive_id,
      file_id: state.fileId,
    });
  }

  async getSignedUploadPartUrl(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _expiresIn: number = 3600
  ): Promise<string> {
    throw new Error("Aliyun Drive does not support direct signed upload URLs");
  }
}
