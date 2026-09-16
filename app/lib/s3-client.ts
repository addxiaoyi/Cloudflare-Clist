export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  basePath?: string;
  usePathStyle?: boolean;
  signatureVersion?: 'v2' | 'v4';
  // STS temporary credentials (e.g. Qiniu get_federation_token) require x-amz-security-token
  sessionToken?: string;
}

export interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  etag?: string;
}

export interface ListObjectsResult {
  objects: S3Object[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

async function hmacSha256(
  key: ArrayBuffer,
  message: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(message),
  );
}

async function hmacSha1(
  keyString: string,
  message: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyString),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(message),
  );
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// SigV2 signs with HMAC-SHA1 and emits a base64 (not hex) signature.
async function hmacSha1Base64(
  secret: string,
  message: string,
): Promise<string> {
  return toBase64(await hmacSha1(secret, message));
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// AWS SigV4 URI encoding is stricter than encodeURIComponent: ! ' ( ) *
// must also be percent-encoded in canonical URI/query strings.
function encodeAwsUriComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildCanonicalQueryString(
  queryParams: Record<string, string>,
): string {
  return Object.keys(queryParams)
    .sort()
    .map(
      (key) =>
        `${encodeAwsUriComponent(key)}=${encodeAwsUriComponent(queryParams[key])}`,
    )
    .join('&');
}

// S3 URI encoding - encode each path segment (same for signature and URL)
function encodeS3Path(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeAwsUriComponent(segment))
    .join('/');
}

async function getSignatureKey(
  key: string,
  dateStamp: string,
  regionName: string,
  serviceName: string,
): Promise<ArrayBuffer> {
  const keyData = new TextEncoder().encode('AWS4' + key);
  const kDate = await hmacSha256(keyData.buffer as ArrayBuffer, dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return hmacSha256(kService, 'aws4_request');
}

export class S3Client {
  private config: S3Config;
  private hostStyle: 'path' | 'vhost';
  private signatureVersion: 'v2' | 'v4';
  
  private signingKeyCache: Map<string, { key: ArrayBuffer; date: string }> = new Map();

  private static readonly SIGV2_SUBRESOURCES = new Set([
    'acl',
    'lifecycle',
    'location',
    'logging',
    'notification',
    'partNumber',
    'policy',
    'requestPayment',
    'torrent',
    'uploadId',
    'uploads',
    'versionId',
    'versioning',
    'versions',
    'website',
    'delete',
    'cors',
    'replicate',
    'replication',
    'tagging',
  ]);

  constructor(config: S3Config) {
    const raw = config.endpoint?.trim() || '';
    if (!raw) {
      throw new Error('Endpoint 未配置，请编辑存储后填写服务器地址');
    }
    // 用户常漏掉协议头，补上 https:// 避免 new URL() 抛 "Invalid URL string"
    const endpoint = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    this.config = { ...config, endpoint };
    this.hostStyle = config.usePathStyle === false ? 'vhost' : 'path';
    this.signatureVersion = config.signatureVersion || 'v4';
  }

  private getBaseHost(url: URL): string {
    if (this.hostStyle === 'vhost') {
      return `${this.config.bucket}.${url.host}`;
    }
    return url.host;
  }

  private getRequestUrl(objectPath: string): string {
    const url = new URL(this.config.endpoint);
    if (this.hostStyle === 'vhost') {
      return `${url.protocol}//${this.getBaseHost(url)}${objectPath}`;
    }
    return `${url.protocol}//${url.host}${objectPath}`;
  }

  private getFullPath(path: string): string {
    const basePath = this.config.basePath?.replace(/^\/|\/$/g, '') || '';
    const cleanPath = path.replace(/^\//, '');
    return basePath ? `${basePath}/${cleanPath}` : cleanPath;
  }

  // Canonical/URL path for an object key, consistent with the host header we sign.
  // path-style: /bucket/key  |  vhost-style: /key (bucket lives in the host, not the path)
  private objectPath(fullKey: string): string {
    const key = fullKey.startsWith('/') ? fullKey : `/${fullKey}`;
    return this.hostStyle === 'path' ? `/${this.config.bucket}${key}` : key;
  }

  // Absolute request URL matching objectPath + the signed host.
  private objectUrl(fullKey: string): string {
    const url = new URL(this.config.endpoint);
    return `${url.protocol}//${this.getBaseHost(url)}${encodeS3Path(this.objectPath(fullKey))}`;
  }

  // Sign request with AWS Signature Version 2
  // String to sign: VERB + "\nContent-MD5\nContent-Type\nDate\nCanonicalizedAmzHeaders + CanonicalizedResource"
  // Only Date (GMT), Content-Type, Content-MD5 and x-amz-* headers are signed.
  // The signature is a base64-encoded HMAC-SHA1 of the string to sign.
  private async signRequestV2(
    method: string,
    path: string,
    queryParams: Record<string, string> = {},
    headers: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const now = new Date();
    const dateGMT = now.toUTCString();

    // Build canonical resource: callers pass the already-bucket-prefixed path
    // (path-style: /bucket/key, vhost-style: /key), same as the signed request path
    let canonicalResource = path;

    // Only SigV2 subresources (uploadId, partNumber, ...) belong in the canonical resource;
    // ordinary query params (prefix, delimiter, list-type...) must NOT be signed
    const subParams = Object.entries(queryParams)
      .filter(([key]) => S3Client.SIGV2_SUBRESOURCES.has(key))
      .sort(([a], [b]) => a.localeCompare(b));
    if (subParams.length > 0) {
      canonicalResource +=
        '?' +
        subParams
          .map(([key, value]) => (value === '' ? key : `${key}=${value}`))
          .join('&');
    }

    // Extract x-amz-* headers for canonicalization
    const amzHeaders: Record<string, string> = {};
    const otherHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase().startsWith('x-amz-')) {
        amzHeaders[key.toLowerCase()] = value.trim();
      } else {
        otherHeaders[key] = value;
      }
    }

    // Canonicalized x-amz-* headers: sorted alphabetically
    const sortedAmzKeys = Object.keys(amzHeaders).sort();
    const canonicalAmzHeaders = sortedAmzKeys
      .map((k) => `${k}:${amzHeaders[k]}`)
      .join('\n');

    // String to sign format for SigV2
    // Note: Content-MD5 is typically empty unless explicitly set
    const stringToSign = [
      method,
      '', // Content-MD5 (usually empty)
      otherHeaders['Content-Type'] || '',
      dateGMT,
      canonicalAmzHeaders
        ? canonicalAmzHeaders + '\n' + canonicalResource
        : canonicalResource,
    ].join('\n');

    const signature = await hmacSha1Base64(
      this.config.secretAccessKey,
      stringToSign,
    );

    const signedHeaders: Record<string, string> = {
      Date: dateGMT,
      Authorization: `AWS ${this.config.accessKeyId}:${signature}`,
      ...otherHeaders,
      ...amzHeaders,
    };

    return signedHeaders;
  }

  // Unified signRequest that forwards to SigV4 or SigV2 based on config
  private async signRequest(
    method: string,
    path: string,
    queryParams: Record<string, string> = {},
    headers: Record<string, string> = {},
    payload: string = '',
    useUnsignedPayload: boolean = false,
  ): Promise<Record<string, string>> {
    // Temporary credentials must carry x-amz-security-token in the signed headers
    const headersWithToken = this.config.sessionToken
      ? { ...headers, 'x-amz-security-token': this.config.sessionToken }
      : headers;
    if (this.signatureVersion === 'v2') {
      return this.signRequestV2(method, path, queryParams, headersWithToken);
    }
    return this.signRequestV4(
      method,
      path,
      queryParams,
      headersWithToken,
      payload,
      useUnsignedPayload,
    );
  }

  private async signRequestV4(
    method: string,
    path: string,
    queryParams: Record<string, string> = {},
    headers: Record<string, string> = {},
    payload: string = '',
    useUnsignedPayload: boolean = false,
  ): Promise<Record<string, string>> {
    const url = new URL(this.config.endpoint);
    const host = this.getBaseHost(url);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = useUnsignedPayload
      ? 'UNSIGNED-PAYLOAD'
      : await sha256(payload);

    const headersToSign: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...headers,
    };

    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((key) => `${key.toLowerCase()}:${headersToSign[key].trim()}`)
      .join('\n');
    const signedHeadersStr = sortedHeaderKeys
      .map((k) => k.toLowerCase())
      .join(';');

    const canonicalQueryString = buildCanonicalQueryString(queryParams);

    const rawCanonicalUri = path.startsWith('/') ? path : '/' + path;
    const canonicalUri = encodeS3Path(rawCanonicalUri);
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders + '\n',
      signedHeadersStr,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256(canonicalRequest),
    ].join('\n');

    const cacheKey = `${this.config.secretAccessKey}:${dateStamp}:${this.config.region}`;
    let signingKey = this.signingKeyCache.get(cacheKey)?.key;
    if (!signingKey || this.signingKeyCache.get(cacheKey)?.date !== dateStamp) {
      signingKey = await getSignatureKey(
        this.config.secretAccessKey,
        dateStamp,
        this.config.region,
        's3',
      );
      this.signingKeyCache.set(cacheKey, { key: signingKey, date: dateStamp });
    }
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    return {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...headers,
      Authorization: authorization,
    };
  }

  async listObjects(
    prefix: string = '',
    delimiter: string = '/',
    maxKeys: number = 1000,
    continuationToken?: string,
  ): Promise<ListObjectsResult> {
    let normalizedPrefix = prefix;
    if (normalizedPrefix && !normalizedPrefix.endsWith('/')) {
      normalizedPrefix = normalizedPrefix + '/';
    }

    const fullPrefix = this.getFullPath(normalizedPrefix);

    const queryParams: Record<string, string> = {
      'list-type': '2',
      prefix: fullPrefix,
      delimiter,
      'max-keys': maxKeys.toString(),
    };

    if (continuationToken) {
      queryParams['continuation-token'] = continuationToken;
    }

    const path =
      this.hostStyle === 'vhost' ? `/${fullPrefix}` : `/${this.config.bucket}`;

    const headers = await this.signRequest('GET', path, queryParams);

    const queryString = buildCanonicalQueryString(queryParams);

    const url = this.getRequestUrl(path.startsWith('/') ? path : '/' + path);
    const response = await fetch(`${url}?${queryString}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`S3 ListObjects failed: ${response.status} ${text}`);
    }

    const xml = await response.text();
    return this.parseListObjectsResponse(xml, fullPrefix);
  }

  private parseListObjectsResponse(
    xml: string,
    fullPrefix: string,
  ): ListObjectsResult {
    const objects: S3Object[] = [];
    const prefixes: string[] = [];
    const basePath = this.config.basePath?.replace(/^\/|\/$/g, '') || '';

    // Decode XML entities
    const decodeXml = (str: string) =>
      str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

    const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    const prefixRegex =
      /<CommonPrefixes>[\s\S]*?<Prefix>(.*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;

    let match;
    while ((match = contentsRegex.exec(xml)) !== null) {
      const content = match[1];
      const key = decodeXml(content.match(/<Key>(.*?)<\/Key>/)?.[1] || '');
      const size = parseInt(
        content.match(/<Size>(.*?)<\/Size>/)?.[1] || '0',
        10,
      );
      const lastModified =
        content.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] || '';
      const etag = content.match(/<ETag>"?(.*?)"?<\/ETag>/)?.[1] || '';

      // Remove basePath prefix to get display key
      const displayKey =
        basePath && key.startsWith(basePath + '/')
          ? key.slice(basePath.length + 1)
          : key;

      // Remove the current folder prefix to get just the name
      const relativePrefix =
        basePath && fullPrefix.startsWith(basePath + '/')
          ? fullPrefix.slice(basePath.length + 1)
          : fullPrefix;

      const name = displayKey.startsWith(relativePrefix)
        ? displayKey.slice(relativePrefix.length)
        : displayKey;

      if (name && !name.endsWith('/')) {
        objects.push({
          key: displayKey,
          name,
          size,
          lastModified,
          isDirectory: false,
          etag,
        });
      }
    }

    while ((match = prefixRegex.exec(xml)) !== null) {
      const p = decodeXml(match[1]);

      // Remove basePath prefix to get display prefix
      const displayPrefix =
        basePath && p.startsWith(basePath + '/')
          ? p.slice(basePath.length + 1)
          : p;

      // Remove the current folder prefix to get just the name
      const relativePrefix =
        basePath && fullPrefix.startsWith(basePath + '/')
          ? fullPrefix.slice(basePath.length + 1)
          : fullPrefix;

      const name = displayPrefix.startsWith(relativePrefix)
        ? displayPrefix.slice(relativePrefix.length).replace(/\/$/, '')
        : displayPrefix.replace(/\/$/, '');

      if (name) {
        prefixes.push(displayPrefix);
        objects.push({
          key: displayPrefix,
          name,
          size: 0,
          lastModified: '',
          isDirectory: true,
        });
      }
    }

    const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
    const nextToken = xml.match(
      /<NextContinuationToken>(.*?)<\/NextContinuationToken>/,
    )?.[1];

    return {
      objects: objects.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      }),
      prefixes,
      isTruncated,
      nextContinuationToken: nextToken,
    };
  }

  async getObject(
    key: string,
    options?: { range?: string },
  ): Promise<Response> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);
    const signHeaders: Record<string, string> = {};
    if (options?.range) {
      signHeaders.Range = options.range;
    }
    const headers = await this.signRequest('GET', path, {}, signHeaders);

    const fetchHeaders = new Headers(headers);
    if (options?.range) {
      fetchHeaders.set('Range', options.range);
    }

    const response = await fetch(this.objectUrl(fullKey), {
      method: 'GET',
      headers: fetchHeaders,
    });

    if (!response.ok) {
      throw new Error(`S3 GetObject failed: ${response.status}`);
    }

    return response;
  }

  // Build a SigV2 presigned (query-string authenticated) URL.
  // StringToSign: VERB\nContent-MD5\nContent-Type\nExpires\nCanonicalizedResource
  private async presignUrlV2(
    method: string,
    path: string,
    subresources: Record<string, string>,
    expiresIn: number,
  ): Promise<string> {
    const url = new URL(this.config.endpoint);
    const host = this.getBaseHost(url);
    const encodedPath = encodeS3Path(path);

    // Canonicalized resource includes only the subresource params (not AWSAccessKeyId etc.)
    const subKeys = Object.keys(subresources).sort();
    const subParts = subKeys.map((k) =>
      subresources[k] === '' ? k : `${k}=${subresources[k]}`,
    );
    const resource =
      subParts.length > 0 ? `${path}?${subParts.join('&')}` : path;

    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const stringToSign = [method, '', '', expires.toString(), resource].join(
      '\n',
    );
    const signature = await hmacSha1Base64(
      this.config.secretAccessKey,
      stringToSign,
    );

    const params = new URLSearchParams({
      AWSAccessKeyId: this.config.accessKeyId,
      Expires: expires.toString(),
      Signature: signature,
    });
    for (const k of subKeys) params.set(k, subresources[k]);
    // SigV2 query auth carries the STS token as an unsigned security-token param
    if (this.config.sessionToken)
      params.set('security-token', this.config.sessionToken);

    return `${url.protocol}//${host}${encodedPath}?${params.toString()}`;
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);
    if (this.signatureVersion === 'v2') {
      return this.presignUrlV2('GET', path, {}, expiresIn);
    }
    const encodedPath = encodeS3Path(path);
    const url = new URL(this.config.endpoint);
    const host = this.getBaseHost(url);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': expiresIn.toString(),
      'X-Amz-SignedHeaders': 'host',
    };
    // X-Amz-Security-Token joins the canonical query string, so it is covered by the signature
    if (this.config.sessionToken) {
      queryParams['X-Amz-Security-Token'] = this.config.sessionToken;
    }

    const canonicalQueryString = buildCanonicalQueryString(queryParams);

    const canonicalRequest = [
      'GET',
      encodedPath,
      canonicalQueryString,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256(canonicalRequest),
    ].join('\n');

    const cacheKey = `${this.config.secretAccessKey}:${dateStamp}:${this.config.region}`;
    let signingKey = this.signingKeyCache.get(cacheKey)?.key;
    if (!signingKey || this.signingKeyCache.get(cacheKey)?.date !== dateStamp) {
      signingKey = await getSignatureKey(
        this.config.secretAccessKey,
        dateStamp,
        this.config.region,
        's3',
      );
      this.signingKeyCache.set(cacheKey, { key: signingKey, date: dateStamp });
    }
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    return `${url.protocol}//${host}${encodedPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  }

  async getSignedUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number = 3600,
  ): Promise<string> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);
    if (this.signatureVersion === 'v2') {
      return this.presignUrlV2(
        'PUT',
        path,
        { partNumber: partNumber.toString(), uploadId },
        expiresIn,
      );
    }
    const encodedPath = encodeS3Path(path);
    const url = new URL(this.config.endpoint);
    const host = this.getBaseHost(url);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': expiresIn.toString(),
      'X-Amz-SignedHeaders': 'host',
      partNumber: partNumber.toString(),
      uploadId: uploadId,
    };
    if (this.config.sessionToken) {
      queryParams['X-Amz-Security-Token'] = this.config.sessionToken;
    }

    const canonicalQueryString = buildCanonicalQueryString(queryParams);

    const canonicalRequest = [
      'PUT',
      encodedPath,
      canonicalQueryString,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256(canonicalRequest),
    ].join('\n');

    const cacheKey = `${this.config.secretAccessKey}:${dateStamp}:${this.config.region}`;
    let signingKey = this.signingKeyCache.get(cacheKey)?.key;
    if (!signingKey || this.signingKeyCache.get(cacheKey)?.date !== dateStamp) {
      signingKey = await getSignatureKey(
        this.config.secretAccessKey,
        dateStamp,
        this.config.region,
        's3',
      );
      this.signingKeyCache.set(cacheKey, { key: signingKey, date: dateStamp });
    }
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    return `${url.protocol}//${host}${encodedPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  }

  async putObject(
    key: string,
    body: ArrayBuffer | string,
    contentType?: string,
  ): Promise<void> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);

    let bodyData: ArrayBuffer;
    if (typeof body === 'string') {
      bodyData = new TextEncoder().encode(body).buffer as ArrayBuffer;
    } else {
      bodyData = body;
    }

    // Use UNSIGNED-PAYLOAD for binary uploads
    const headers = await this.signRequest('PUT', path, {}, {}, '', true);

    const response = await fetch(this.objectUrl(fullKey), {
      method: 'PUT',
      headers: {
        ...headers,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: bodyData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`S3 PutObject failed: ${response.status} ${text}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);
    const headers = await this.signRequest('DELETE', path);

    const response = await fetch(this.objectUrl(fullKey), {
      method: 'DELETE',
      headers,
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`S3 DeleteObject failed: ${response.status} ${text}`);
    }
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const fullSourceKey = this.getFullPath(sourceKey);
    const fullDestKey = this.getFullPath(destKey);
    const path = this.objectPath(fullDestKey);

    // x-amz-copy-source is always bucket/key regardless of host style, URL encoded
    const copySource = `/${this.config.bucket}/${fullSourceKey}`
      .split('/')
      .map((segment) => encodeAwsUriComponent(segment))
      .join('/');

    const headers = await this.signRequest(
      'PUT',
      path,
      {},
      {
        'x-amz-copy-source': copySource,
      },
    );

    const response = await fetch(this.objectUrl(fullDestKey), {
      method: 'PUT',
      headers: {
        ...headers,
        'x-amz-copy-source': copySource,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`S3 CopyObject failed: ${response.status} ${text}`);
    }
  }

  async createFolder(folderPath: string): Promise<void> {
    // S3 folders are represented by empty objects with trailing slash
    const normalizedPath = folderPath.endsWith('/')
      ? folderPath
      : folderPath + '/';
    await this.putObject(normalizedPath, '', 'application/x-directory');
  }

  async headObject(key: string): Promise<{
    contentLength: number;
    contentType: string;
    lastModified: string;
  } | null> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);
    const headers = await this.signRequest('HEAD', path);

    const response = await fetch(this.objectUrl(fullKey), {
      method: 'HEAD',
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`S3 HeadObject failed: ${response.status}`);
    }

    return {
      contentLength: parseInt(
        response.headers.get('content-length') || '0',
        10,
      ),
      contentType:
        response.headers.get('content-type') || 'application/octet-stream',
      lastModified: response.headers.get('last-modified') || '',
    };
  }

  async initiateMultipartUpload(
    key: string,
    contentType: string,
    _options?: { size?: number; chunkSize?: number },
  ): Promise<string> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);

    const headers = await this.signRequest(
      'POST',
      path,
      { uploads: '' },
      {
        'Content-Type': contentType,
      },
    );

    const queryString = buildCanonicalQueryString({ uploads: '' });
    const response = await fetch(this.objectUrl(fullKey) + `?${queryString}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': contentType,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `S3 InitiateMultipartUpload failed: ${response.status} ${text}`,
      );
    }

    const xml = await response.text();
    const uploadIdMatch = xml.match(/<UploadId>(.*?)<\/UploadId>/);
    if (!uploadIdMatch) {
      throw new Error('Failed to parse UploadId from response');
    }

    return uploadIdMatch[1];
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream | ArrayBuffer,
    contentLength?: number,
  ): Promise<string> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);

    // Query params must be sorted alphabetically for signature
    const queryParams: Record<string, string> = {
      partNumber: partNumber.toString(),
      uploadId: uploadId,
    };

    const headers = await this.signRequest(
      'PUT',
      path,
      queryParams,
      {},
      '',
      true,
    );

    // Build query string in same sorted order as signature
    const queryString = buildCanonicalQueryString(queryParams);

    const fetchHeaders: Record<string, string> = { ...headers };
    if (contentLength !== undefined) {
      fetchHeaders['Content-Length'] = contentLength.toString();
    }

    const response = await fetch(`${this.objectUrl(fullKey)}?${queryString}`, {
      method: 'PUT',
      headers: fetchHeaders,
      body,
      // @ts-expect-error - duplex is required for streaming body
      duplex: 'half',
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`S3 UploadPart failed: ${response.status} ${text}`);
    }

    const etag = response.headers.get('ETag');
    if (!etag) {
      throw new Error('No ETag returned from UploadPart');
    }

    return etag.replace(/"/g, '');
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);
    const queryParams: Record<string, string> = { uploadId };

    const partsXml = parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`,
      )
      .join('');
    const body = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

    const headers = await this.signRequest(
      'POST',
      path,
      queryParams,
      {
        'Content-Type': 'application/xml',
      },
      body,
    );

    // Build query string in same sorted order as signature
    const queryString = buildCanonicalQueryString(queryParams);

    const response = await fetch(`${this.objectUrl(fullKey)}?${queryString}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/xml',
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `S3 CompleteMultipartUpload failed: ${response.status} ${text}`,
      );
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const fullKey = this.getFullPath(key);
    const path = this.objectPath(fullKey);
    const queryString = buildCanonicalQueryString({ uploadId });

    const headers = await this.signRequest('DELETE', path, { uploadId });

    const response = await fetch(`${this.objectUrl(fullKey)}?${queryString}`, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(
        `S3 AbortMultipartUpload failed: ${response.status} ${text}`,
      );
    }
  }
}
