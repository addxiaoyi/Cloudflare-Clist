export function encodeApiFilePath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

export function apiFileUrl(storageId: number, path: string): string {
  return `/api/files/${storageId}/${encodeApiFilePath(path)}`;
}
