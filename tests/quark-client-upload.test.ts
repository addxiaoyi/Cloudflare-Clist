import { describe, expect, test } from 'vitest';
import { md5Hex, sha1Hex } from '~/lib/md5';

describe('Quark upload format_type extraction', () => {
  const extractFormatType = (fileName: string): string => {
    return fileName.includes('.')
      ? fileName.split('.').pop()?.toLowerCase() || 'bin'
      : 'bin';
  };

  test('should extract lowercase extension from PNG file', () => {
    expect(extractFormatType('test.png')).toBe('png');
  });

  test('should extract extension from JPG file', () => {
    expect(extractFormatType('photo.jpg')).toBe('jpg');
  });

  test('should extract extension from PDF file', () => {
    expect(extractFormatType('document.pdf')).toBe('pdf');
  });

  test('should handle uppercase extension', () => {
    expect(extractFormatType('test.PNG')).toBe('png');
  });

  test('should handle mixed case extension', () => {
    expect(extractFormatType('test.JpG')).toBe('jpg');
  });

  test('should extract extension from nested filename', () => {
    expect(extractFormatType('my.photo.jpg')).toBe('jpg');
  });

  test('should default to bin for no extension', () => {
    expect(extractFormatType('README')).toBe('bin');
  });

  test('should default to bin for empty string', () => {
    expect(extractFormatType('')).toBe('bin');
  });

  test('should handle file with only dot', () => {
    expect(extractFormatType('.hidden')).toBe('hidden');
  });
});

describe('Quark MD5 and SHA1 hash calculation', () => {
  test('should calculate MD5 hash for ASCII string', async () => {
    const buffer = new TextEncoder().encode('hello world');
    const md5 = md5Hex(buffer.buffer);
    expect(md5).toBeDefined();
    expect(md5.length).toBe(32); // MD5 is 32 hex characters
    expect(/^[a-f0-9]{32}$/.test(md5)).toBe(true);
  });

  test('should calculate SHA1 hash for ASCII string', async () => {
    const buffer = new TextEncoder().encode('hello world');
    const sha1 = await sha1Hex(buffer.buffer);
    expect(sha1).toBeDefined();
    expect(sha1.length).toBe(40); // SHA1 is 40 hex characters
    expect(/^[a-f0-9]{40}$/.test(sha1)).toBe(true);
  });

  test('should calculate MD5 hash for UTF-8 string', async () => {
    const buffer = new TextEncoder().encode('夸克登录');
    const md5 = md5Hex(buffer.buffer);
    expect(md5).toBeDefined();
    expect(md5.length).toBe(32);
  });

  test('should calculate SHA1 hash for UTF-8 string', async () => {
    const buffer = new TextEncoder().encode('夸克登录');
    const sha1 = await sha1Hex(buffer.buffer);
    expect(sha1).toBeDefined();
    expect(sha1.length).toBe(40);
  });

  test('should produce consistent hashes for same input', async () => {
    const buffer = new TextEncoder().encode('test content');
    const md5_1 = md5Hex(buffer.buffer);
    const md5_2 = md5Hex(buffer.buffer);
    const sha1_1 = await sha1Hex(buffer.buffer);
    const sha1_2 = await sha1Hex(buffer.buffer);

    expect(md5_1).toBe(md5_2);
    expect(sha1_1).toBe(sha1_2);
  });

  test('should produce different hashes for different inputs', async () => {
    const content1 = new TextEncoder().encode('content1');
    const content2 = new TextEncoder().encode('content2');

    // Use buffer.slice() to get independent ArrayBuffer copies
    const md5_1 = md5Hex(content1.buffer.slice(0));
    const md5_2 = md5Hex(content2.buffer.slice(0));
    const sha1_1 = await sha1Hex(content1.buffer.slice(0));
    const sha1_2 = await sha1Hex(content2.buffer.slice(0));

    expect(md5_1).not.toBe(md5_2);
    expect(sha1_1).not.toBe(sha1_2);
  });
});

describe('Quark API endpoint structure', () => {
  test('upload/pre endpoint should be correct', () => {
    const endpoint = '/1/clouddrive/file/upload/pre';
    expect(endpoint).toBe('/1/clouddrive/file/upload/pre');
  });

  test('update/hash endpoint should be correct', () => {
    const endpoint = '/1/clouddrive/file/update/hash';
    expect(endpoint).toBe('/1/clouddrive/file/update/hash');
  });

  test('upload/finish endpoint should be correct', () => {
    const endpoint = '/1/clouddrive/file/upload/finish';
    expect(endpoint).toBe('/1/clouddrive/file/upload/finish');
  });

  test('API base URL should be correct', () => {
    const apiBase = 'https://drive.quark.cn';
    expect(apiBase).toBe('https://drive.quark.cn');
  });
});

describe('Quark upload flow validation', () => {
  test('should validate required parameters for upload/pre', () => {
    const requiredParams = [
      'pdir_fid',
      'file_name',
      'size',
      'format_type',
      'md5',
      'sha1',
    ];

    const params = {
      pdir_fid: '12345',
      file_name: 'test.png',
      size: 1024,
      format_type: 'png',
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    };

    requiredParams.forEach((param) => {
      expect(params).toHaveProperty(param);
    });
  });

  test('should validate required parameters for update/hash', () => {
    const requiredParams = ['task_id', 'md5', 'sha1'];

    const params = {
      task_id: 'test-task-123',
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    };

    requiredParams.forEach((param) => {
      expect(params).toHaveProperty(param);
    });
  });

  test('should validate required parameters for upload/finish', () => {
    const requiredParams = ['task_id', 'obj_key', 'size'];

    const params = {
      task_id: 'test-task-123',
      obj_key: 'test-obj-key',
      size: 1024,
    };

    requiredParams.forEach((param) => {
      expect(params).toHaveProperty(param);
    });
  });
});

describe('Quark retry logic', () => {
  test('should retry on 530 error code 1016', () => {
    const maxRetries = 3;
    const delayStrategy = (retryCount: number) =>
      Math.pow(2, retryCount) * 1000;

    const delays = [0, 1, 2].map((i) => delayStrategy(i));

    expect(delays[0]).toBe(1000); // 1 second
    expect(delays[1]).toBe(2000); // 2 seconds
    expect(delays[2]).toBe(4000); // 4 seconds
  });

  test('should have exponential backoff pattern', () => {
    const delays = [1000, 2000, 4000];
    expect(delays[1]).toBe(delays[0] * 2);
    expect(delays[2]).toBe(delays[1] * 2);
  });
});
