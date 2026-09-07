// 本地最小 Mock S3（path-style，不校验 SigV4 签名），用于联调验证上传/下载/批量删除
// 运行: node scripts/mock-s3.mjs [port]   默认 9000
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || 9000);

const objects = new Map(); // `${bucket}/${key}` -> { data, contentType, lastModified }
const multiparts = new Map(); // uploadId -> { key, parts: Map<partNumber, Buffer> }
let uploadIdSeq = 1;

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,ETag,x-amz-copy-source,Content-Length");
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function parseUrl(req) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const segments = u.pathname.split("/").filter(Boolean);
  const bucket = segments.shift() || "";
  const key = decodeURIComponent(segments.join("/"));
  return { u, bucket, key };
}

function listXml(bucket, prefix, delimiter, maxKeys) {
  const items = [];
  const commonPrefixes = new Set();
  let count = 0;

  for (const [fullKey, obj] of objects) {
    const [b, ...rest] = fullKey.split("/");
    if (b !== bucket) continue;
    let key = rest.join("/");
    if (!key.startsWith(prefix)) continue;

    let displayKey = key;
    if (delimiter && key.slice(prefix.length).includes(delimiter)) {
      const rest2 = key.slice(prefix.length);
      const common = prefix + rest2.slice(0, rest2.indexOf(delimiter) + 1);
      if (common !== prefix) {
        commonPrefixes.add(common);
        continue;
      }
    }

    if (displayKey === prefix) continue; // 不含当前目录自身
    if (count >= maxKeys) continue;
    count++;
    items.push(
      `<Contents><Key>${esc(displayKey)}</Key><LastModified>${obj.lastModified}</LastModified>` +
        `<ETag>&quot;mock-etag-${key.length}&quot;</ETag><Size>${obj.data.length}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`
    );
  }

  const commonXml = [...commonPrefixes]
    .sort()
    .map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`)
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix>` +
    `<KeyCount>${count}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>false</IsTruncated>` +
    items.join("") + commonXml + `</ListBucketResult>`
  );
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return send(res, 204, "");

  const { u, bucket, key } = parseUrl(req);
  const params = u.searchParams;
  const storeKey = `${bucket}/${key}`;

  // 列表
  if (req.method === "GET" && params.get("list-type") === "2") {
    const prefix = params.get("prefix") || "";
    const delimiter = params.get("delimiter") || "";
    const maxKeys = Number(params.get("max-keys") || 1000);
    return send(res, 200, listXml(bucket, prefix, delimiter, maxKeys), {
      "Content-Type": "application/xml",
    });
  }

  // 初始化分片上传
  if (req.method === "POST" && params.get("uploads") === "") {
    const uploadId = `mock-upload-${uploadIdSeq++}`;
    multiparts.set(uploadId, { key, parts: new Map() });
    return send(
      res,
      200,
      `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      { "Content-Type": "application/xml" }
    );
  }

  // 上传分片（带签名参数或代理上传）
  if (req.method === "PUT" && params.get("partNumber") && params.get("uploadId")) {
    const mp = multiparts.get(params.get("uploadId"));
    if (!mp) return send(res, 404, "<?xml version=\"1.0\"?><Error><Code>NoSuchUpload</Code></Error>");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    mp.parts.set(Number(params.get("partNumber")), Buffer.concat(chunks));
    const etag = `"mock-part-${params.get("partNumber")}"`;
    return send(res, 200, "", { ETag: etag });
  }

  // 完成分片上传
  if (req.method === "POST" && params.get("uploadId")) {
    const mp = multiparts.get(params.get("uploadId"));
    if (!mp) return send(res, 404, "");
    const data = Buffer.concat([...mp.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf));
    objects.set(`${bucket}/${mp.key}`, {
      data,
      contentType: "application/octet-stream",
      lastModified: new Date().toISOString(),
    });
    multiparts.delete(params.get("uploadId"));
    return send(
      res,
      200,
      `<?xml version="1.0"?><CompleteMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(mp.key)}</Key><ETag>&quot;mock-complete&quot;</ETag></CompleteMultipartUploadResult>`,
      { "Content-Type": "application/xml" }
    );
  }

  // 中止分片上传
  if (req.method === "DELETE" && params.get("uploadId")) {
    multiparts.delete(params.get("uploadId"));
    return send(res, 204, "");
  }

  // 简单上传 / 复制
  if (req.method === "PUT") {
    const copySource = req.headers["x-amz-copy-source"];
    if (copySource) {
      const srcKey = decodeURIComponent(copySource).replace(/^\/[^/]+\//, "");
      const src = objects.get(`${bucket}/${srcKey}`);
      if (!src) return send(res, 404, "");
      objects.set(storeKey, { ...src, lastModified: new Date().toISOString() });
      return send(res, 200, `<?xml version="1.0"?><CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified><ETag>&quot;mock-copy&quot;</ETag></CopyObjectResult>`);
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    if (data.length === 0 && !objects.has(storeKey)) {
      // 空对象也允许（目录占位对象）
    }
    objects.set(storeKey, {
      data,
      contentType: req.headers["content-type"] || "application/octet-stream",
      lastModified: new Date().toISOString(),
    });
    return send(res, 200, "", { ETag: `"mock-put"` });
  }

  // 删除对象
  if (req.method === "DELETE") {
    if (key) objects.delete(storeKey);
    return send(res, 204, "");
  }

  // 下载 / 预览
  if (req.method === "GET" || req.method === "HEAD") {
    const obj = objects.get(storeKey);
    if (!obj) return send(res, 404, "");
    const head = {
      "Content-Type": obj.contentType,
      "Content-Length": obj.data.length,
      "Last-Modified": obj.lastModified,
      ETag: `"mock-get"`,
    };
    if (req.method === "HEAD") return send(res, 200, "", head);
    return send(res, 200, obj.data, head);
  }

  return send(res, 200, "{}");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock S3 listening on http://127.0.0.1:${PORT}`);
});
