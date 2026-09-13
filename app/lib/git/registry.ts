import type { GitPlatformAdapter } from "./types";
import { githubAdapter } from "./adapters/github";
import { gitlabAdapter } from "./adapters/gitlab";
import { giteaAdapter } from "./adapters/gitea";
import { giteeAdapter } from "./adapters/gitee";

export const adapters: Record<string, GitPlatformAdapter> = {
  github: githubAdapter,
  gitlab: gitlabAdapter,
  gitea: giteaAdapter,
  gitee: giteeAdapter,
};

export const GIT_TYPES = new Set(["github", "gitlab", "gitea", "gitee"]);

export function getAdapter(type: string): GitPlatformAdapter | null {
  return adapters[type] || null;
}

export function getGitMaxFileBytes(type: string): number {
  const adapter = getAdapter(type);
  return adapter?.maxFileBytes || 100 * 1024 * 1024;
}

export function getGitMaxFileLabel(type: string): string {
  const adapter = getAdapter(type);
  return adapter?.maxFileLabel || "100MB";
}

export function isGitStorageType(type: string): boolean {
  return GIT_TYPES.has(type);
}