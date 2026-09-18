import { describe, expect, it, beforeEach, vi } from 'vitest';
import { QuarkClient } from '../app/lib/quark-client';

// 模拟 fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('Quark Upload With Resume (Multipart)', () => {
  let client: QuarkClient;

  const createMockResponse = (data: any, status = 200) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    client = new QuarkClient({
      config: { cookie: 'test_cookie' },
    });
  });

  it('should upload small file with single part', async () => {
    // Mock findFidByPath
    vi.spyOn(client as any, 'findFidByPath').mockResolvedValue(0);

    // Mock init multipart upload
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ code: '0', data: { upload_id: 'test-upload-id' } }),
    );

    // Mock upload part
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        code: '0',
        data: { etag: 'abc123', part_number: 1 },
      }),
    );

    // Mock complete upload
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: '0' }));

    const buffer = new TextEncoder().encode('test content');
    await client.uploadWithResume('test.txt', buffer);

    expect(mockFetch).toHaveBeenCalled();
  }, 10000);

  it('should upload large file with multiple parts', async () => {
    // Mock findFidByPath
    vi.spyOn(client as any, 'findFidByPath').mockResolvedValue(0);

    // Mock init multipart upload
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ code: '0', data: { upload_id: 'test-upload-id' } }),
    );

    // Mock upload parts (3 parts)
    for (let i = 1; i <= 3; i++) {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          code: '0',
          data: { etag: `etag-${i}`, part_number: i },
        }),
      );
    }

    // Mock complete upload
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: '0' }));

    const largeBuffer = new Uint8Array(25 * 1024 * 1024); // 25MB
    await client.uploadWithResume('large-file.bin', largeBuffer, {
      chunkSize: 10 * 1024 * 1024, // 10MB chunks
    });

    // Should have 1 init + 3 parts + 1 complete = 5 calls
    expect(mockFetch).toHaveBeenCalledTimes(5);
  }, 10000);

  it('should report progress during upload', async () => {
    // Mock findFidByPath
    vi.spyOn(client as any, 'findFidByPath').mockResolvedValue(0);

    // Mock init multipart upload
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ code: '0', data: { upload_id: 'test-upload-id' } }),
    );

    // Mock upload parts
    for (let i = 1; i <= 2; i++) {
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          code: '0',
          data: { etag: `etag-${i}`, part_number: i },
        }),
      );
    }

    // Mock complete upload
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: '0' }));

    const buffer = new Uint8Array(15 * 1024 * 1024); // 15MB
    const progressCalls: Array<{
      uploaded: number;
      total: number;
      part: number;
    }> = [];

    await client.uploadWithResume('progress-test.bin', buffer, {
      chunkSize: 10 * 1024 * 1024,
      onProgress: (uploaded, total, part) => {
        progressCalls.push({ uploaded, total, part });
      },
    });

    expect(progressCalls.length).toBe(2);
    expect(progressCalls[0]).toMatchObject({ part: 1 });
    expect(progressCalls[1]).toMatchObject({ part: 2 });
  }, 10000);

  it('should handle upload failure and abort multipart', async () => {
    // Mock findFidByPath
    vi.spyOn(client as any, 'findFidByPath').mockResolvedValue(0);

    // Mock init multipart upload
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ code: '0', data: { upload_id: 'test-upload-id' } }),
    );

    // Mock first part success
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        code: '0',
        data: { etag: 'etag-1', part_number: 1 },
      }),
    );

    // Mock second part failure
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    // Mock abort
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: '0' }));

    const buffer = new Uint8Array(20 * 1024 * 1024); // 20MB
    await expect(
      client.uploadWithResume('fail-test.bin', buffer, {
        chunkSize: 10 * 1024 * 1024,
      }),
    ).rejects.toThrow();
  }, 10000);

  it('should handle empty file', async () => {
    // Mock findFidByPath
    vi.spyOn(client as any, 'findFidByPath').mockResolvedValue(0);

    const emptyBuffer = new Uint8Array(0);
    await client.uploadWithResume('empty.txt', emptyBuffer);

    // Should not call upload endpoints for empty file
    expect(mockFetch).not.toHaveBeenCalled();
  }, 10000);

  it('should stop upload when AbortSignal is aborted', async () => {
    // Mock findFidByPath
    vi.spyOn(client as any, 'findFidByPath').mockResolvedValue(0);

    // Mock init multipart upload
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ code: '0', data: { upload_id: 'test-upload-id' } }),
    );

    // Create an abort controller
    const controller = new AbortController();

    // Mock fetch to simulate network delay and check if abort works
    mockFetch.mockImplementation(async (url: any, options: any) => {
      // If this is a multipart upload_part, delay and check signal
      if (url.toString().includes('upload_part')) {
        return new Promise((resolve, reject) => {
          const checkAbort = () => {
            if (options.signal?.aborted) {
              reject(
                new DOMException('Upload cancelled by user', 'AbortError'),
              );
            } else {
              setTimeout(checkAbort, 5);
            }
          };
          checkAbort();

          // Resolve after abort or timeout
          setTimeout(() => {
            resolve(
              createMockResponse({
                code: '0',
                data: { etag: 'test-etag', part_number: 1 },
              }),
            );
          }, 100);
        });
      }
      // For other requests (like init, complete), resolve immediately
      return createMockResponse({ code: '0' });
    });

    const buffer = new Uint8Array(15 * 1024 * 1024);

    const uploadPromise = client.uploadWithResume('abort-test.bin', buffer, {
      chunkSize: 10 * 1024 * 1024,
      signal: controller.signal,
    });

    // Abort after a short delay (before upload completes)
    setTimeout(() => controller.abort(), 10);

    await expect(uploadPromise).rejects.toThrow('Upload cancelled by user');
  }, 10000);

  it('should cancel upload using cancelUpload method', async () => {
    // Mock findFidByPath
    vi.spyOn(client as any, 'findFidByPath').mockResolvedValue(0);

    // Mock abort upload
    mockFetch.mockResolvedValueOnce(createMockResponse({ code: '0' }));

    const uploadId = 'test-cancel-upload-id';
    await client.cancelUpload(uploadId);

    expect(mockFetch).toHaveBeenCalled();
  });
});
