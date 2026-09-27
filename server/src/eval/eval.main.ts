import { writeFileSync } from 'fs';
import { io } from 'socket.io-client';
import { judgeCase } from './eval.matcher';
import { CaseOutcome, runDataset } from './eval.runner';

/**
 * 金标评估 CLI 入口(issue #58 PR2)。
 * 用法:先启动 server(任意 provider),再
 *   node dist/eval/eval.main.js --url http://localhost:3000/agent [--out report.json]
 * 环境变量:EVAL_BASE_URL / EVAL_TIMEOUT_MS(单题超时,默认与 LLM 超时同 180s)。
 * 退出码:全部 PASS=0,存在 FAIL=1(供 CI/回归脚本使用)。
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = arg('url') ?? process.env.EVAL_BASE_URL ?? 'http://localhost:3000/agent';
  const timeoutMs = Number(process.env.EVAL_TIMEOUT_MS ?? 180000);
  const out = arg('out') ?? process.env.EVAL_OUT;

  const sock = io(url, { path: '/ws', transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('connect_error', (e) => reject(new Error(`连接 ${url} 失败: ${e.message}(server 是否已启动?)`)));
  });
  console.log(`[eval] 已连接 ${url},单题超时 ${timeoutMs}ms`);

  const t0 = Date.now();
  const outcomes: CaseOutcome[] = await runDataset(sock, timeoutMs, judgeCase, (line) => console.log(line));
  const failed = outcomes.filter((o) => !o.pass);
  const byCategory: Record<string, { total: number; pass: number }> = {};
  for (const o of outcomes) {
    const c = (byCategory[o.category] ??= { total: 0, pass: 0 });
    c.total++;
    if (o.pass) c.pass++;
  }
  console.log('\n===== 金标评估汇总 =====');
  for (const [cat, v] of Object.entries(byCategory).sort()) {
    console.log(`${cat.padEnd(11)} ${v.pass}/${v.total}`);
  }
  console.log(`总计 ${outcomes.length - failed.length}/${outcomes.length} PASS,用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.reasons.join('; ')}`);

  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), url, total: outcomes.length, pass: outcomes.length - failed.length, byCategory, outcomes }, null, 2));
    console.log(`报告已写入 ${out}`);
  }
  sock.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[eval] 运行失败:', (e as Error).message);
  process.exit(2);
});
