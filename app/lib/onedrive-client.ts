import {
  decodeUploadState,
  encodeUploadState,
  getConfigString,
  getRefreshToken,
  joinRootPath,
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

const ONEDRIVE_HOSTS: Record<string, { api: string; oauth: string }> = {
  global: {
    api: "https://graph.microsoft.com",
    oauth: "https://login.microsoftonline.com",
  },
  cn: {
    api: "https://microsoftgraph.chinacloudapi.cn",
    oauth: "https://login.chinacloudapi.cn",
  },
  us: {
    api: "https://graph.microsoft.us",
    oauth: "https://login.microsoftonline.us",
  },
  de: {
    api: "https://graph.microsoft.de",
    oauth: "https://login.microsoftonline.de",
  },
};

const DEFAULT_ONEDRIVE_API_ADDRESS = "https://api.oplist.org/onedrive/renewapi";
const DEFAULT_ONEDRIVE_REDIRECT_URI = "https://api.oplist.org/onedrive/callback";

interface OneDriveItem {
  id: string;
  name: string;
  size?: number;
  file?: {
    mimeType?: string;
  };
  folder?: Record<string, unknown>;
  lastModifiedDateTime?: string;
  fileSystemInfo?: {
    lastModifiedDateTime?: string;
    createdDateTime?: string;
  };
  "@microsoft.graph.downloadUrl"?: string;
}

interface OneDriveListResponse {
  value: OneDriveItem[];
  "@odata.nextLink"?: string;
}

export class OneDriveClient {
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

  private getHost() {
    const region = (this.config.region || "global") as string;
    return ONEDRIVE_HOSTS[region] || ONEDRIVE_HOSTS.global;
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
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.refreshTokenOnce();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OneDrive refresh failed");
  }

  private async refreshTokenOnce(): Promise<void> {
    if (shouldUseOnlineApi(this.config)) {
      await this.refreshTokenOnline();
      return;
    }
    await this.refreshTokenLocal();
  }

  private async refreshTokenOnline(): Promise<void> {
    const apiAddress = getConfigString(this.config, ["api_address", "api_url_address"], DEFAULT_ONEDRIVE_API_ADDRESS);
    const refreshToken = getRefreshToken(this.config, this.saving);
    if (!refreshToken) {
      throw new Error("Missing refresh_token");
    }

    const url = new URL(apiAddress);
    url.searchParams.set("refresh_ui", refreshToken);
    url.searchParams.set("server_use", "true");
    url.searchParams.set("driver_txt", "onedrive_pr");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible)",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OneDrive online refresh failed: ${response.status} ${text}`);
    }

    const data = await response.json() as { refresh_token?: string; access_token?: string; expires_in?: number; text?: string };
    if (!data.refresh_token || !data.access_token) {
      throw new Error(data.text || "OneDrive online refresh returned empty token");
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

    const host = this.getHost();
    const url = `${host.oauth}/common/oauth2/v2.0/token`;

    const formData = new URLSearchParams();
    formData.append("grant_type", "refresh_token");
    formData.append("client_id", clientId);
    formData.append("client_secret", clientSecret);
    formData.append("redirect_uri", getConfigString(this.config, "redirect_uri", DEFAULT_ONEDRIVE_REDIRECT_URI));
    formData.append("refresh_token", refreshToken);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    const text = await response.text();
    let data: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("OneDrive refresh parse failed");
    }

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }

    if (!data.access_token) {
      throw new Error("OneDrive refresh returned empty token");
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

  private getDriveRootUrl(): string {
    const host = this.getHost();
    if (this.config.is_sharepoint && this.config.site_id) {
      return `${host.api}/v1.0/sites/${this.config.site_id}/drive/root`;
    }
    return `${host.api}/v1.0/me/drive/root`;
  }

  private encodePath(path: string): string {
    return path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  private getDrivePath(path: string): string {
    const resolved = this.resolvePath(path);
    const relative = stripLeadingSlash(resolved);
    return this.encodePath(relative);
  }

  private resolvePath(path: string): string {
    const rootPath = this.config.root_folder_path || "/";
    const resolved = joinRootPath(rootPath, path);
    return stripTrailingSlash(resolved);
  }

  private async request(
    url: string,
    method: string = "GET",
    body?: any,
    headers?: Record<string, string>,
    retryAuth: boolean = true
  ): Promise<any> {
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
    if (!response.ok) {
      if (response.status === 401 && retryAuth) {
        await this.refreshToken();
        return this.request(url, method, body, headers, false);
      }
      const text = await response.text();
      throw new Error(`OneDrive request failed: ${response.status} ${text}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }

  private async getItemByPath(path: string): Promise<OneDriveItem> {
    const rootUrl = this.getDriveRootUrl();
    const resolved = this.resolvePath(path);
    if (!resolved || resolved === "/") {
      return this.request(rootUrl, "GET");
    }
    const encoded = this.getDrivePath(path);
    return this.request(`${rootUrl}:/${encoded}:`, "GET");
  }

  private async getChildrenByPath(path: string, continuationToken?: string): Promise<OneDriveListResponse> {
    if (continuationToken) {
      return this.request(continuationToken, "GET");
    }
    const rootUrl = this.getDriveRootUrl();
    const resolved = this.resolvePath(path);
    const baseUrl = resolved && resolved !== "/"
      ? `${rootUrl}:/${this.getDrivePath(path)}:/children`
      : `${rootUrl}/children`;
    const url = new URL(baseUrl);
    url.searchParams.set("$top", "1000");
    return this.request(url.toString(), "GET");
  }

  async listObjects(
    prefix: string = "",
    _delimiter: string = "/",
    _maxKeys: number = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    const normalized = stripLeadingSlash(prefix || "");
    const path = normalized ? `/${stripTrailingSlash(normalized)}` : "/";
    const result = await this.getChildrenByPath(path, continuationToken);
    const objects: DriveObject[] = [];
    const prefixes: string[] = [];

    for (const item of result.value) {
      const isDirectory = !!item.folder;
      const name = item.name;
      const keyBase = normalized ? `${stripTrailingSlash(normalized)}/` : "";
      const key = isDirectory ? `${keyBase}${name}/` : `${keyBase}${name}`;
      objects.push({
        key,
        name,
        size: item.size || 0,
        lastModified: item.fileSystemInfo?.lastModifiedDateTime || item.lastModifiedDateTime || "",
        isDirectory,
        etag: undefined,
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
      isTruncated: !!result["@odata.nextLink"],
      nextContinuationToken: result["@odata.nextLink"],
    };
  }

  async getObject(key: string, options?: { range?: string }): Promise<Response> {
    const item = await this.getItemByPath(`/${stripLeadingSlash(key)}`);
    const url = item["@microsoft.graph.downloadUrl"];
    if (!url) {
      throw new Error("OneDrive download URL missing");
    }
    // Graph 直链支持 Range，拖动进度条时可直接分段取流
    return fetch(url, { headers: options?.range ? { Range: options.range } : undefined });
  }

  async getSignedUrl(key: string, _expiresIn: number = 3600): Promise<string> {
    const item = await this.getItemByPath(`/${stripLeadingSlash(key)}`);
    if (!item["@microsoft.graph.downloadUrl"]) {
      throw new Error("OneDrive download URL missing");
    }
    let url = item["@microsoft.graph.downloadUrl"];
    if (this.config.custom_host) {
      const urlObj = new URL(url);
      urlObj.host = this.config.custom_host;
      url = urlObj.toString();
    }
    return url;
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const item = await this.getItemByPath(`/${stripLeadingSlash(key)}`);
    if (!item || item.folder) {
      return null;
    }
    return {
      contentLength: item.size || 0,
      contentType: item.file?.mimeType || "application/octet-stream",
      lastModified: item.fileSystemInfo?.lastModifiedDateTime || item.lastModifiedDateTime || "",
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const normalized = stripLeadingSlash(key);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "upload";
    const data = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;

    if (data.byteLength <= 4 * 1024 * 1024) {
      const parentEncoded = this.getDrivePath(`/${parentPath}`);
      const uploadPath = parentEncoded
        ? `${parentEncoded}/${encodeURIComponent(fileName)}`
        : `${encodeURIComponent(fileName)}`;
      const uploadUrl = `${this.getDriveRootUrl()}:/${uploadPath}:/content`;
      await this.request(uploadUrl, "PUT", data, {
        "Content-Type": contentType || "application/octet-stream",
      });
      return;
    }

    const uploadId = await this.initiateMultipartUpload(key, contentType || "application/octet-stream", {
      size: data.byteLength,
      chunkSize: (this.config.chunk_size ? Number(this.config.chunk_size) : 5) * 1024 * 1024,
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
    const item = await this.getItemByPath(`/${stripLeadingSlash(key)}`);
    const url = `${this.getDriveRootUrl()}/items/${item.id}`;
    await this.request(url, "DELETE");
  }

  async createFolder(folderPath: string): Promise<void> {
    const normalized = stripTrailingSlash(stripLeadingSlash(folderPath));
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const folderName = normalized.split("/").pop() || "New Folder";
    const parent = await this.getItemByPath(`/${parentPath}`);

    const url = `${this.getDriveRootUrl()}/items/${parent.id}/children`;
    await this.request(url, "POST", {
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "rename",
    });
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const source = await this.getItemByPath(`/${stripLeadingSlash(sourceKey)}`);
    const normalized = stripLeadingSlash(destKey);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "";
    const parent = await this.getItemByPath(`/${parentPath}`);
    const url = `${this.getDriveRootUrl()}/items/${source.id}/copy`;
    await this.request(url, "POST", {
      parentReference: { id: parent.id },
      name: fileName,
    });
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const item = await this.getItemByPath(`/${stripLeadingSlash(path)}`);
    const url = `${this.getDriveRootUrl()}/items/${item.id}`;
    await this.request(url, "PATCH", { name: newName });
  }

  async moveObject(path: string, destPath: string): Promise<void> {
    const item = await this.getItemByPath(`/${stripLeadingSlash(path)}`);
    const normalizedDest = stripTrailingSlash(stripLeadingSlash(destPath));
    const parentPath = normalizedDest.includes("/") ? normalizedDest.slice(0, normalizedDest.lastIndexOf("/")) : "";
    const newName = normalizedDest.split("/").pop() || item.name;
    const parent = await this.getItemByPath(`/${parentPath}`);
    const url = `${this.getDriveRootUrl()}/items/${item.id}`;
    await this.request(url, "PATCH", {
      parentReference: {
        id: parent.id,
      },
      name: newName,
    });
  }

  async initiateMultipartUpload(
    key: string,
    contentType: string,
    options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    const normalized = stripLeadingSlash(key);
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    const fileName = normalized.split("/").pop() || "upload";
    const parent = await this.getItemByPath(`/${parentPath}`);
    const url = `${this.getDriveRootUrl()}/items/${parent.id}:/${encodeURIComponent(fileName)}:/createUploadSession`;
    const result = await this.request(url, "POST", {
      item: {
        "@microsoft.graph.conflictBehavior": "rename",
        name: fileName,
      },
    });
    const uploadUrl = result.uploadUrl as string;
    if (!uploadUrl) {
      throw new Error("OneDrive upload session missing");
    }
    return encodeUploadState({
      provider: "onedrive",
      uploadUrl,
      chunkSize: options?.chunkSize || 5 * 1024 * 1024,
      fileSize: options?.size || 0,
      contentType,
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

    if (!response.ok && response.status !== 202) {
      const text = await response.text();
      throw new Error(`OneDrive upload part failed: ${response.status} ${text}`);
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
    throw new Error("OneDrive does not support direct signed upload URLs");
  }
}
