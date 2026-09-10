import { joinRootPath, stripLeadingSlash, stripTrailingSlash } from "./drive-utils";
import { encodeUploadState, decodeUploadState } from "./drive-utils";

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

const API_BASE = "https://api.dropboxapi.com";
const CONTENT_BASE = "https://content.dropboxapi.com";

interface DropboxFile {
  name: string;
  path_lower: string;
  id: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
  is_folder?: boolean;
}

interface ListFolderResult {
  entries: DropboxFile[];
  cursor?: string;
  has_more: boolean;
}

export class DropboxClient {
  private config: Record<string, any>;
  private saving: Record<string, any>;
  private basePath: string;

  constructor(options: { config?: Record<string, any>; saving?: Record<string, any> }) {
    this.config = options.config || {};
    this.saving = options.saving || {};
    this.basePath = this.config.root_path?.replace(/^\/|\/$/g, "") || "";
  }

  getStateUpdates(): { config?: Record<string, any>; saving?: Record<string, any> } | null {
    if (!this.savingChanged && !this.configChanged) return null;
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

  private getDisplayPath(fullKey: string): string {
    if (!this.basePath) return fullKey.replace(/^\//, "");
    if (fullKey.startsWith(this.basePath + "/")) {
      return fullKey.slice(this.basePath.length + 1);
    }
    return fullKey.replace(/^\/+/, "");
  }

  private getAccessToken(): string {
    return this.config.access_token || this.saving.access_token || "";
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.getAccessToken()}`,
      "Content-Type": "application/json",
    };
  }

  private request(path: string, body?: any): Promise<any> {
    return fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Dropbox API error: ${res.status} ${text.substring(0, 200)}`);
      }
      return res.json();
    });
  }

  private async listFiles(path: string = ""): Promise<DropboxFile[]> {
    const result: ListFolderResult = await this.request("/2/files/list_folder", {
      path,
      recursive: false,
      include_media_info: false,
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: true,
    });
    return result.entries || [];
  }

  public async listObjects(
    prefix = "",
    _delimiter = "/",
    _maxKeys = 1000,
    _continuationToken?: string
  ): Promise<ListObjectsResult> {
    const targetPath = prefix ? `/${stripLeadingSlash(prefix)}` : "";
    const files = await this.listFiles(targetPath);

    const objects: DriveObject[] = [];
    const prefixes: string[] = [];

    for (const file of files) {
      const isDir = file.is_folder === true || !file.size;
      const key = isDir
        ? this.getDisplayPath(`/dir/${file.path_lower}`)
        : this.getDisplayPath(file.path_lower);
      objects.push({
        key: isDir ? `${key}/` : key,
        name: file.name,
        size: file.size || 0,
        lastModified: file.server_modified
          ? new Date(file.server_modified).toISOString()
          : new Date().toISOString(),
        isDirectory: isDir,
        etag: file.id,
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

  async getObject(key: string): Promise<Response> {
    const path = `/${stripLeadingSlash(key)}`;
    const result = await this.request("/2/files/get_metadata", { path });
    if (result.is_folder) {
      return new Response("Directory", { status: 400 });
    }

    const content = await fetch(`${CONTENT_BASE}/2/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getAccessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path }),
    });

    if (!content.ok) {
      const text = await content.text();
      throw new Error(`Dropbox download error: ${content.status} ${text}`);
    }
    return content;
  }

  async getSignedUrl(key: string, _expiresIn: number = 3600): Promise<string> {
    const path = `/${stripLeadingSlash(key)}`;
    const result = await this.request("/2/files/get_temporary_link", { path });
    return result.link || "";
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const result = await this.request("/2/files/get_metadata", { path: `/${stripLeadingSlash(key)}` });
    if (result.is_folder) return null;
    return {
      contentLength: result.size || 0,
      contentType: "application/octet-stream",
      lastModified: result.server_modified
        ? new Date(result.server_modified).toISOString()
        : new Date().toISOString(),
    };
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType: string): Promise<void> {
    const path = `/${stripLeadingSlash(key)}`;
    const arg = { path, mode: "overwrite", autorename: false, mute: false };
    const result = await fetch(`${CONTENT_BASE}/2/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getAccessToken()}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(arg),
      },
      body: typeof body === "string" ? body : new Uint8Array(body),
    });

    if (!result.ok) {
      const text = await result.text();
      throw new Error(`Dropbox upload error: ${result.status} ${text}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.request("/2/files/delete_v2", { path: `/${stripLeadingSlash(key)}` });
  }

  async createFolder(folderPath: string): Promise<void> {
    const path = `/${stripTrailingSlash(folderPath)}`;
    await this.request("/2/files/create_folder", { path });
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    await this.request("/2/files/copy_v2", {
      from_path: `/${stripLeadingSlash(sourceKey)}`,
      to_path: `/${stripTrailingSlash(destKey)}`,
      autorename: false,
    });
  }

  async renameObject(path: string, newName: string): Promise<void> {
    await this.request("/2/files/update_name", {
      path: `/${stripLeadingSlash(path)}`,
      new_name: newName,
    });
  }

  async moveObject(path: string, newPath: string): Promise<void> {
    await this.request("/2/files/move_v2", {
      from_path: `/${stripLeadingSlash(path)}`,
      to_path: `/${stripTrailingSlash(newPath)}`,
      autorename: false,
    });
  }

  async initiateMultipartUpload(
    _key: string,
    _contentType: string,
    _options?: { size?: number; chunkSize?: number }
  ): Promise<string> {
    throw new Error("Dropbox multipart upload not supported, use direct upload");
  }
  async uploadPart(): Promise<string> {
    throw new Error("Dropbox multipart upload not supported");
  }
  async completeMultipartUpload(): Promise<void> {
    return;
  }
  async abortMultipartUpload(): Promise<void> {
    return;
  }
  async getSignedUploadPartUrl(): Promise<string> {
    return "";
  }
}