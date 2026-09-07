import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/storages", "routes/api.storages.ts"),
  route("api/files/:storageId/*", "routes/api.files.$storageId.$.ts"),
  route("api/storage-stats/:storageId", "routes/api.storage-stats.$storageId.ts"),
  route("api/changelog", "routes/api.changelog.ts"),
  route("api/audit", "routes/api.audit.ts"),
  route("api/shares", "routes/api.shares.ts"),
  route("api/gdrive-oauth", "routes/api.gdrive-oauth.ts"),
  route("setup", "routes/setup.tsx"),
  route("share", "routes/share.tsx"),
  route("dav/:storageId/*", "routes/dav.$storageId.$.ts"),
] satisfies RouteConfig;
