/**
 * 夸克上传功能实际测试脚本（适用于 Node.js）
 * 使用方法：提供有效的夸克 Cookie
 */

import { QuarkClient } from './app/lib/quark-client.js';
import { md5Hex, sha1Hex } from './app/lib/md5.js';
import { createReadStream, statSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 配置 - 需要用户填写
const CONFIG = {
  // 从浏览器开发者工具获取夸克 Cookie
  cookie: process.env.QUARK_COOKIE || '',
  // 目标文件夹的 fid（0 表示根目录）
  parentId: process.env.QUARK_PARENT_ID || '0',
  // 测试文件路径
  testFile: process.env.TEST_FILE || resolve(__dirname, '../upload-tests/test1.txt'),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testUpload() {
  console.log('='.repeat(60));
  console.log('夸克上传功能实际测试');
  console.log('='.repeat(60));

  if (!CONFIG.cookie) {
    console.error('错误：请设置 QUARK_COOKIE 环境变量');
    console.error('从浏览器开发者工具复制完整的 Cookie 字符串');
    console.error('');
    console.error('示例：');
    console.error('  QUARK_COOKIE="your_cookie_here" node scripts/test-upload-cjs.mjs');
    process.exit(1);
  }

  const client = new QuarkClient({ config: { cookie: CONFIG.cookie } });

  console.log('\n[1] 读取测试文件...');
  let fileBuffer;
  try {
    fileBuffer = readFileSync(CONFIG.testFile);
    console.log(`   ✓ 文件大小: ${fileBuffer.length} bytes`);
  } catch (err) {
    console.error(`   ✗ 无法读取文件: ${CONFIG.testFile}`);
    console.error('   错误:', err.message);
    process.exit(1);
  }

  console.log('\n[2] 计算文件哈希...');
  const md5 = md5Hex(fileBuffer.buffer);
  const sha1 = await sha1Hex(fileBuffer.buffer);
  console.log(`   MD5: ${md5}`);
  console.log(`   SHA1: ${sha1}`);

  console.log('\n[3] 测试上传文件...');
  const fileName = CONFIG.testFile.split('/').pop() || 'test.txt';
  const targetPath = `${CONFIG.parentId}/${fileName}`;
  const timestamp = Date.now();
  const uniqueFileName = `test-${timestamp}-${fileName}`;

  try {
    console.log(`   上传到: ${uniqueFileName}`);
    await client.putObject(uniqueFileName, fileBuffer);
    console.log('   ✓ 上传成功！');
  } catch (err) {
    console.error('   ✗ 上传失败:', err.message);
    console.log('\n   详细错误信息:');
    console.log(JSON.stringify(err, null, 2));
    process.exit(1);
  }

  console.log('\n[4] 验证文件列表...');
  try {
    const files = await client.listFiles(CONFIG.parentId);
    console.log('   ✓ 成功获取文件列表');
    console.log(`   文件夹中有 ${files.length} 个文件/文件夹`);

    const uploadedFile = files.find((f) => f.name === uniqueFileName);
    if (uploadedFile) {
      console.log(`   ✓ 找到上传的文件: ${uploadedFile.name}`);
      console.log(`     大小: ${uploadedFile.size} bytes`);
      console.log(`     类型: ${uploadedFile.isDirectory ? '文件夹' : '文件'}`);
    } else {
      console.warn('   ⚠ 未在列表中找到上传的文件（可能延迟或路径问题）');
    }
  } catch (err) {
    console.warn('   ⚠ 无法验证文件列表:', err.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('测试完成！');
  console.log('='.repeat(60));
}

// 运行测试
testUpload().catch((err) => {
  console.error('\n测试失败:', err);
  process.exit(1);
});
