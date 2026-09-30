import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 下 npm workspaces 会把脚本进程 cwd 置为小写盘符(c:\…)，
// vite 按 URL 加载模块时把 c:/ 与 C:/ 视为不同目录，vitest runtime 被加载两份，
// 采集阶段即报 "Cannot read properties of undefined (reading 'config')"。
// 先把盘符规范为大写，再原样转发参数启动解析到的 vitest CLI。
const cwd = process.cwd();
if (cwd[1] === ':' && cwd[0] === cwd[0].toLowerCase()) {
  process.chdir(cwd[0].toUpperCase() + cwd.slice(1));
}

const require = createRequire(fileURLToPath(new URL('./package.json', import.meta.url)));
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  .replace(/^([a-z])(:)/, (_, d, c) => d.toUpperCase() + c);
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
