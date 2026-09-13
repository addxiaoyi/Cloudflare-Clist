import { githubAdapter } from "./git/adapters/github";
import { GitRepositoryClient } from "./git/git-repository-client";
import type { DriveObject, ListObjectsResult } from "./git/types";

export type { DriveObject, ListObjectsResult };
export { GitRepositoryClient };

// 向后兼容：保留 GithubClient 名字与构造签名，内部委托给 GitRepositoryClient + github 适配器。
export class GithubClient extends GitRepositoryClient {
  constructor(options: { config?: Record<string, any>; saving?: Record<string, any> }) {
    super(options, githubAdapter, githubAdapter.buildConnection(options.config));
  }
}