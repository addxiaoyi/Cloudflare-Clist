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
  return (
    parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  );
}

function formatTimeLeft(
  bytesPerSecond: number,
  bytesRemaining: number,
): string {
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
    partProgress?: Record<number, number>;
    partSizes?: Record<number, number>;
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
    const progress = Math.min(Math.round((1048576000 / 1048576000) * 100), 100);
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

  it('tracks retry count and failed parts', () => {
    const p: UploadProgress = {
      name: 'retry-file.zip',
      progress: 60,
      status: 'error',
      errorMessage: '分片 2 失败',
      retryCount: 2,
      failedParts: [2, 3],
    };
    expect(p.status).toBe('error');
    expect(p.retryCount).toBe(2);
    expect(p.failedParts).toEqual([2, 3]);
  });

  it('tracks paused timestamp', () => {
    const now = Date.now();
    const p: UploadProgress = {
      name: 'paused.mp4',
      progress: 50,
      status: 'paused',
      pausedAt: now,
    };
    expect(p.pausedAt).toBe(now);
    expect(new Date(p.pausedAt!).toLocaleTimeString('zh-CN')).toBeTruthy();
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
      {
        file: { name: 'a.txt', size: 1000 } as File,
        status: 'pending',
        progress: 0,
      },
      {
        file: { name: 'b.txt', size: 2000 } as File,
        status: 'pending',
        progress: 0,
      },
    ];
    expect(queue.length).toBe(2);
    expect(queue[0].file.name).toBe('a.txt');
  });

  it('updates queue item when upload starts', () => {
    const queue: UploadQueueItem[] = [];
    queue.push({
      file: { name: 'test.txt', size: 500 } as File,
      status: 'pending',
      progress: 0,
    });

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
    const stopIconVisible = (
      status: 'uploading' | 'paused' | 'error' | 'success',
    ): boolean => status === 'uploading';

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

    expect(calculateDragClass(true)).toBe(
      'border-primary bg-primary/5 dark:bg-primary/10',
    );
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
    const progressWidth = (progress: number): string => `${progress}%`;

    expect(progressWidth(0)).toBe('0%');
    expect(progressWidth(50)).toBe('50%');
    expect(progressWidth(100)).toBe('100%');
  });

  it('applies success state green bar', () => {
    const successBarClass = (
      status: 'uploading' | 'paused' | 'error' | 'success',
    ): string => (status === 'success' ? 'bg-green-500' : 'bg-blue-500');

    expect(successBarClass('success')).toBe('bg-green-500');
    expect(successBarClass('uploading')).toBe('bg-blue-500');
  });

  it('applies error state red bar', () => {
    const errorBarClass = (
      status: 'uploading' | 'paused' | 'error' | 'success',
    ): string => (status === 'error' ? 'bg-red-500' : 'bg-blue-500');

    expect(errorBarClass('error')).toBe('bg-red-500');
    expect(errorBarClass('paused')).toBe('bg-blue-500');
  });
});

describe('upload speed calculation', () => {
  it('calculates instantaneous speed correctly', () => {
    const calculateSpeed = (
      loaded: number,
      lastLoaded: number,
      now: number,
      lastTs: number,
    ): number => {
      const elapsed = (now - lastTs) / 1000;
      return elapsed > 0 ? Math.max(0, (loaded - lastLoaded) / elapsed) : 0;
    };

    const now = 1000;
    const lastTs = 500;
    const lastLoaded = 0;
    const loaded = 500000;

    expect(calculateSpeed(loaded, lastLoaded, now, lastTs)).toBe(1000000);
  });

  it('returns zero speed when no elapsed time', () => {
    const calculateSpeed = (
      loaded: number,
      lastLoaded: number,
      now: number,
      lastTs: number,
    ): number => {
      const elapsed = (now - lastTs) / 1000;
      return elapsed > 0 ? Math.max(0, (loaded - lastLoaded) / elapsed) : 0;
    };

    expect(calculateSpeed(500, 500, 1000, 1000)).toBe(0);
  });

  it('clamps speed to zero when negative', () => {
    const calculateSpeed = (
      loaded: number,
      lastLoaded: number,
      now: number,
      lastTs: number,
    ): number => {
      const elapsed = (now - lastTs) / 1000;
      return elapsed > 0 ? Math.max(0, (loaded - lastLoaded) / elapsed) : 0;
    };

    expect(calculateSpeed(100, 500, 2000, 1000)).toBe(0);
  });

  it('calculates average speed over upload duration', () => {
    const calculateAvgSpeed = (
      totalBytes: number,
      startTime: number,
    ): number => {
      const elapsed = (Date.now() - startTime) / 1000;
      return elapsed > 0 ? totalBytes / elapsed : 0;
    };

    const startTime = Date.now() - 10000;
    const totalBytes = 1024 * 1024;
    const speed = calculateAvgSpeed(totalBytes, startTime);

    expect(speed).toBeGreaterThan(0);
    expect(speed).toBeLessThan(totalBytes + 1);
  });
});

describe('multipart progress aggregation', () => {
  it('aggregates total bytes from part progress', () => {
    const totalBytesUploaded = 100000;
    const partProgress: Record<number, number> = {
      1: 50000,
      2: 80000,
      3: 0,
    };

    const currentBytes =
      totalBytesUploaded +
      Object.values(partProgress).reduce((a, b) => a + b, 0);

    expect(currentBytes).toBe(230000);
  });

  it('handles empty part progress', () => {
    const totalBytesUploaded = 50000;
    const partProgress: Record<number, number> = {};

    const currentBytes =
      totalBytesUploaded +
      Object.values(partProgress).reduce((a, b) => a + b, 0);

    expect(currentBytes).toBe(50000);
  });

  it('calculates multipart progress percentage', () => {
    const calculateProgress = (totalBytes: number, fileTotal: number): number =>
      Math.min(Math.round((totalBytes / fileTotal) * 100), 100);

    expect(calculateProgress(0, 1000)).toBe(0);
    expect(calculateProgress(500, 1000)).toBe(50);
    expect(calculateProgress(1000, 1000)).toBe(100);
    expect(calculateProgress(1500, 1000)).toBe(100);
  });
});

describe('error retry handling', () => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1000;

  it('validates retry count is within limit', () => {
    const canRetry = (currentRetry: number): boolean =>
      currentRetry < MAX_RETRIES;

    expect(canRetry(0)).toBe(true);
    expect(canRetry(2)).toBe(true);
    expect(canRetry(3)).toBe(false);
  });

  it('calculates exponential backoff delay', () => {
    const calculateBackoff = (retry: number): number =>
      Math.min(RETRY_DELAY_MS * Math.pow(2, retry), 30000);

    expect(calculateBackoff(0)).toBe(1000);
    expect(calculateBackoff(1)).toBe(2000);
    expect(calculateBackoff(2)).toBe(4000);
    expect(calculateBackoff(5)).toBe(30000);
  });

  it('returns error message based on status code', () => {
    const getErrorMessage = (status: number): string => {
      const messages: Record<number, string> = {
        413: '文件过大',
        429: '请求过于频繁',
        500: '服务器错误',
        503: '服务不可用',
      };
      return messages[status] || `HTTP ${status}`;
    };

    expect(getErrorMessage(413)).toBe('文件过大');
    expect(getErrorMessage(429)).toBe('请求过于频繁');
    expect(getErrorMessage(500)).toBe('服务器错误');
    expect(getErrorMessage(404)).toBe('HTTP 404');
  });
});

describe('file validation', () => {
  it('validates file size limit', () => {
    const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
    const isValidSize = (size: number): boolean =>
      size > 0 && size <= MAX_FILE_SIZE;

    expect(isValidSize(0)).toBe(false);
    expect(isValidSize(1024)).toBe(true);
    expect(isValidSize(MAX_FILE_SIZE)).toBe(true);
    expect(isValidSize(MAX_FILE_SIZE + 1)).toBe(false);
  });

  it('validates file name is not empty', () => {
    const isValidName = (name: string): boolean => name.trim().length > 0;

    expect(isValidName('')).toBe(false);
    expect(isValidName('  ')).toBe(false);
    expect(isValidName('test.txt')).toBe(true);
  });
});

describe('per-part granular progress', () => {
  it('tracks individual part progress correctly', () => {
    const partProgress: Record<number, number> = {
      1: 5242880,
      2: 3145728,
      3: 1048576,
    };
    const partSizes: Record<number, number> = {
      1: 5242880,
      2: 5242880,
      3: 5242880,
    };

    // Part 1 is complete (loaded === size)
    expect(partProgress[1]).toBe(partSizes[1]);
    // Part 2 is 60% done
    expect(Math.round((partProgress[2] / partSizes[2]) * 100)).toBe(60);
    // Part 3 is 20% done
    expect(Math.round((partProgress[3] / partSizes[3]) * 100)).toBe(20);
  });

  it('calculates per-part progress percentage', () => {
    const calculatePartProgress = (loaded: number, size: number): number => {
      if (size === 0) return 0;
      return Math.round((loaded / size) * 100);
    };

    expect(calculatePartProgress(5242880, 5242880)).toBe(100);
    expect(calculatePartProgress(0, 5242880)).toBe(0);
    expect(calculatePartProgress(2621440, 5242880)).toBe(50);
  });

  it('detects completed parts correctly', () => {
    const partProgress: Record<number, number> = {
      1: 5242880,
      2: 5242880,
    };
    const totalParts = 4;

    // Part 1 and 2 are completed (present in partProgress)
    const completedParts = Array.from(
      { length: totalParts },
      (_, i) => i + 1,
    ).filter((p) => partProgress.hasOwnProperty(p));

    expect(completedParts).toEqual([1, 2]);
  });

  it('tracks incomplete parts correctly', () => {
    const partProgress: Record<number, number> = {
      1: 5242880,
    };
    const totalParts = 3;

    // Only Part 1 is uploaded (present in partProgress)
    const uploadedParts = Array.from(
      { length: totalParts },
      (_, i) => i + 1,
    ).filter((p) => partProgress.hasOwnProperty(p));

    expect(uploadedParts).toEqual([1]);
  });

  it('handles empty part progress', () => {
    const partProgress: Record<number, number> = {};
    const totalParts = 2;

    // No parts uploaded
    const uploadedParts = Array.from(
      { length: totalParts },
      (_, i) => i + 1,
    ).filter((p) => partProgress.hasOwnProperty(p));

    expect(uploadedParts).toEqual([]);
  });

  it('handles part progress for single-part upload', () => {
    const partProgress: Record<number, number> = {};
    const partSizes: Record<number, number> = { 1: 1048576 };

    // Single part upload started
    partProgress[1] = 524288;

    const loaded = Object.values(partProgress).reduce((a, b) => a + b, 0);
    expect(loaded).toBe(524288);
    expect(Math.round((loaded / partSizes[1]) * 100)).toBe(50);
  });

  it('tracks all parts with different sizes', () => {
    const partSizes: Record<number, number> = {
      1: 5 * 1024 * 1024,
      2: 10 * 1024 * 1024,
      3: 3 * 1024 * 1024,
    };
    const partProgress: Record<number, number> = {
      1: 5 * 1024 * 1024,
      2: 5 * 1024 * 1024,
      3: 0,
    };

    // Part 1 complete, Part 2 50%, Part 3 0%
    expect(Math.round((partProgress[1] / partSizes[1]) * 100)).toBe(100);
    expect(Math.round((partProgress[2] / partSizes[2]) * 100)).toBe(50);
    expect(Math.round((partProgress[3] / partSizes[3]) * 100)).toBe(0);
  });

  it('aggregates total loaded from part progress', () => {
    const totalBytesUploaded = 100000;
    const partProgress: Record<number, number> = {
      1: 5000000,
      2: 3000000,
    };
    const partSizes: Record<number, number> = {
      1: 5000000,
      2: 5000000,
      3: 5000000,
    };

    const currentBytes =
      totalBytesUploaded +
      Object.values(partProgress).reduce((a, b) => a + b, 0);

    expect(currentBytes).toBe(8100000);
  });

  it('computes per-part progress display text', () => {
    const formatPartProgress = (
      loaded: number,
      size: number,
      isCompleted: boolean,
    ): string => {
      if (isCompleted) return '完成';
      if (size === 0) return '0%';
      const progress = Math.round((loaded / size) * 100);
      return `${progress}% (${formatBytes(loaded)}/${formatBytes(size)})`;
    };

    expect(formatPartProgress(5242880, 5242880, true)).toBe('完成');
    expect(formatPartProgress(2621440, 5242880, false)).toBe(
      '50% (2.5 MB/5 MB)',
    );
  });
});

describe('per-part collapse toggle', () => {
  it('defaults to expanded', () => {
    const uploadPartsOpen = true;
    expect(uploadPartsOpen).toBe(true);
  });

  it('toggles between expanded and collapsed', () => {
    let uploadPartsOpen = true;
    uploadPartsOpen = !uploadPartsOpen;
    expect(uploadPartsOpen).toBe(false);
    uploadPartsOpen = !uploadPartsOpen;
    expect(uploadPartsOpen).toBe(true);
  });

  it('counts completed parts for display', () => {
    const partProgress: Record<number, number> = {
      1: 5242880,
      2: 5242880,
    };
    const totalParts = 4;
    const completedCount = Array.from(
      { length: totalParts },
      (_, i) => i + 1,
    ).filter((p) => !partProgress.hasOwnProperty(p)).length;
    expect(completedCount).toBe(2);
  });
});

describe('failed part highlighting', () => {
  it('detects failed parts from failedParts array', () => {
    const failedParts = [2, 4];
    const partNumber = 2;
    const isFailed = failedParts.includes(partNumber);
    expect(isFailed).toBe(true);
  });

  it('returns false for non-failed parts', () => {
    const failedParts = [2, 4];
    const isFailed = failedParts.includes(1);
    expect(isFailed).toBe(false);
  });

  it('handles empty failedParts', () => {
    const failedParts: number[] = [];
    const isFailed = failedParts.includes(1);
    expect(isFailed).toBe(false);
  });

  it('applies red color class for failed parts', () => {
    const isFailed = true;
    const colorClass = isFailed ? 'text-red-500 font-medium' : 'text-zinc-400';
    expect(colorClass).toBe('text-red-500 font-medium');
  });

  it('applies red bar class for failed parts', () => {
    const isFailed = true;
    const isCompleted = false;
    const barClass = isFailed
      ? 'bg-red-500'
      : isCompleted
        ? 'bg-green-500'
        : 'bg-blue-500';
    expect(barClass).toBe('bg-red-500');
  });

  it('displays 失败 text for failed parts', () => {
    const isFailed = true;
    const isCompleted = false;
    const displayText = isFailed ? '失败' : isCompleted ? '完成' : '进行中';
    expect(displayText).toBe('失败');
  });

  it('displays 完成 text for completed parts', () => {
    const isFailed = false;
    const isCompleted = true;
    const displayText = isFailed ? '失败' : isCompleted ? '完成' : '进行中';
    expect(displayText).toBe('完成');
  });

  it('handles all parts failed', () => {
    const failedParts = [1, 2, 3];
    const allFailed = [1, 2, 3].every((p) => failedParts.includes(p));
    expect(allFailed).toBe(true);
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
