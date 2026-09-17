/**
 * 夸克上传功能单元测试（无 Cookie 依赖）
 * 测试 API 调用流程，不需要真实的夸克账号
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QuarkClient } from '~/lib/quark-client';
import { md5Hex, sha1Hex } from '~/lib/md5';

describe('Quark Upload API Flow', () => {
  let client;
  let mockFetch;

  beforeEach(() => {
    // Mock fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  // Helper function to create a proper mock response
  const createMockResponse = (data, status = 200) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };
  };

  test('should call upload/pre endpoint with correct parameters', async () => {
    const config = {
      cookie: 'test_cookie',
    };

    client = new QuarkClient({ config });

    // Mock upload/pre response
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        code: 0,
        data: {
          task_id: 'test-task-123',
          obj_key: 'test-obj-key',
          upload_url: 'https://quark-oss.example.com/upload',
        },
      }),
    );

    // Mock update/hash response
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    // Mock OSS upload response (needs json() for the request method)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
    });

    // Mock upload/finish response
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    const buffer = new TextEncoder().encode('test content');

    // Calculate hashes from the actual buffer being uploaded
    const md5 = await md5Hex(buffer.buffer);
    const sha1 = await sha1Hex(buffer.buffer);

    // Call putObject
    await client.putObject('test.txt', buffer);

    // Verify the upload/pre call
    expect(mockFetch).toHaveBeenCalled();
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall[0]).toContain('/1/clouddrive/file/upload/pre');
    expect(firstCall[1].method).toBe('POST');

    // Verify request body contains all required fields
    const requestBody = JSON.parse(firstCall[1].body);
    expect(requestBody.pdir_fid).toBe(0);
    expect(requestBody.file_name).toBe('test.txt');
    expect(requestBody.md5).toBe(md5);
    expect(requestBody.sha1).toBe(sha1);
    expect(requestBody).toHaveProperty('size');
  });

  test('should extract task_id from various response formats', async () => {
    const config = { cookie: 'test_cookie' };
    client = new QuarkClient({ config });

    // Test various response formats with task_id
    const testCases = [
      { task_id: '123' },
      { upload_id: '456' },
      { session_id: '789' },
      { upload_session_id: 'abc' },
      { id: 'def' },
    ];

    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      mockFetch.mockReset();

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          code: 0,
          data: testCase,
        }),
      );

      mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

      // OSS upload mock needs json() method
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });

      mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

      const buffer = new TextEncoder().encode('test');
      await client.putObject('test.txt', buffer);

      expect(mockFetch).toHaveBeenCalled();
    }
  });

  test('should handle upload/pre failure gracefully', async () => {
    const config = { cookie: 'test_cookie' };
    client = new QuarkClient({ config });

    // Mock failed upload/pre
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () =>
        Promise.resolve(JSON.stringify({ code: 404, message: 'Not Found' })),
    });

    await expect(
      client.putObject('test.txt', new TextEncoder().encode('test')),
    ).rejects.toThrow();
  });

  test('should handle missing task_id in response', async () => {
    const config = { cookie: 'test_cookie' };
    client = new QuarkClient({ config });

    // Mock response without task_id
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        code: 0,
        data: {},
      }),
    );

    await expect(
      client.putObject('test.txt', new TextEncoder().encode('test')),
    ).rejects.toThrow('failed to prepare upload');
  });

  test('should proceed even if OSS upload fails', async () => {
    const config = { cookie: 'test_cookie' };
    client = new QuarkClient({ config });

    // Mock upload/pre
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        code: 0,
        data: {
          task_id: 'test-task',
          obj_key: 'test-obj',
          upload_url: 'https://example.com/upload',
        },
      }),
    );

    // Mock update/hash
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    // Mock OSS upload failure
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    // Mock upload/finish
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    const buffer = new TextEncoder().encode('test content');
    await expect(client.putObject('test.txt', buffer)).resolves.not.toThrow();
  });

  test('should retry on 530 error code 1016', async () => {
    const config = { cookie: 'test_cookie' };
    client = new QuarkClient({ config });

    // Mock upload/pre
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        code: 0,
        data: {
          task_id: 'test-task',
          obj_key: 'test-obj',
          upload_url: 'https://example.com/upload',
        },
      }),
    );

    // Mock update/hash
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    // Mock first OSS upload failure (530 error)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 530,
      text: () => Promise.resolve('error code: 1016'),
    });

    // Mock second OSS upload failure (530 error)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 530,
      text: () => Promise.resolve('error code: 1016'),
    });

    // Mock successful OSS upload on third attempt
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    // Mock upload/finish
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    const buffer = new TextEncoder().encode('test content');
    await expect(client.putObject('test.txt', buffer)).resolves.not.toThrow();

    // Should have retried (pre + update/hash + 3 OSS attempts + finish = 6 calls)
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  test('should handle responses without upload_url', async () => {
    const config = { cookie: 'test_cookie' };
    client = new QuarkClient({ config });

    // Mock upload/pre without upload_url
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        code: 0,
        data: {
          task_id: 'test-task',
          obj_key: 'test-obj',
          // No upload_url field
        },
      }),
    );

    // Mock update/hash
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    // Mock upload/finish
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: 0 }));

    const buffer = new TextEncoder().encode('test content');
    await expect(client.putObject('test.txt', buffer)).resolves.not.toThrow();
  });
});
