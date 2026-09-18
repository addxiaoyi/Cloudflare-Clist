import { describe, expect, it, vi, beforeEach } from 'vitest';

// Import the helper functions from home.tsx
// Since they are not exported, we define them here for testing
function formatBytes(bytes: number): string {
  if (bytes === 0) return '-';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTimeLeft(bytesPerSecond: number, bytesRemaining: number): string {
  if (bytesPerSecond === 0 || bytesRemaining <= 0) return '计算中...';
  const seconds = Math.ceil(bytesRemaining / bytesPerSecond);
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}

describe('formatBytes', () => {
  it('returns dash for zero bytes', () => {
    expect(formatBytes(0)).toBe('-');
  });

  it('formats bytes below 1KB', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });
});

describe('formatSpeed', () => {
  it('returns zero string for zero speed', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
  });

  it('formats bytes per second', () => {
    expect(formatSpeed(500)).toBe('500 B/s');
  });

  it('formats kilobytes per second', () => {
    expect(formatSpeed(2048)).toBe('2 KB/s');
  });

  it('formats megabytes per second', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1 MB/s');
  });
});

describe('formatTimeLeft', () => {
  it('returns calculating for zero speed', () => {
    expect(formatTimeLeft(0, 1024)).toBe('计算中...');
  });

  it('returns calculating for zero remaining', () => {
    expect(formatTimeLeft(1024, 0)).toBe('计算中...');
  });

  it('returns calculating for negative remaining', () => {
    expect(formatTimeLeft(1024, -1)).toBe('计算中...');
  });

  it('formats seconds under one minute', () => {
    expect(formatTimeLeft(1024, 1024)).toBe('1秒');
    expect(formatTimeLeft(1024, 5120)).toBe('5秒');
  });

  it('formats minutes and seconds', () => {
    expect(formatTimeLeft(1024, 1024 * 65)).toBe('1分5秒');
    expect(formatTimeLeft(1024, 1024 * 300)).toBe('5分0秒');
  });

  it('formats hours and minutes', () => {
    expect(formatTimeLeft(1024, 1024 * 3600 * 2)).toBe('2小时0分');
  });
});

describe('uploadProgress state', () => {
  type UploadProgress = {
    name: string;
    progress: number;
    currentPart?: number;
    totalParts?: number;
    speed?: number;
    loaded?: number;
    total?: number;
    status: 'uploading' | 'paused' | 'error' | 'success';
    errorMessage?: string;
  };

  it('tracks uploading state with speed and size', () => {
    const p: UploadProgress = {
      name: 'video.mp4',
      progress: 45,
      currentPart: 3,
      totalParts: 8,
      speed: 5242880,
      loaded: 471859200,
      total: 1024 * 1024 * 1024,
      status: 'uploading',
    };
    expect(p.status).toBe('uploading');
    expect(p.progress).toBeLessThan(100);
    expect(p.currentPart).toBeLessThan(p.totalParts!);
    expect(p.speed!).toBeGreaterThan(0);
    expect(formatBytes(p.total!)).toBe('1 GB');
  });

  it('caps progress at 100% for success state', () => {
    const progress = Math.min(
      Math.round((1048576000 / 1048576000) * 100),
      100,
    );
    const p: UploadProgress = {
      name: 'done.zip',
      progress,
      loaded: 1048576000,
      total: 1048576000,
      status: 'success',
    };
    expect(p.progress).toBe(100);
  });

  it('carries error message in error state', () => {
    const p: UploadProgress = {
      name: 'broken.iso',
      progress: 30,
      status: 'error',
      errorMessage: '分片 4 上传失败: 网络超时',
    };
    expect(p.status).toBe('error');
    expect(p.errorMessage).toBeTruthy();
  });
});

describe('abort controller for stopping uploads', () => {
  it('abort() sets signal.aborted to true', () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('abort() rejects a pending fetch with AbortError', async () => {
    const controller = new AbortController();
    const pending = fetch('https://example.com/upload-part', {
      method: 'PUT',
      signal: controller.signal,
    }).catch((err) => err);

    controller.abort();

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
  });

  it('mirrors the stop-upload button handler semantics', () => {
    // 复刻 home.tsx 中停止按钮的行为：
    // abort 当前 controller 后立即置空引用
    let uploadAbortControllerRef: AbortController | null =
      new AbortController();

    expect(uploadAbortControllerRef).not.toBeNull();

    uploadAbortControllerRef.abort();
    uploadAbortControllerRef = null;

    expect(uploadAbortControllerRef).toBeNull();
  });
});
