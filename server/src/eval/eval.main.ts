import { mkdirSync } from 'fs';
import { join } from 'path';
import { io } from 'socket.io-client';
import { buildReport, compareToBaseline, findBaseline, formatDiff, readReport, writeReport, BASELINE_DIR } from './eval.baseline';
import { judgeCase } from './eval.matcher';
import { runDataset } from './eval.runner';
import { loadDataset } from './eval.types';

/**
 * 金标评估 CLI 入口(issue #58 PR2/PR3)。
 * 用法:先启动 server(任意 provider),再
 *   node dist/eval/eval.main.js --url http://localhost:3000/agent [--out report.json]
 *     [--update-baseline]  本轮结果写为新基线(存 server/src/eval/baseline/)
 *     [--baseline file]    指定对比的基线文件(缺省自动找 baseline/ 下最新;都没有则不对比)
 * 环境变量:EVAL_BASE_URL / EVAL_TIMEOUT_MS(单题超时,默认 180s)。
 * 退出码:无回归=0,存在回归或 FAIL=1,连接失败=2。
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = arg('url') ?? process.env.EVAL_BASE_URL ?? 'http://localhost:3000/agent';
  const timeoutMs = Number(process.env.EVAL_TIMEOUT_MS ?? 180000);
  const out = arg('out') ?? process.env.EVAL_OUT;
  const updateBaseline = process.argv.includes('--update-baseline');
  const baselineFile = arg('baseline') ?? findBaseline();

  const sock = io(url, { path: '/ws', transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('connect_error', (e) => reject(new Error(`连接 ${url} 失败: ${e.message}(server 是否已启动?)`)));
  });
  console.log(`[eval] 已连接 ${url},单题超时 ${timeoutMs}ms`);

  const t0 = Date.now();
  const outcomes = await runDataset(sock, timeoutMs, judgeCase, (line) => console.log(line));
  const failed = outcomes.filter((o) => !o.pass);
  const report = buildReport(outcomes, {
    url,
    provider: process.env.LLM_PROVIDER,
    datasetVersion: loadDataset().version,
  });
  console.log('\n===== 金标评估汇总 =====');
  for (const [cat, v] of Object.entries(report.byCategory).sort()) {
    console.log(`${cat.padEnd(11)} ${v.pass}/${v.total}`);
  }
  console.log(`总计 ${report.pass}/${report.total} PASS,用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.reasons.join('; ')}`);

  let regressions = failed.length;
  if (baselineFile) {
    const diff = compareToBaseline(report, readReport(baselineFile));
    console.log('\n===== 与基线对比(' + baselineFile + ') =====');
    console.log(formatDiff(report, diff));
    regressions = diff.regressions.length;
  } else {
    console.log('(无基线可对比,退出码按本轮 FAIL 计)');
  }
  if (updateBaseline) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    const file = join(BASELINE_DIR, `baseline-${new Date().toISOString().slice(0, 10)}.json`);
    writeReport(file, report);
    console.log(`基线已更新: ${file}`);
  }
  if (out) {
    writeReport(out, report);
    console.log(`报告已写入 ${out}`);
  }
  sock.close();
  process.exit(regressions === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[eval] 运行失败:', (e as Error).message);
  process.exit(2);
});
