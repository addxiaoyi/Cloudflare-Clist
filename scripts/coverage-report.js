#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const coverageDir = './coverage';
const finalPath = path.join(coverageDir, 'coverage-final.json');

if (!fs.existsSync(finalPath)) {
  console.error(
    'Coverage final JSON not found. Run npm run test:coverage first.',
  );
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(finalPath, 'utf-8'));
let lines = 0,
  linesHit = 0;
let functions = 0,
  functionsHit = 0;
let statements = 0,
  statementsHit = 0;
let branches = 0,
  branchesHit = 0;

for (const file of Object.values(data)) {
  const summary = file;
  lines += summary.lines.found;
  linesHit += summary.lines.found - summary.lines.uncovered;
  functions += summary.functions.found;
  functionsHit += summary.functions.found - summary.functions.uncovered;
  statements += summary.statements.found;
  statementsHit += summary.statements.found - summary.statements.uncovered;
  branches += summary.branches.found;
  branchesHit += summary.branches.found - (summary.branches.uncovered || 0);
}

const pct = (found, hit) => (found === 0 ? 0 : Math.round((hit / found) * 100));

console.log('Coverage Report');
console.log('===============');
console.log(`Lines:     ${pct(lines, linesHit)}%`);
console.log(`Statements: ${pct(statements, statementsHit)}%`);
console.log(`Functions: ${pct(functions, functionsHit)}%`);
console.log(`Branches:  ${pct(branches, branchesHit)}%`);
