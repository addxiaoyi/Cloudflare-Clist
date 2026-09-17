import { describe, expect, test, vi } from 'vitest';

import { createClient, type StorageLike, createMysqlClient } from '~/lib/client-factory';
import { GitRepositoryClient } from '~/lib/git/git-repository-client';
import { S3Client } from '~/lib/s3-client';
import { WebdevClient } from '~/lib/webdev-client';
import { R2OAuthClient } from '~/lib/r2-oauth-client';
import { MySqlClient } from '~/lib/mysql-client';

// Minimal stubs for client constructors to avoid real service calls
vi.mock('~/lib/s3-client', () => ({
  S3Client: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'S3Client';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/webdev-client', () => ({
  WebdevClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'WebdevClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/onedrive-client', () => ({
  OneDriveClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'OneDriveClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/gdrive-client', () => ({
  GoogleDriveClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'GoogleDriveClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/alicloud-client', () => ({
  AliyunDriveClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'AliyunDriveClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/baiduyun-client', () => ({
  BaiduYunClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'BaiduYunClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/quark-client', () => ({
  QuarkClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'QuarkClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/dropbox-client', () => ({
  DropboxClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'DropboxClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/github-client', () => ({
  GithubClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'GithubClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/r2-oauth-client', () => ({
  R2OAuthClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'R2OAuthClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/mysql-client', () => ({
  MySqlClient: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'MySqlClient';
      (this as any)._args = args;
    }
  },
}));

vi.mock('~/lib/r2-client', () => ({
  R2Client: class {
    constructor(...args: any[]) {
      (this as any)._ctor = 'R2Client';
      (this as any)._args = args;
    }
  },
}));

describe('createClient 路由覆盖', () => {
  function makeStorage(overrides: Partial<StorageLike> = {}): StorageLike {
    return {
      type: 's3',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'b',
      basePath: '/',
      ...overrides,
    };
  }

  test('r2: 缺少 env.R2 时抛错', () => {
    const storage = makeStorage({ type: 'r2' });
    expect(() => createClient(storage)).toThrow('R2 绑定未配置');
  });

  test('r2: 提供 env.R2 时返回 R2Client 实例', () => {
    const mockR2 = { name: 'test-bucket' } as any;
    const storage = makeStorage({ type: 'r2', bucket: 'my-bucket' });
    const client = createClient(storage, { R2: mockR2 }, 42);
    expect((client as any)._ctor).toBe('R2Client');
    const args = (client as any)._args;
    expect(args[0]).toBe(mockR2);
    expect(args[1].bucketName).toBe('my-bucket');
    expect(args[1].storageId).toBe(42);
  });

  test('tigris: 使用 config.endpoint 优先于默认值', () => {
    const storage = makeStorage({
      type: 'tigris',
      config: { endpoint: 'https://fly.storage', access_key_id: 'ak', secret_access_key: 'sk', bucket: 'bkt' },
    });
    const client = createClient(storage) as any;
    expect(client._ctor).toBe('S3Client');
    expect(client._args[0].endpoint).toBe('https://fly.storage');
  });

  test('tigris: fallback 到 storage 字段', () => {
    const storage = makeStorage({
      type: 'tigris',
      config: {},
      accessKeyId: 'stk-ak',
      secretAccessKey: 'stk-sk',
      bucket: 'stk-bkt',
    });
    const client = createClient(storage) as any;
    expect(client._args[0].accessKeyId).toBe('stk-ak');
    expect(client._args[0].secretAccessKey).toBe('stk-sk');
    expect(client._args[0].bucket).toBe('stk-bkt');
  });

  test('qiniu: region 映射 z0 -> cn-east-1', () => {
    const storage = makeStorage({
      type: 'qiniu',
      config: { region: 'z0', access_key: 'ak', secret_key: 'sk', bucket: 'qiniu-bkt' },
    });
    const client = createClient(storage) as any;
    expect(client._args[0].endpoint).toBe('https://s3.cn-east-1.qiniucs.com');
    expect(client._args[0].region).toBe('cn-east-1');
    expect(client._args[0].usePathStyle).toBe(true);
  });

  test('qiniu: region 映射 na0 -> us-east-1', () => {
    const storage = makeStorage({
      type: 'qiniu',
      config: { region: 'na0', access_key: 'ak', secret_key: 'sk', bucket: 'b' },
    });
    const client = createClient(storage) as any;
    expect(client._args[0].region).toBe('us-east-1');
  });

  test('qiniu: 默认 region 为 z0', () => {
    const storage = makeStorage({ type: 'qiniu', config: { access_key: 'ak', secret_key: 'sk', bucket: 'b' } });
    const client = createClient(storage) as any;
    expect(client._args[0].region).toBe('cn-east-1');
  });

  test('webdev: 使用 storage 字段构造 WebdevClient', () => {
    const storage = makeStorage({
      type: 'webdev',
      endpoint: 'https://webdev.example.com',
      accessKeyId: 'user',
      secretAccessKey: 'pass',
      basePath: '/root',
    });
    const client = createClient(storage) as any;
    expect(client._ctor).toBe('WebdevClient');
    expect(client._args[0].endpoint).toBe('https://webdev.example.com');
    expect(client._args[0].username).toBe('user');
    expect(client._args[0].password).toBe('pass');
  });

  test('ftp: 使用 config 优先，fallback 到 storage 字段', () => {
    const storage = makeStorage({
      type: 'ftp',
      config: { endpoint: 'https://ftp.example.com', username: 'ftp-user', password: 'ftp-pass' },
      accessKeyId: 'fallback-user',
      secretAccessKey: 'fallback-pass',
    });
    const client = createClient(storage) as any;
    expect(client._ctor).toBe('WebdevClient');
    expect(client._args[0].endpoint).toBe('https://ftp.example.com');
    expect(client._args[0].username).toBe('ftp-user');
  });

  test('ftp: fallback 到 storage 字段', () => {
    const storage = makeStorage({
      type: 'ftp',
      config: {},
      endpoint: 'https://ftp.example.com',
      accessKeyId: 'user',
      secretAccessKey: 'pass',
    });
    const client = createClient(storage) as any;
    expect(client._args[0].endpoint).toBe('https://ftp.example.com');
    expect(client._args[0].username).toBe('user');
  });

  test('quark: 返回 QuarkClient 实例', () => {
    const storage = makeStorage({ type: 'quark', config: { key: 'val' }, saving: { x: 1 } });
    const client = createClient(storage);
    expect((client as any)._ctor).toBe('QuarkClient');
    expect((client as any)._args[0].config).toEqual({ key: 'val' });
    expect((client as any)._args[0].saving).toEqual({ x: 1 });
  });

  test('dropbox: 返回 DropboxClient 实例', () => {
    const storage = makeStorage({ type: 'dropbox', config: { c: 1 } });
    const client = createClient(storage);
    expect((client as any)._ctor).toBe('DropboxClient');
  });

  test('github: 返回 GithubClient 实例', () => {
    const storage = makeStorage({ type: 'github', config: { token: 'ghp_x' } });
    const client = createClient(storage);
    expect((client as any)._ctor).toBe('GithubClient');
  });

  test('r2-oauth: 配置完整时返回 R2OAuthClient', () => {
    const storage = makeStorage({
      type: 'r2-oauth',
      config: { account_id: 'acc', bucket: 'bk', access_token: 'tok' },
      basePath: '/root',
    });
    const client = createClient(storage) as any;
    expect(client._ctor).toBe('R2OAuthClient');
    expect(client._args[0].accountId).toBe('acc');
    expect(client._args[0].bucketName).toBe('bk');
    expect(client._args[0].accessToken).toBe('tok');
    expect(client._args[0].basePath).toBe('/root');
  });

  test('r2-oauth: 缺少必要字段时抛错', () => {
    const storage = makeStorage({
      type: 'r2-oauth',
      config: { account_id: 'acc' },
    });
    expect(() => createClient(storage)).toThrow('R2 OAuth 未授权');
  });

  test('r2-oauth: 从 saving 读取 access_token', () => {
    const storage = makeStorage({
      type: 'r2-oauth',
      config: { account_id: 'acc', bucket: 'bk' },
      saving: { access_token: 'saved-tok', cloudflare_access_token: 'also-valid' },
    });
    const client = createClient(storage) as any;
    expect(client._ctor).toBe('R2OAuthClient');
    expect(client._args[0].accessToken).toBe('also-valid');
  });

  test('s3: signatureVersion 处理', () => {
    const storage = makeStorage({
      type: 's3',
      config: { signature_version: 'v2' },
    });
    const client = createClient(storage) as any;
    expect(client._args[0].signatureVersion).toBe('v2');
  });

  test('s3: signatureVersion 默认为 v4', () => {
    const storage = makeStorage({ type: 's3' });
    const client = createClient(storage) as any;
    expect(client._args[0].signatureVersion).toBe('v4');
  });

  test('s3: 使用 basePath / root_folder_path', () => {
    const storage = makeStorage({
      type: 's3',
      // storage.basePath 为空时回退到 config.root_folder_path
      basePath: '',
      config: { root_folder_path: '/root-path' },
    });
    const client = createClient(storage) as any;
    // s3 类型优先使用 storage.basePath，fallback 到 config.root_folder_path
    expect(client._args[0].basePath).toBe('/root-path');
  });

  test('s3: 使用 path_style false 时关闭路径样式', () => {
    const storage = makeStorage({ type: 's3', config: { path_style: false } });
    const client = createClient(storage) as any;
    expect(client._args[0].usePathStyle).toBe(false);
  });

  test('unknown type: 默认返回 S3Client', () => {
    const storage = makeStorage({ type: 'unknown-provider' });
    const client = createClient(storage) as any;
    expect(client._ctor).toBe('S3Client');
  });
});

describe('createMysqlClient', () => {
  test('缺少连接串和 Hyperdrive 时抛错', () => {
    const storage: StorageLike = {
      type: 'mysql',
      endpoint: '',
      region: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucket: '',
      basePath: '',
      config: {},
    };
    expect(() => createMysqlClient(storage)).toThrow('MySQL 需先绑定 Cloudflare Hyperdrive');
  });

  test('有 connectionString 时正常构造', () => {
    const storage: StorageLike = {
      type: 'mysql',
      endpoint: 'mysql://user:pass@host:3306/db',
      region: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucket: '',
      basePath: '',
      config: { connection_string: 'mysql://cstr/db', database: 'mydb' },
    };
    const client = createMysqlClient(storage) as any;
    expect(client._ctor).toBe('MySqlClient');
    expect(client._args[0].connectionString).toBe('mysql://cstr/db');
  });

  test('使用 endpoint 作为 connectionString', () => {
    const storage: StorageLike = {
      type: 'mysql',
      endpoint: 'mysql://host:3306/db',
      region: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucket: '',
      basePath: '',
      config: {},
    };
    const client = createMysqlClient(storage) as any;
    expect(client._args[0].connectionString).toBe('mysql://host:3306/db');
  });

  test('优先使用 Hyperdrive', () => {
    const storage: StorageLike = {
      type: 'mysql',
      endpoint: 'mysql://nope:3306/db',
      region: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucket: '',
      basePath: '',
      config: {},
    };
    const mockHD = { connectionString: 'hyperdrive://hd' } as any;
    const client = createMysqlClient(storage, { HD: mockHD }) as any;
    // createMysqlClient 将 env 传给 MySqlClient；Hyperdrive 逻辑在 MySqlClient 内部处理
    expect(client._ctor).toBe('MySqlClient');
    expect(client._args[0].connectionString).toBe('mysql://nope:3306/db');
    // 验证 env 被传递
    expect((client._args[1] as any)?.HD).toBe(mockHD);
  });
});
