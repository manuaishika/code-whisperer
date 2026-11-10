// Cross-platform test runner: lists out/test/*.test.js itself, because `node --test <glob>` is only
// expanded by Node 21+ and PowerShell/cmd don't expand globs at all.
const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const dir = join(__dirname, '..', 'out', 'test');
let files = [];
try {
    files = readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => join(dir, f));
} catch {
    /* handled below */
}
if (files.length === 0) {
    console.error(`No compiled tests found in ${dir}. Run "npm run compile" first.`);
    process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
