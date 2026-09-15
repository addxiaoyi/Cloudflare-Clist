import { describe, expect, test } from 'vitest';

import { createClient } from '~/lib/client-factory';
import type { StorageLike } from '~/lib/client-factory';
import { GitRepositoryClient } from '~/lib/git/git-repository-client';

describe('createClient Git Dispatch', () => {
  const TYPE_CONFIGS: Array<{ type: string; token: string }> = [
    { type: 'github', token: 'ghp_test' },
    { type: 'gitlab', token: 'glpat_test' },
    { type: 'gitea', token: 'gitea_test' },
    { type: 'gitee', token: 'gitee_test' },
  ];

  test.each(TYPE_CONFIGS)(
    "createClient(type='${this.type}') 返回 GitRepositoryClient 实例",
    ({ type, token }) => {
      const storage: StorageLike = {
        type,
        endpoint: '',
        region: '',
        accessKeyId: '',
        secretAccessKey: '',
        bucket: '',
        basePath: '',
        config: { repo: 'owner/repo', token, branch: 'main', root_path: '' },
        saving: {},
      };
      const client = createClient(storage);
      expect(client).toBeInstanceOf(GitRepositoryClient);
    },
  );

  test('createClient(s3) 不返回 GitRepositoryClient 实例', () => {
    const storage: StorageLike = {
      type: 's3',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'b',
      basePath: '/',
    };
    const client = createClient(storage);
    expect(client).not.toBeInstanceOf(GitRepositoryClient);
  });

  test('createClient(r2) 缺少绑定时应抛出配置错误', () => {
    const storage: StorageLike = {
      type: 'r2',
      endpoint: '',
      region: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucket: 'r2-bucket',
      basePath: '/',
    };
    // R2 需 wrangler r2_buckets 绑定，未注入 env.R2 时应明确报错而非静默返回
    expect(() => createClient(storage)).toThrow('R2 绑定未配置');
  });
});
