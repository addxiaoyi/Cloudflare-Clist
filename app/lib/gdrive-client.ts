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

interface GoogleFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
}

interface GoogleListResponse {
  files: GoogleFile[];
  nextPageToken?: string;
}

const DEFAULT_GOOGLE_API_ADDRESS = "https://api.oplist.org/googleui/renewapi";

export class GoogleDriveClient {
  private config: Record<string, any>;
  private saving: Record<string, any>;
  private savingChanged = false;
  private configChanged = false;

  private readonly apiBase = "https://www.googleapis.com/drive/v3";
  private readonly uploadBase = "https://www.googleapis.com/upload/drive/v3";

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

  private async ensureToken(): Promise<void> {
    if (!this.saving.access_token || this.isTokenExpired()) {
      await this.refreshToken();
    }
  }

  private async refreshToken(): Promise<void> {
    if (shouldUseOnlineApi(this.config)) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.refreshTokenOnline();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Google refresh failed");
    }
    await this.refreshTokenLocal();
  }

  private async refreshTokenOnline(): Promise<void> {
    const refreshToken = getRefreshToken(this.config, this.saving);
    if (!refreshToken) {
      throw new Error("Missing refresh_token");
    }

    const url = new URL(getConfigString(this.config, ["api_address", "api_url_address"], DEFAULT_GOOGLE_API_ADDRESS));
    url.searchParams.set("refresh_ui", refreshToken);
    url.searchParams.set("server_use", "true");
    url.searchParams.set("driver_txt", "googleui_go");

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google online refresh failed: ${response.status} ${text}`);
    }

    const data = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      text?: string;
    };

    if (!data.access_token || !data.refresh_token) {
      throw new Error(data.text || "Google online refresh returned empty token");
    }

    this.saving.access_token = data.access_token;
    this.saving.refresh_token = data.refresh_token;
    this.config.refresh_token = data.refresh_token;
    this.saving.expires_at = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
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

    const formData = new URLSearchParams();
    formData.append("client_id", clientId);
    formData.append("client_secret", clientSecret);
    formData.append("refresh_token", refreshToken);
    formData.append("grant_type", "refresh_token");

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    const data = await response.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || data.error) {
      throw new Error(data.error_description || data.error || "Google refresh failed");
    }

    if (!data.access_token) {
      throw new Error("Google refresh returned empty token");
    }

    this.saving.access_token = data.access_token;
    if (data.refresh_token) {
      this.saving.refresh_token = data.refresh_token;
      this.config.refresh_token = data.refresh_token;
      this.markConfigChanged();
    }
    this.saving.expires_at = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
    this.markSavingChanged();
  }

  private async request(
    url: string,
    method: string = "GET",
    body?: any,
    headers?: Record<string, string>,
    retryAuth: boolean = true
  ): Promise<Response> {
    await this.ensureToken();
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.saving.access_token}`,
      ...headers,
    };
    const options: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (body !== undefined) {
      if (body instanceof ArrayBuffer || body instanceof Blob || body instanceof ReadableStream) {
        options.body = body as BodyInit;
      } else {
        requestHeaders["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
    }

    const response = await fetch(url, options);
    if (response.status === 401 && retryAuth) {
      await this.refreshToken();
      return this.request(url, method, body, headers, false);
    }
    return response;
  }

  private async requestJson(url: string, method: string = "GET", body?: any, headers?: Record<string, string>): Promise<any> {
    const response = await this.request(url, method, body, headers);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Drive request failed: ${response.status} ${text}`);
    }
    return response.json();
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
      const q = `'${currentId}' in parents and trashed = false and name = '${part.replace(/'/g, "\\'")}'`;
      const url = new URL(`${this.apiBase}/files`);
      url.searchParams.set("q", q);
      url.searchParams.set("fields", "files(id,name,mimeType)");
      url.searchParams.set("pageSize", "1");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      const result = await this.requestJson(url.toString());
      const file = (result.files || [])[0] as GoogleFile | undefined;
      if (!file) {
        return null;
      }
      currentId = file.id;
    }

    return currentId;
  }

  async listObjects(
    prefix: string = "",
    _delimiter: string = "/",
    maxKeys: number = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    const normalized = stripLeadingSlash(prefix || "");
    const folderId = await this.findFileIdByPath(normalized);
    if (!folderId) {
      return { objects: [], prefixes: [], isTruncated: false };
    }

    const url = new URL(`${this.apiBase}/files`);
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
    url.searchParams.set("fields", "files(id,name,mimeType,size,modifiedTime),nextPageToken");
    url.searchParams.set("pageSize", String(maxKeys));
    const orderBy = getConfigString(this.config, "order_by", "folder,name,modifiedTime");
    const orderDirection = getConfigString(this.config, "order_direction", "desc");
    url.searchParams.set("orderBy", `${orderBy} ${orderDirection}`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (continuationToken) {
      url.searchParams.set("pageToken", continuationToken);
    }

    const result = await this.requestJson(url.toString()) as GoogleListResponse;
    const objects: DriveObject[] = [];
    const prefixes: string[] = [];

    for (const file of result.files || []) {
      const isDirectory = file.mimeType === "application/vnd.google-apps.folder";
      const keyBase = normalized ? `${stripTrailingSlash(normalized)}/` : "";
      const key = isDirectory ? `${keyBase}${file.name}/` : `${keyBase}${file.name}`;
      objects.push({
        key,
        name: file.name,
        size: parseInt(file.size || "0", 10),
        lastModified: file.modifiedTime || "",
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
      isTruncated: !!result.nextPageToken,
      nextContinuationToken: result.nextPageToken,
    };
  }

  async getObject(key: string, _options?: { range?: string }): Promise<Response> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      throw new Error("Google Drive file not found");
    }
    const url = new URL(`${this.apiBase}/files/${fileId}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    return this.request(url.toString(), "GET");
  }

  async getSignedUrl(key: string, _expiresIn: number = 3600): Promise<string> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      throw new Error("Google Drive file not found");
    }
    const url = new URL(`${this.apiBase}/files/${fileId}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("access_token", this.saving.access_token || "");
    return url.toString();
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      return null;
    }
    const url = new URL(`${this.apiBase}/files/${fileId}`);
    url.searchParams.set("fields", "size,mimeType,modifiedTime");
    url.searchParams.set("supportsAllDrives", "true");
    const data = await this.requestJson(url.toString());
    return {
      contentLength: parseInt(data.size || "0", 10),
      contentType: data.mimeType || "application/octet-stream",
      lastModified: data.modifiedTime || "",
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const normalized = stripLeadingSlash(key);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "upload";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Google Drive parent not found");
    }

    const data = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
    if (data.byteLength <= 5 * 1024 * 1024) {
      const boundary = "clist_google_drive";
      const metadata = {
        name: fileName,
        parents: [parentId],
      };
      const payload = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\nContent-Type: ${contentType || "application/octet-stream"}\r\n\r\n`,
        new Uint8Array(data),
        `\r\n--${boundary}--`,
      ]);

      const url = `${this.uploadBase}/files?uploadType=multipart&fields=id&supportsAllDrives=true`;
      const response = await this.request(url, "POST", payload, {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google Drive upload failed: ${response.status} ${text}`);
      }
      return;
    }

    const uploadId = await this.initiateMultipartUpload(key, contentType || "application/octet-stream", {
      size: data.byteLength,
      chunkSize: 5 * 1024 * 1024,
    });
    const state = decodeUploadState(uploadId);
    const chunkSize = state.chunkSize as number;
    const totalSize = data.byteLength;
    let partNumber = 1;
    let offset = 0;

    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize, totalSize);
      const chunk = data.slice(offset, end);
      await this.uploadPart(key, uploadId, partNumber, chunk, chunk.byteLength);
      offset = end;
      partNumber++;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(key));
    if (!fileId) {
      return;
    }
    const url = `${this.apiBase}/files/${fileId}?supportsAllDrives=true`;
    const response = await this.request(url, "DELETE");
    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`Google Drive delete failed: ${response.status} ${text}`);
    }
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = stripTrailingSlash(stripLeadingSlash(folderPath));
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const folderName = normalized.split("/").pop() || "New Folder";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Google Drive parent not found");
    }
    const url = `${this.apiBase}/files?supportsAllDrives=true`;
    await this.requestJson(url, "POST", {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    });
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(sourceKey));
    if (!fileId) {
      throw new Error("Google Drive source not found");
    }
    const normalized = stripLeadingSlash(destKey);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "copy";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Google Drive parent not found");
    }
    const url = `${this.apiBase}/files/${fileId}/copy?supportsAllDrives=true`;
    await this.requestJson(url, "POST", {
      name: fileName,
      parents: [parentId],
    });
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(path));
    if (!fileId) {
      throw new Error("Google Drive file not found");
    }
    const url = `${this.apiBase}/files/${fileId}?supportsAllDrives=true`;
    await this.requestJson(url, "PATCH", { name: newName });
  }

  async moveObject(path: string, destPath: string): Promise<void> {
    const fileId = await this.findFileIdByPath(stripLeadingSlash(path));
    if (!fileId) {
      throw new Error("Google Drive file not found");
    }
    const normalizedDest = stripTrailingSlash(stripLeadingSlash(destPath));
    const parentPath = normalizedDest.includes("/") ? normalizedDest.slice(0, normalizedDest.lastIndexOf("/")) : "";
    const fileName = normalizedDest.split("/").pop() || stripLeadingSlash(path).split("/").pop() || "";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Google Drive destination not found");
    }
    const metaUrl = new URL(`${this.apiBase}/files/${fileId}`);
    metaUrl.searchParams.set("fields", "parents");
    metaUrl.searchParams.set("supportsAllDrives", "true");
    const meta = await this.requestJson(metaUrl.toString());
    const previousParents = (meta.parents || []).join(",");

    const url = new URL(`${this.apiBase}/files/${fileId}`);
    url.searchParams.set("addParents", parentId);
    url.searchParams.set("removeParents", previousParents);
    url.searchParams.set("supportsAllDrives", "true");
    await this.requestJson(url.toString(), "PATCH", { name: fileName });
  }

  async initiateMultipartUpload(
    key: string,
    contentType: string,
    options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    const normalized = stripLeadingSlash(key);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "upload";
    const parentId = await this.findFileIdByPath(parentPath);
    if (!parentId) {
      throw new Error("Google Drive parent not found");
    }

    const url = `${this.uploadBase}/files?uploadType=resumable&supportsAllDrives=true`;
    const response = await this.request(url, "POST", {
      name: fileName,
      parents: [parentId],
    }, {
      "X-Upload-Content-Type": contentType,
      "X-Upload-Content-Length": String(options?.size || 0),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Google Drive resumable init failed: ${response.status} ${text}`);
    }

    const uploadUrl = response.headers.get("Location");
    if (!uploadUrl) {
      throw new Error("Google Drive upload session missing");
    }

    return encodeUploadState({
      provider: "gdrive",
      uploadUrl,
      chunkSize: options?.chunkSize || 5 * 1024 * 1024,
      fileSize: options?.size || 0,
    });
  }

  async uploadPart(
    _key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream | ArrayBuffer,
    contentLength?: number
  ): Promise<string> {
    const state = decodeUploadState(uploadId);
    const uploadUrl = state.uploadUrl as string;
    const chunkSize = state.chunkSize as number;
    const fileSize = state.fileSize as number;
    const length = contentLength || (body instanceof ArrayBuffer ? body.byteLength : 0);
    const start = (partNumber - 1) * chunkSize;
    const end = start + length - 1;

    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": length.toString(),
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      },
      body: body as BodyInit,
      // @ts-expect-error duplex required for streams
      duplex: body instanceof ReadableStream ? "half" : undefined,
    });

    if (!response.ok && response.status !== 308) {
      const text = await response.text();
      throw new Error(`Google Drive upload part failed: ${response.status} ${text}`);
    }

    return response.headers.get("ETag")?.replace(/"/g, "") || `${partNumber}`;
  }

  async completeMultipartUpload(_key: string, _uploadId: string, _parts: { partNumber: number; etag: string }[]): Promise<void> {
    return;
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    const state = decodeUploadState(uploadId);
    if (state.uploadUrl) {
      await fetch(state.uploadUrl as string, { method: "DELETE" });
    }
  }

  async getSignedUploadPartUrl(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _expiresIn: number = 3600
  ): Promise<string> {
    throw new Error("Google Drive does not support direct signed upload URLs");
  }
}
