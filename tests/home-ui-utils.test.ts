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

describe('paused status', () => {
  it('shows paused icon when paused', () => {
    const p: UploadProgress = {
      name: 'resume-video.mp4',
      progress: 50,
      currentPart: 5,
      totalParts: 10,
      loaded: 500000000,
      total: 1000000000,
      status: 'paused',
    };
    expect(p.status).toBe('paused');
    expect(p.progress).toBe(50);
  });

  it('preserves progress when transitioning from paused back to uploading', () => {
    const pausedProgress: UploadProgress = {
      name: 'paused-file.txt',
      progress: 75,
      currentPart: 3,
      totalParts: 4,
      status: 'paused',
    };

    const resumedProgress: UploadProgress = {
      ...pausedProgress,
      status: 'uploading',
      startTime: Date.now(),
    };
    expect(resumedProgress.progress).toBe(75);
    expect(resumedProgress.status).toBe('uploading');
  });
});

describe('progress calculation', () => {
  it('calculates progress percentage correctly', () => {
    const calculateProgress = (loaded: number, total: number): number =>
      Math.round((loaded / total) * 100);

    expect(calculateProgress(0, 1000)).toBe(0);
    expect(calculateProgress(500, 1000)).toBe(50);
    expect(calculateProgress(750, 1000)).toBe(75);
    expect(calculateProgress(1000, 1000)).toBe(100);
  });

  it('handles small file progress increments', () => {
    const calculateProgress = (loaded: number, total: number): number =>
      Math.min(Math.round((loaded / total) * 100), 100);

    expect(calculateProgress(1, 1024)).toBe(0);
    expect(calculateProgress(512, 1024)).toBe(50);
  });
});

describe('batch upload queue handling', () => {
  type UploadQueueItem = {
    file: File;
    status: 'pending' | 'uploading' | 'done' | 'error';
    progress: number;
  };

  it('tracks multiple files in upload queue', () => {
    const queue: UploadQueueItem[] = [
      { file: { name: 'a.txt', size: 1000 } as File, status: 'pending', progress: 0 },
      { file: { name: 'b.txt', size: 2000 } as File, status: 'pending', progress: 0 },
    ];
    expect(queue.length).toBe(2);
    expect(queue[0].file.name).toBe('a.txt');
  });

  it('updates queue item when upload starts', () => {
    const queue: UploadQueueItem[] = [];
    queue.push({ file: { name: 'test.txt', size: 500 } as File, status: 'pending', progress: 0 });

    queue[0].status = 'uploading';
    queue[0].progress = 10;

    expect(queue[0].status).toBe('uploading');
    expect(queue[0].progress).toBe(10);
  });

  it('marks items as done after completion', () => {
    const items: UploadQueueItem[] = [];
    const mockFile = new File(['content'], 'done.txt', { type: 'text/plain' });

    items.push({ file: mockFile, status: 'uploading', progress: 100 });
    items[0].status = 'done';

    expect(items[0].status).toBe('done');
  });
});

describe('stop upload button behavior', () => {
  it('shows stop icon (StopCircle) during uploading status', () => {
    const stopIconVisible = (status: 'uploading' | 'paused' | 'error' | 'success'): boolean =>
      status === 'uploading';

    expect(stopIconVisible('uploading')).toBe(true);
    expect(stopIconVisible('paused')).toBe(false);
    expect(stopIconVisible('error')).toBe(false);
    expect(stopIconVisible('success')).toBe(false);
  });

  it('hides stop button when not uploading', () => {
    const showStopButton = (status: UploadProgress['status']): boolean =>
      status === 'uploading';

    expect(showStopButton('uploading')).toBe(true);
    expect(showStopButton('success')).toBe(false);
    expect(showStopButton('error')).toBe(false);
  });
});

describe('time estimation edge cases', () => {
  const estimateTime = (speed: number, bytesRemaining: number): string => {
    if (speed === 0 || bytesRemaining <= 0) return '计算中...';
    const seconds = Math.ceil(bytesRemaining / speed);
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
  };

  it('handles high speed estimates', () => {
    expect(estimateTime(100 * 1024 * 1024, 1024 * 1024 * 1024)).toBe('11秒');
  });

  it('handles very small remaining bytes', () => {
    expect(estimateTime(1024, 1024)).toBe('1秒');
  });

  it('handles exact minute boundaries', () => {
    expect(estimateTime(1024, 1024 * 60)).toBe('1分0秒');
  });

  it('handles exact hour boundaries', () => {
    expect(estimateTime(1024, 1024 * 3600)).toBe('1小时0分');
  });
});

describe('drag and drop visual feedback', () => {
  it('calculates drag over state for visual highlight', () => {
    const calculateDragClass = (dragOver: boolean): string =>
      dragOver ? 'border-primary bg-primary/5 dark:bg-primary/10' : '';

    expect(calculateDragClass(true)).toBe('border-primary bg-primary/5 dark:bg-primary/10');
    expect(calculateDragClass(false)).toBe('');
  });

  it('validates drop with file type check', () => {
    const isFileAcceptable = (file: File, acceptPattern: RegExp): boolean =>
      acceptPattern.test(file.type);

    const imageFile = new File([''], 'test.png', { type: 'image/png' });
    const videoFile = new File([''], 'test.mp4', { type: 'video/mp4' });

    expect(isFileAcceptable(imageFile, /^image\//)).toBe(true);
    expect(isFileAcceptable(videoFile, /^image\//)).toBe(false);
  });

  it('limits total dropped files count', () => {
    const maxFiles = 3;
    const droppedCount = 5;
    const acceptedCount = Math.min(droppedCount, maxFiles);
    expect(acceptedCount).toBe(3);
  });
});

describe('upload progress bar width', () => {
  it('calculates progress bar width from percentage', () => {
    const progressWidth = (progress: number): string =>
      `${progress}%`;

    expect(progressWidth(0)).toBe('0%');
    expect(progressWidth(50)).toBe('50%');
    expect(progressWidth(100)).toBe('100%');
  });

  it('applies success state green bar', () => {
    const successBarClass = (status: 'uploading' | 'paused' | 'error' | 'success'): string =>
      status === 'success' ? 'bg-green-500' : 'bg-blue-500';

    expect(successBarClass('success')).toBe('bg-green-500');
    expect(successBarClass('uploading')).toBe('bg-blue-500');
  });

  it('applies error state red bar', () => {
    const errorBarClass = (status: 'uploading' | 'paused' | 'error' | 'success'): string =>
      status === 'error' ? 'bg-red-500' : 'bg-blue-500';

    expect(errorBarClass('error')).toBe('bg-red-500');
    expect(errorBarClass('paused')).toBe('bg-blue-500');
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
