import { Logger } from '@nestjs/common';
import { ChatOptions, LLMProvider, Msg } from './llm.types';
import { AbortedError } from './http';

export interface FallbackOptions {
  /** 同一 provider 连续失败多少次后开熔断(暂时跳过它)。 */
  circuitFailures: number;
  /** 熔断冷却毫秒数,到期后放行一次探测。 */
  circuitCooldownMs: number;
}

interface Member {
  provider: LLMProvider;
  failures: number;
  /** 熔断恢复时刻(ms epoch);0 表示关闭(可用)。 */
  openUntil: number;
}

/** 一次调用是否允许改投下一个 provider。 */
interface Leg {
  run: (provider: LLMProvider) => Promise<string>;
  /** false 表示已经向客户端吐出内容,再切换会造成重复输出,只能就地失败。 */
  failoverOk: () => boolean;
}

/**
 * 降级链包装(issue #60):按给定次序 siliconflow → ollama → mock 依次尝试,
 * 前一家失败就改投下一家,mock 兜底保证 demo 不会变成砖。
 *
 * 三条边界:
 * - 用户取消 / 上层超时(AbortedError)不降级,链立即中断;
 * - 流式一旦已吐 token 就不再切换 provider,避免前端出现重复内容;
 * - embed 不串门:各家向量维度不同(如 bge-m3=1024、mock=256),换 embedder 会
 *   污染已建索引,故 embedding 固定走链首,失败即由 RAG 层自行降级。
 */
export class FallbackProvider implements LLMProvider {
  /** 对外以链首身份出现,便于上层判断"是否发生了降级"。 */
  readonly name: string;

  private readonly members: Member[];
  private readonly logger = new Logger('LLMFallback');
  private served?: string;

  constructor(chain: LLMProvider[], private readonly opts: FallbackOptions) {
    if (chain.length === 0) throw new Error('降级链至少需要一个 provider');
    this.members = chain.map((provider) => ({ provider, failures: 0, openUntil: 0 }));
    this.name = chain[0].name;
  }

  /** 最近一次真正承接请求的厂商;尚无请求时按熔断状态预估。 */
  activeProvider(): string {
    if (this.served) return this.served;
    return this.healthy()[0]?.provider.name ?? this.name;
  }

  async chat(messages: Msg[], options?: ChatOptions): Promise<string> {
    return this.through({
      run: (p) => p.chat(messages, options),
      failoverOk: () => true,
    });
  }

  async stream(
    messages: Msg[],
    onToken: (token: string) => void,
    options?: ChatOptions,
  ): Promise<string> {
    let emitted = false;
    return this.through({
      run: (p) =>
        p.stream(messages, (token) => (emitted = true, onToken(token)), options),
      failoverOk: () => !emitted,
    });
  }

  /** embedding 不参与降级,理由见类注释。 */
  embed(texts: string[]): Promise<number[][]> {
    return this.members[0].provider.embed(texts);
  }

  /** 按"熔断关闭者优先、原次序保留"的顺序给出可用成员。 */
  private healthy(now = Date.now()): Member[] {
    const awake = this.members.filter((m) => m.openUntil <= now);
    return awake.length ? awake : this.members;
  }

  private async through(leg: Leg): Promise<string> {
    const tried: string[] = [];
    let last: unknown;
    for (const member of this.healthy()) {
      const { provider } = member;
      try {
        const out = await leg.run(provider);
        this.markOk(member, provider.name, tried);
        return out;
      } catch (err) {
        if (err instanceof AbortedError) throw err; // 取消/超时不是降级信号
        last = err;
        tried.push(provider.name);
        this.markFail(member, err, leg.failoverOk());
        if (!leg.failoverOk()) break;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private markOk(member: Member, name: string, tried: string[]): void {
    member.failures = 0;
    member.openUntil = 0;
    this.served = name;
    if (tried.length) this.logger.warn(`LLM 已降级承接:${tried.join(' → ')} → ${name}`);
  }

  private markFail(member: Member, err: unknown, canFailover: boolean): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`LLM ${member.provider.name} 调用失败:${message}`);
    if (!canFailover) return; // 流式已吐字,不是 provider 的锅,不计入熔断
    member.failures += 1;
    if (member.failures >= this.opts.circuitFailures) {
      member.openUntil = Date.now() + this.opts.circuitCooldownMs;
      this.logger.warn(
        `LLM ${member.provider.name} 连续失败 ${member.failures} 次,熔断 ${this.opts.circuitCooldownMs}ms`,
      );
    }
  }
}
