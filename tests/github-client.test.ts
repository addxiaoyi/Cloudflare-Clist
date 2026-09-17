import { describe, expect, test } from 'vitest';
import { GithubClient } from '~/lib/github-client';

describe('GithubClient', () => {
  test('构造成功', () => {
    const client = new GithubClient({
      config: { token: 'ghp_test', repo: 'owner/repo' },
    });
    expect(client).toBeInstanceOf(GithubClient);
  });

  test('空 config 抛错', () => {
    expect(() => new GithubClient({})).toThrow('GitHub 存储需填写仓库');
  });
});
