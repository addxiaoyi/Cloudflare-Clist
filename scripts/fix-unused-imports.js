import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function run(command, cwd = '/workspace') {
  return execSync(command, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const output = run('npm run lint 2>&1');

const warnings = output.split('\n').filter((line) => line.includes('warning'));
const files = new Map();

for (const line of warnings) {
  const match = line.match(/(app\/[^:]+):\d+:\d+.*no-unused-vars/);
  if (match) {
    const file = match[1];
    files.set(file, (files.get(file) || 0) + 1);
  }
}

const sorted = [...files.entries()].sort((a, b) => b[1] - a[1]);

for (const [file, count] of sorted) {
  console.log(`${file}: ${count} unused-var warnings`);
}

console.log(`\nTotal files with no-unused-vars: ${sorted.length}`);
console.log(
  `Total no-unused-vars warnings: ${sorted.reduce((sum, [, c]) => sum + c, 0)}`,
);
