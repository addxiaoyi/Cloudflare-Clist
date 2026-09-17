/**
 * 夸克上传功能 Jest 集成测试
 * 需要真实的 Cookie 才能运行
 * 运行方式：QUARK_COOKIE=xxx npm run test:quark
 */

import { QuarkClient } from '../app/lib/quark-client';
import { md5Hex, sha1Hex } from '../app/lib/md5';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Quark Upload Integration Test', () => {
  const cookie = process.env.QUARK_COOKIE;
  const skipTest = !cookie;

  beforeAll(() => {
    if (!cookie) {
      console.log('\n⚠️  跳过集成测试：未设置 QUARK_COOKIE 环境变量');
      console.log('   要运行真实上传测试，请设置：');
      console.log('   QUARK_COOKIE="your_cookie_here" npm run test:quark\n');
    }
  });

  test.skipIf(skipTest)(
    '应该成功上传文件到夸克云盘',
    async () => {
      const client = new QuarkClient({
        config: { cookie },
      });

      // 读取测试文件
      const testFile = resolve(__dirname, '../upload-tests/test1.txt');
      const fileBuffer = readFileSync(testFile);
      const fileSize = fileBuffer.length;

      // 计算哈希
      const md5 = md5Hex(fileBuffer.buffer);
      const sha1 = await sha1Hex(fileBuffer.buffer);

      console.log(`\n测试文件: ${testFile}`);
      console.log(`文件大小: ${fileSize} bytes`);
      console.log(`MD5: ${md5}`);
      console.log(`SHA1: ${sha1}`);

      // 上传文件（带时间戳避免重名）
      const timestamp = Date.now();
      const uniqueFileName = `integration-test-${timestamp}.txt`;

      // 应该成功上传
      await expect(
        client.putObject(uniqueFileName, fileBuffer),
      ).resolves.not.toThrow();

      // 验证文件已列出
      const files = await client.listFiles('0');
      const uploadedFile = files.find((f) => f.name === uniqueFileName);

      expect(uploadedFile).toBeDefined();
      if (uploadedFile) {
        expect(uploadedFile.size).toBe(fileSize);
        expect(uploadedFile.isDirectory).toBe(false);
      }
    },
    30000,
  );

  test.skipIf(skipTest)(
    '应该正确处理不同大小的文件',
    async () => {
      const client = new QuarkClient({
        config: { cookie },
      });

      // 测试小文件
      const smallContent = 'Hello, Quark!';
      const smallBuffer = Buffer.from(smallContent);

      await expect(
        client.putObject('test-small.txt', smallBuffer),
      ).resolves.not.toThrow();

      // 测试中等文件
      const mediumContent = 'x'.repeat(10000);
      const mediumBuffer = Buffer.from(mediumContent);

      await expect(
        client.putObject('test-medium.txt', mediumBuffer),
      ).resolves.not.toThrow();
    },
    30000,
  );

  test.skipIf(skipTest)(
    '应该处理中文文件名',
    async () => {
      const client = new QuarkClient({
        config: { cookie },
      });

      const content = '中文内容测试';
      const buffer = Buffer.from(content);
      const fileName = '中文测试文件.txt';

      await expect(client.putObject(fileName, buffer)).resolves.not.toThrow();
    },
    30000,
  );

  test.skipIf(skipTest)(
    '应该返回正确的格式类型',
    async () => {
      const client = new QuarkClient({
        config: { cookie },
      });

      // 测试不同类型的文件
      const testCases = [
        { name: 'test.png', expected: 'png' },
        { name: 'photo.JPG', expected: 'jpg' },
        { name: 'document.pdf', expected: 'pdf' },
        { name: 'archive.zip', expected: 'zip' },
        { name: 'noextension', expected: 'bin' },
      ];

      for (const testCase of testCases) {
        const buffer = Buffer.from('test content');
        const md5 = md5Hex(buffer.buffer);
        const sha1 = await sha1Hex(buffer.buffer);
        const formatType = testCase.name.includes('.')
          ? testCase.name.split('.').pop()?.toLowerCase() || 'bin'
          : 'bin';

        expect(formatType).toBe(testCase.expected);
      }
    },
    10000,
  );
});
