import { describe, expect, test } from 'vitest';

import {
  GIT_TYPES,
  getAdapter,
  getGitMaxFileBytes,
  getGitMaxFileLabel,
  isGitStorageType,
} from '~/lib/git/registry';
import { githubAdapter } from '~/lib/git/adapters/github';
import { gitlabAdapter } from '~/lib/git/adapters/gitlab';
import { giteaAdapter } from '~/lib/git/adapters/gitea';
import { giteeAdapter } from '~/lib/git/adapters/gitee';

describe('Git Adapter Registry', () => {
  test('GIT_TYPES 包含四种平台', () => {
    expect(GIT_TYPES.has('github')).toBe(true);
    expect(GIT_TYPES.has('gitlab')).toBe(true);
    expect(GIT_TYPES.has('gitea')).toBe(true);
    expect(GIT_TYPES.has('gitee')).toBe(true);
    expect(GIT_TYPES.has('unknown')).toBe(false);
  });

  test('isGitStorageType 正确判定', () => {
    expect(isGitStorageType('github')).toBe(true);
    expect(isGitStorageType('gitlab')).toBe(true);
    expect(isGitStorageType('gitea')).toBe(true);
    expect(isGitStorageType('gitee')).toBe(true);
    expect(isGitStorageType('s3')).toBe(false);
    expect(isGitStorageType('github-actions')).toBe(false);
  });

  test('getAdapter 返回对应适配器', () => {
    expect(getAdapter('github')).toBe(githubAdapter);
    expect(getAdapter('gitlab')).toBe(gitlabAdapter);
    expect(getAdapter('gitea')).toBe(giteaAdapter);
    expect(getAdapter('gitee')).toBe(giteeAdapter);
  });

  test('getAdapter 未知类型返回 null', () => {
    expect(getAdapter('unknown')).toBe(null);
    expect(getAdapter('')).toBe(null);
    expect(getAdapter('GITHUB')).toBe(null);
  });
});

describe('GitHub Adapter', () => {
  const adapter = githubAdapter;

  test('type 与 label 正确', () => {
    expect(adapter.type).toBe('github');
    expect(adapter.label).toBe('GitHub');
  });

  test('maxFileBytes 与 maxFileLabel 正确', () => {
    expect(adapter.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(adapter.maxFileLabel).toBe('100MB');
  });

  test('supportsListTree 为 true', () => {
    expect(adapter.supportsListTree).toBe(true);
  });

  test('buildConnection 正确解析有效配置', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'ghp_xxx',
      branch: 'main',
      root_path: '',
    });
    expect(conn.repo).toEqual(['owner', 'repo']);
    expect(conn.token).toBe('ghp_xxx');
    expect(conn.apiBase).toBe('https://api.github.com');
    expect(conn.branch).toBe('main');
    expect(conn.rootPath).toBe('');
  });

  test('buildConnection 支持完整仓库 URL', () => {
    const conn = adapter.buildConnection({
      repo: 'https://github.com/owner/repo',
      token: 'ghp_xxx',
      branch: 'develop',
    });
    expect(conn.repo).toEqual(['owner', 'repo']);
    expect(conn.branch).toBe('develop');
  });

  test('buildConnection 支持含 .git 的 URL', () => {
    const conn = adapter.buildConnection({
      repo: 'https://github.com/owner/repo.git',
      token: 'ghp_xxx',
    });
    expect(conn.repo).toEqual(['owner', 'repo']);
  });

  test('buildConnection 使用默认分支 main', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'ghp_xxx',
    });
    expect(conn.branch).toBe('main');
  });

  test('buildConnection 自定义 API 基础', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'ghp_xxx',
      api_base: 'https://github.example.com/api/v3',
    });
    expect(conn.apiBase).toBe('https://github.example.com/api/v3');
  });

  test('buildConnection 自动添加 api 路径', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'ghp_xxx',
      api_base: 'https://github.example.com',
    });
    expect(conn.apiBase).toBe('https://github.example.com');
  });

  test('buildConnection 缺少 token 抛出错误', () => {
    expect(() =>
      adapter.buildConnection({ repo: 'owner/repo', token: '' }),
    ).toThrow('GitHub 存储需填写 Personal Access Token');
  });

  test('buildConnection 缺少 repo 抛出错误', () => {
    expect(() => adapter.buildConnection({ token: 'ghp_xxx' })).toThrow();
  });
});

describe('GitLab Adapter', () => {
  const adapter = gitlabAdapter;

  test('type 与 label 正确', () => {
    expect(adapter.type).toBe('gitlab');
    expect(adapter.label).toBe('GitLab');
  });

  test('maxFileBytes 为 10MB，maxFileLabel 正确', () => {
    expect(adapter.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(adapter.maxFileLabel).toBe('10MB');
  });

  test('supportsListTree 为 true', () => {
    expect(adapter.supportsListTree).toBe(true);
  });

  test('buildConnection 正确解析 group/project 格式', () => {
    const conn = adapter.buildConnection({
      repo: 'group/subgroup/project',
      token: 'glpat_xxx',
      branch: 'main',
    });
    expect(conn.repo).toEqual(['group', 'subgroup', 'project']);
    expect(conn.token).toBe('glpat_xxx');
    expect(conn.apiBase).toBe('https://gitlab.com/api/v4');
  });

  test('buildConnection 使用默认分支 main', () => {
    const conn = adapter.buildConnection({
      repo: 'group/project',
      token: 'glpat_xxx',
    });
    expect(conn.branch).toBe('main');
  });

  test('buildConnection 自定义 API 自动添加 /api/v4', () => {
    const conn = adapter.buildConnection({
      repo: 'group/project',
      token: 'glpat_xxx',
      api_base: 'https://gitlab.example.com',
    });
    expect(conn.apiBase).toBe('https://gitlab.example.com/api/v4');
  });
});

describe('Gitea Adapter', () => {
  const adapter = giteaAdapter;

  test('type 与 label 正确', () => {
    expect(adapter.type).toBe('gitea');
    expect(adapter.label).toBe('Gitea');
  });

  test('maxFileBytes 为 100MB，maxFileLabel 正确', () => {
    expect(adapter.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(adapter.maxFileLabel).toBe('100MB');
  });

  test('supportsListTree 为 true', () => {
    expect(adapter.supportsListTree).toBe(true);
  });

  test('buildConnection 正确解析配置', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'gitea_xxx',
      branch: 'main',
    });
    expect(conn.repo).toEqual(['owner', 'repo']);
    expect(conn.token).toBe('gitea_xxx');
    expect(conn.apiBase).toBe('https://gitea.com/api/v1');
  });

  test('buildConnection 支持 Codeberg.org 域名', () => {
    const conn = adapter.buildConnection({
      repo: 'https://codeberg.org/owner/repo',
      token: 'xxx',
    });
    expect(conn.repo).toEqual(['owner', 'repo']);
  });

  test('buildConnection 自定义 API 自动添加 /api/v1', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'gitea_xxx',
      api_base: 'https://gitea.example.com',
    });
    expect(conn.apiBase).toBe('https://gitea.example.com/api/v1');
  });
});

describe('Gitee Adapter', () => {
  const adapter = giteeAdapter;

  test('type 与 label 正确', () => {
    expect(adapter.type).toBe('gitee');
    expect(adapter.label).toBe('Gitee');
  });

  test('maxFileBytes 为 10MB，maxFileLabel 正确', () => {
    expect(adapter.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(adapter.maxFileLabel).toBe('10MB');
  });

  test('supportsListTree 为 false', () => {
    expect(adapter.supportsListTree).toBe(false);
  });

  test('buildConnection 正确解析配置', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'gitee_xxx',
      branch: 'master',
    });
    expect(conn.repo).toEqual(['owner', 'repo']);
    expect(conn.token).toBe('gitee_xxx');
    expect(conn.apiBase).toBe('https://gitee.com/api/v5');
  });

  test('buildConnection 支持完整仓库 URL', () => {
    const conn = adapter.buildConnection({
      repo: 'https://gitee.com/owner/repo',
      token: 'gitee_xxx',
    });
    expect(conn.repo).toEqual(['owner', 'repo']);
  });

  test('buildConnection 自定义 API 自动添加 /api/v5', () => {
    const conn = adapter.buildConnection({
      repo: 'owner/repo',
      token: 'gitee_xxx',
      api_base: 'https://gitee.example.com',
    });
    expect(conn.apiBase).toBe('https://gitee.example.com/api/v5');
  });

  test('buildConnection 缺少 token 抛出错误', () => {
    expect(() =>
      adapter.buildConnection({ repo: 'owner/repo', token: '' }),
    ).toThrow('Gitee 存储需填写私人令牌');
  });
});

describe('getGitMaxFileBytes/Label 辅助函数', () => {
  test('getGitMaxFileBytes 返回平台对应大小', () => {
    expect(getGitMaxFileBytes('github')).toBe(100 * 1024 * 1024);
    expect(getGitMaxFileBytes('gitlab')).toBe(10 * 1024 * 1024);
    expect(getGitMaxFileBytes('gitea')).toBe(100 * 1024 * 1024);
    expect(getGitMaxFileBytes('gitee')).toBe(10 * 1024 * 1024);
  });

  test('getGitMaxFileLabel 返回平台对应标签', () => {
    expect(getGitMaxFileLabel('github')).toBe('100MB');
    expect(getGitMaxFileLabel('gitlab')).toBe('10MB');
    expect(getGitMaxFileLabel('gitea')).toBe('100MB');
    expect(getGitMaxFileLabel('gitee')).toBe('10MB');
  });
});
