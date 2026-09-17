import { stripLeadingSlash, stripTrailingSlash } from './drive-utils';
import { getMimeType } from './file-utils';
import { md5Hex, sha1Hex } from './md5';

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

const API_BASE = 'https://drive.quark.cn';
const DEFAULT_API_ADDRESS = 'https://api.oplist.org/quark/renewapi';

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
  data: Array<{
    fid: number;
    name: string;
    type: number;
    size?: number;
    modified_time?: number;
    is_dir?: number;
  }>;
  total?: number;
  cursor?: string;
}

export class QuarkClient {
  private config: Record<string, any>;
  private saving: Record<string, any>;
  private basePath: string;

  constructor(options: {
    config?: Record<string, any>;
    saving?: Record<string, any>;
  }) {
    this.config = options.config || {};
    this.saving = options.saving || {};
    this.basePath = this.config.root_path?.replace(/^\/|\/$/g, '') || '';
  }

  getStateUpdates(): {
    config?: Record<string, any>;
    saving?: Record<string, any>;
  } | null {
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
    return this.config.cookie || this.saving.cookie || '';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Cookie: this.getCookie(),
    };
    const apiAddress = this.config.use_online_api
      ? this.config.api_address || DEFAULT_API_ADDRESS
      : null;
    if (apiAddress) {
      h['X-API-Address'] = apiAddress;
    }
    return h;
  }

  private getFullPath(path: string): string {
    const cleanPath = stripLeadingSlash(path);
    return this.basePath ? `${this.basePath}/${cleanPath}` : cleanPath;
  }

  private getDisplayPath(fullKey: string): string {
    if (!this.basePath) return fullKey;
    return fullKey.startsWith(this.basePath + '/')
      ? fullKey.slice(this.basePath.length + 1)
      : fullKey.replace(/^\/+/, '');
  }

  private request(
    pathname: string,
    method: string = 'GET',
    params?: Record<string, string>,
    body?: string,
  ): Promise<any> {
    const url = new URL(`${API_BASE}${pathname}`);
    url.searchParams.set('pr', 'ucpro');
    url.searchParams.set('fr', 'pc');
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
      options.headers = {
        ...(options.headers as Record<string, string>),
        'Content-Type': 'application/json',
      };
      options.body = body;
    }

    return fetch(url.toString(), options).then(async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Quark API error: ${res.status} ${text.substring(0, 200)}`,
        );
      }
      const data: Record<string, any> = await res.json();
      if (data.code && data.code !== '0') {
        throw new Error(`Quark API error: ${data.code} ${data.message || ''}`);
      }
      return data;
    });
  }

  private async listFilesByFid(pdirFid: string): Promise<QuarkFile[]> {
    const result: QuarkListResponse = await this.request(
      '/1/clouddrive/file/sort',
      'GET',
      {
        pdir_fid: pdirFid,
        _page: '1',
        _size: '1000',
        _sort: 'file_path:asc',
      },
    );
    return Array.isArray(result.data) ? result.data : [];
  }

  private async findFidByPath(path: string): Promise<number> {
    const normalized = stripTrailingSlash(stripLeadingSlash(path));
    if (!normalized) return 0;
    const parts = normalized.split('/').filter(Boolean);
    let pdirFid = '0';
    for (const part of parts) {
      const files = await this.listFilesByFid(pdirFid);
      const found = files.find((f) => f.name === part);
      if (!found) return -1;
      pdirFid = String(found.fid);
    }
    return Number(pdirFid);
  }

  async listObjects(
    prefix: string = '',
    _delimiter: string = '/',
    maxKeys: number = 1000,
    _continuationToken?: string,
  ): Promise<ListObjectsResult> {
    const targetPath = this.getFullPath(prefix || '/');
    const curFid = await this.findFidByPath(targetPath);
    if (curFid < 0) {
      return { objects: [], prefixes: [], isTruncated: false };
    }
    const files = await this.listFilesByFid(String(curFid));
    const objects: DriveObject[] = [];
    const prefixes: string[] = [];

    const parentDisplay = stripLeadingSlash(stripTrailingSlash(prefix || ''));
    for (const file of files || []) {
      const isDir = file.type === 1 || file.is_dir === 1;
      const childDisplay = parentDisplay
        ? `${parentDisplay}/${file.name}`
        : file.name;
      objects.push({
        key: isDir ? `${childDisplay}/` : childDisplay,
        name: file.name,
        size: file.size || 0,
        lastModified: file.modified_time
          ? new Date(file.modified_time * 1000).toISOString()
          : new Date().toISOString(),
        isDirectory: isDir,
        etag: String(file.fid),
      });
      if (isDir) {
        prefixes.push(childDisplay);
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
    const fullPath = this.getFullPath(stripLeadingSlash(key));
    return this.findFidByPath(fullPath);
  }

  async getObject(
    key: string,
    options?: { range?: string },
  ): Promise<Response> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) {
      return new Response('Not Found', { status: 404 });
    }

    const result = await this.request(
      '/1/clouddrive/file/download',
      'POST',
      undefined,
      JSON.stringify({ fids: [fid] }),
    );
    const downloadInfo =
      result?.data?.info?.urls?.[0] || result?.data?.info?.url;
    if (!downloadInfo) {
      throw new Error('Quark download url missing');
    }

    const downloadUrl = downloadInfo.url || downloadInfo;
    return fetch(downloadUrl, {
      headers: {
        Referer: API_BASE,
        ...(options?.range ? { Range: options.range } : {}),
      },
    });
  }

  async getSignedUrl(key: string, _expiresIn: number = 3600): Promise<string> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) {
      throw new Error('Not Found');
    }
    const result = await this.request(
      '/1/clouddrive/file/download',
      'POST',
      undefined,
      JSON.stringify({ fids: [fid] }),
    );
    const downloadInfo =
      result?.data?.info?.urls?.[0] || result?.data?.info?.url;
    return downloadInfo?.url || downloadInfo || '';
  }

  async headObject(key: string): Promise<{
    contentLength: number;
    contentType: string;
    lastModified: string;
  } | null> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) return null;
    const result = await this.request('/1/clouddrive/file/detail', 'GET', {
      fid: String(fid),
    });
    const file = result?.data?.files?.[0] || result?.data;
    if (!file) return null;
    return {
      contentLength: file.size || 0,
      contentType: getMimeType(key),
      lastModified: file.modified_time
        ? new Date(file.modified_time * 1000).toISOString()
        : new Date().toISOString(),
    };
  }

  async putObject(
    key: string,
    body: ArrayBuffer | string,
    _contentType?: string,
  ): Promise<void> {
    const targetPath = this.getFullPath(key);
    const parentPath = targetPath.split('/').slice(0, -1).join('/');
    const parentId = await this.findFidByPath(parentPath || '');
    if (parentId < 0) {
      throw new Error('Quark: parent folder not found');
    }
    const fileName = targetPath.split('/').pop() || '';
    if (!fileName) {
      throw new Error('Quark: invalid file path');
    }

    const buffer =
      body instanceof ArrayBuffer || body instanceof Uint8Array
        ? body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : body
        : new TextEncoder().encode(body);
    const fileSize = buffer.length;

    const md5 = md5Hex(buffer.buffer);
    const sha1 = await sha1Hex(buffer.buffer);
    const formatType = fileName.includes('.')
      ? fileName.split('.').pop()?.toLowerCase() || 'bin'
      : 'bin';

    // Step 1: Prepare upload via correct endpoint
    console.log('[Quark] Preparing upload:', {
      parentId,
      fileName,
      fileSize,
      formatType,
      md5,
      sha1,
    });

    const prepareRes: Record<string, any> = await this.request(
      '/1/clouddrive/file/upload/pre',
      'POST',
      undefined,
      JSON.stringify({
        pdir_fid: parentId,
        file_name: fileName,
        size: fileSize,
        format_type: formatType,
        md5: md5,
        sha1: sha1,
      }),
    );

    console.log('[Quark] Upload prepare response:', {
      hasData: !!prepareRes.data,
      hasCode: !!prepareRes.code,
      code: prepareRes.code,
      message: prepareRes.message,
      dataKeys: prepareRes.data ? Object.keys(prepareRes.data) : [],
    });

    const data = prepareRes.data || prepareRes;

    // 尝试多种可能的字段名
    const taskId =
      data.task_id ||
      data.upload_id ||
      data.session_id ||
      data.upload_session_id ||
      data.id;

    const objKey =
      data.obj_key || data.object_key || data.key || data.file_key || '';

    // 尝试获取 upload_url，可能是嵌套对象或字符串
    let uploadUrl = data.upload_url || data.presign_url || data.url;
    if (!uploadUrl && data.upload_info) {
      uploadUrl =
        data.upload_info.url ||
        data.upload_info.upload_url ||
        data.upload_info.presign_url;
    }

    if (!taskId) {
      console.error(
        '[Quark] Full prepare response:',
        JSON.stringify(prepareRes, null, 2),
      );
      throw new Error(
        'Quark: failed to prepare upload, no task_id in response',
      );
    }

    console.log('[Quark] Extracted:', {
      taskId,
      objKey,
      uploadUrl: !!uploadUrl,
    });

    // Step 2: Update hash if obj_key is provided
    if (objKey) {
      try {
        await this.request(
          '/1/clouddrive/file/update/hash',
          'POST',
          undefined,
          JSON.stringify({
            task_id: taskId,
            md5: md5,
            sha1: sha1,
          }),
        );
      } catch (err) {
        // Hash update is optional, continue if it fails
        console.warn('Hash update failed:', err);
      }
    }

    // Step 3: Upload data to OSS (use uploadUrl extracted earlier)
    if (uploadUrl) {
      try {
        console.log(
          '[Quark] Uploading to OSS URL:',
          uploadUrl.substring(0, 50) + '...',
        );
        await this.uploadToOSS(uploadUrl, buffer);
        console.log('[Quark] OSS upload completed successfully');
      } catch (err) {
        console.error('[Quark] OSS upload failed, cannot complete file:', err);
        throw new Error(
          `Quark OSS upload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      console.warn(
        'No upload URL in prepare response, attempting to finish anyway',
      );
    }

    // Step 4: Finish upload (only if data was uploaded or no upload URL was needed)
    console.log('[Quark] Completing file upload...');
    await this.request(
      '/1/clouddrive/file/upload/finish',
      'POST',
      undefined,
      JSON.stringify({
        task_id: taskId,
        obj_key: objKey,
        size: fileSize,
      }),
    );
    console.log('[Quark] File upload completed successfully');
  }

  private async uploadToOSS(
    uploadUrl: string,
    buffer: Uint8Array,
    retryCount: number = 0,
  ): Promise<void> {
    // For OSS uploads, we should NOT include Cookie header
    // as the presigned URL is self-contained
    console.log(
      `[Quark] Uploading ${buffer.length} bytes to OSS (attempt ${retryCount + 1})`,
    );
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buffer.length),
      },
      body: buffer,
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `[Quark] OSS upload failed: ${res.status} ${text.substring(0, 200)}`,
      );

      // Handle specific OSS errors that might be transient
      // Error code 1016 is a temporary OSS service issue
      if (
        (res.status === 530 && text.includes('error code: 1016')) ||
        res.status >= 500
      ) {
        const maxRetries = 5;
        if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s, 8s, 16s
          console.warn(
            `[Quark] OSS upload failed (attempt ${retryCount + 1}/${maxRetries}), retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.uploadToOSS(uploadUrl, buffer, retryCount + 1);
        }
      }
      throw new Error(
        `Quark OSS upload error: ${res.status} ${text.substring(0, 200)}`,
      );
    }

    console.log('[Quark] OSS upload completed successfully');
  }

  // 夸克私有分片协议，与标准 multipart 接口无关
  private async uploadChunk(
    uploadId: string,
    partNumber: number,
    chunk: Uint8Array,
  ): Promise<void> {
    const url = new URL(`${API_BASE}/1/clouddrive/file/upload_part`);
    url.searchParams.set('upload_id', uploadId);
    url.searchParams.set('part_number', String(partNumber));
    url.searchParams.set('pr', 'ucpro');
    url.searchParams.set('fr', 'pc');

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/octet-stream',
      },
      body: chunk,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Quark upload part error: ${res.status} ${text.substring(0, 200)}`,
      );
    }

    const data: Record<string, any> = await res.json();
    if (data.code && data.code !== '0') {
      throw new Error(
        `Quark upload part error: ${data.code} ${data.message || ''}`,
      );
    }
  }

  async deleteObject(key: string): Promise<void> {
    const fid = await this.getFidByKey(key);
    if (fid < 0) return;
    await this.request(
      '/1/clouddrive/file/delete',
      'POST',
      undefined,
      JSON.stringify({
        action_type: 2,
        filelist: [fid],
        exclude_fids: [],
      }),
    );
  }

  async createFolder(folderPath: string): Promise<void> {
    const parent = this.getFullPath(stripTrailingSlash(folderPath));
    const dirParts = stripLeadingSlash(parent).split('/').filter(Boolean);
    const name = dirParts.pop() || '';
    if (!name) return;
    const parentPath = dirParts.join('/');
    const parentId = await this.findFidByPath(parentPath);
    if (parentId < 0) {
      throw new Error('Quark: parent folder not found');
    }
    await this.request(
      '/1/clouddrive/file',
      'POST',
      undefined,
      JSON.stringify({
        pdir_fid: parentId,
        file_name: name,
        dir_path: `/${parentPath}/${name}`.replace(/\/+/g, '/'),
        size: 0,
        format_type: 'application/octet-stream',
        lcreated_at: Date.now(),
      }),
    );
  }

  private async moveFid(
    sourceFid: number,
    destParentPath: string,
  ): Promise<void> {
    const parentId = await this.findFidByPath(destParentPath);
    if (parentId < 0) {
      throw new Error('Quark: destination parent folder not found');
    }
    await this.request(
      '/1/clouddrive/file/move',
      'POST',
      undefined,
      JSON.stringify({
        action_type: 1,
        filelist: [sourceFid],
        to_pdir_fid: parentId,
        exclude_fids: [],
      }),
    );
  }

  async copyObject(_sourceKey: string, _destKey: string): Promise<void> {
    throw new Error(
      'Quark: copy is not supported via private API, use move instead',
    );
  }

  async renameObject(path: string, newName: string): Promise<void> {
    const fid = await this.getFidByKey(path);
    if (fid < 0) {
      throw new Error('Quark: file not found');
    }
    await this.request(
      '/1/clouddrive/file/update/name',
      'POST',
      undefined,
      JSON.stringify({ fid, file_name: newName }),
    );
  }

  async moveObject(path: string, newPath: string): Promise<void> {
    const fid = await this.getFidByKey(path);
    if (fid < 0) {
      throw new Error('Quark: source file not found');
    }
    const destParent = this.getFullPath(
      stripTrailingSlash(newPath).replace(/\/[^/]*$/, ''),
    );
    await this.moveFid(fid, destParent);
  }

  // Multipart upload：直接抛错，引导使用站内代理
  async initiateMultipartUpload(
    _key: string,
    _contentType: string,
    _options?: { size?: number; chunkSize?: number },
  ): Promise<string> {
    // 夸克网盘无标准 multipart API，需通过站内代理或分片上传
    throw new Error(
      'Quark multipart upload not supported via direct API, use proxy upload',
    );
  }
  async uploadPart(
    _key: string,
    _uploadId: string,
    _partNumber: number,
    _body: ReadableStream | ArrayBuffer,
    _contentLength?: number,
  ): Promise<string> {
    throw new Error(
      'Quark multipart upload not supported via direct API, use proxy upload',
    );
  }
  async completeMultipartUpload(
    _key: string,
    _uploadId: string,
    _parts: { partNumber: number; etag: string }[],
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
    _expiresIn: number = 3600,
  ): Promise<string> {
    return '';
  }
}
