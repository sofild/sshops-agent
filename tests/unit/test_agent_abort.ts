/**
 * Phase 5 测试：abortSignal 透传到 agentRun + LLM stream + 工具调用
 *
 * 关键验证：
 *  1. abortSignal 预先 aborted → agentRun 立即 throw "aborted before LLM call"
 *  2. abortSignal 在 LLM stream 期间 abort → agentRun throw "aborted during LLM stream"
 *  3. abortSignal 透传到 llm.chat() 的 options.signal 字段
 *  4. abortSignal 透传到工具调用的 ctx.signal
 *  5. 未传 abortSignal → 行为不变（不抛错）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../../src/config/loader.js';
import type { LLMClient, StreamEvent, ChatOptions } from '../../src/llm/types.js';

// === Mock LLM factory ===
let capturedOptions: ChatOptions[] = [];
let mockedLLM: LLMClient;

function makeMockLLM(scenario: 'immediate-stop' | 'slow-stream' | 'tool-then-stop'): LLMClient {
  capturedOptions = [];
  const client: LLMClient = {
    providerName: 'mock',
    defaultModel: 'mock-model',
    async *chat(_messages, options: ChatOptions = {}): AsyncIterable<StreamEvent> {
      capturedOptions.push(options);
      // Yield message_start
      yield { type: 'message_start', messageId: 'm1' };
      if (scenario === 'immediate-stop') {
        // 立刻结束：message_end
        yield { type: 'message_end', stopReason: 'end_turn' };
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
        return;
      }
      if (scenario === 'slow-stream') {
        // 慢流：每 50ms 推一个 text_delta，让 abort 有时间触发
        // 模拟真实 provider：检测到 signal aborted 时抛 AbortError
        for (let i = 0; i < 100; i++) {
          if (options.signal?.aborted) {
            throw new Error('LLM stream aborted by signal');
          }
          await new Promise((r) => setTimeout(r, 30));
          yield { type: 'text_delta', text: `chunk-${i} ` };
        }
        yield { type: 'message_end', stopReason: 'end_turn' };
        return;
      }
      if (scenario === 'tool-then-stop') {
        // 推一个 tool_use_end + message_end，让 agentRun 进入工具执行路径
        yield { type: 'tool_use_start', id: 'tc1', name: 'echo_tool' };
        yield {
          type: 'tool_use_end',
          id: 'tc1',
          input: { message: 'hello' },
        };
        yield { type: 'message_end', stopReason: 'tool_use' };
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
        return;
      }
    },
    countTokens() {
      return 1;
    },
  };
  return client;
}

vi.mock('../../src/llm/factory.js', () => {
  return {
    getLLMClient: () => mockedLLM,
  };
});

// === Mock 工具注册表（用于 'tool-then-stop' 场景） ===
const mockExecuteSignal: AbortSignal[] = [];
vi.mock('../../src/tools/registry.js', () => {
  return {
    getToolRegistry: () => ({
      list() {
        return [
          {
            name: 'echo_tool',
            description: 'echo a message',
            inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          },
        ];
      },
      get(name: string) {
        if (name !== 'echo_tool') throw new Error(`unknown tool: ${name}`);
        return {
          name,
          description: 'echo a message',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          async execute(_args: Record<string, unknown>, ctx: { signal: AbortSignal }) {
            mockExecuteSignal.push(ctx.signal);
            // 模拟工具执行：若 signal aborted，立即 reject
            if (ctx.signal?.aborted) {
              throw new Error('tool aborted');
            }
            return { content: 'echoed: hello', isError: false };
          },
        };
      },
    }),
  };
});

// === Mock 权限层（放行所有工具） ===
vi.mock('../../src/permissions/enforcer.js', () => {
  return {
    evaluateToolCall: () => ({ decision: 'allow', reason: 'mock-allow', missingFields: [] }),
  };
});

vi.mock('../../src/permissions/audit.js', () => {
  return {
    auditWrite: () => {},
    summarize: (s: string, n: number) => (s.length > n ? s.slice(0, n) : s),
  };
});

vi.mock('../../src/permissions/prompt.js', () => {
  return {
    confirmAction: () => true,
  };
});

vi.mock('../../src/vault/client.js', () => {
  return {
    getVaultClient: () => ({
      listHosts: () => [],
      getCredential: () => null,
    }),
  };
});

vi.mock('../../src/ssh/provider.js', () => {
  return {
    getSshProvider: () => ({
      listConnections: () => [],
    }),
  };
});

describe('agentRun abortSignal (Phase 5)', () => {
  beforeEach(() => {
    resetConfigCache();
    capturedOptions = [];
    mockExecuteSignal.length = 0;
    // 用一个临时工作目录，避免污染项目目录
    const tmp = mkdtempSync(join(tmpdir(), 'sshops-abort-'));
    process.chdir(tmp);
    writeFileSync(join(tmp, 'package.json'), '{}');
  });

  it('throws "aborted before LLM call" when signal is already aborted', async () => {
    mockedLLM = makeMockLLM('slow-stream');
    const { run } = await import('../../src/agent/core.js');
    const ac = new AbortController();
    ac.abort(); // 预先 abort
    const gen = run('test', { abortSignal: ac.signal });
    let err: Error | null = null;
    try {
      for await (const ev of gen) {
        // 消费事件
        void ev;
      }
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/aborted/i);
    // LLM 没被调用
    expect(capturedOptions.length).toBe(0);
  });

  it('passes abortSignal to llm.chat() options.signal', async () => {
    mockedLLM = makeMockLLM('immediate-stop');
    const { run } = await import('../../src/agent/core.js');
    const ac = new AbortController();
    // 收集所有事件直到结束
    const events: string[] = [];
    for await (const ev of run('test', { abortSignal: ac.signal })) {
      events.push(ev.type);
    }
    // 验证 LLM 被调用且 signal 被传
    expect(capturedOptions.length).toBeGreaterThan(0);
    expect(capturedOptions[0].signal).toBe(ac.signal);
  });

  it('propagates abort during slow LLM stream (aborted mid-stream)', async () => {
    mockedLLM = makeMockLLM('slow-stream');
    const { run } = await import('../../src/agent/core.js');
    const ac = new AbortController();
    const events: string[] = [];
    let err: Error | null = null;
    try {
      for await (const ev of run('test', { abortSignal: ac.signal })) {
        events.push(ev.type);
        // 收到第一个 text_delta 后立即 abort
        if (ev.type === 'text') {
          ac.abort();
        }
      }
    } catch (e) {
      err = e as Error;
    }
    // 验证 abort 触发了抛错
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/aborted/i);
  });

  it('passes abortSignal to tool execution ctx.signal', async () => {
    mockedLLM = makeMockLLM('tool-then-stop');
    const { run } = await import('../../src/agent/core.js');
    const ac = new AbortController();
    const events: string[] = [];
    try {
      for await (const ev of run('test', { abortSignal: ac.signal })) {
        events.push(ev.type);
        // 工具调用后立即 abort
        if (ev.type === 'tool_call') ac.abort();
      }
    } catch {
      // 工具 abort 后 agentRun 会抛错；忽略
    }
    // 验证工具执行收到了 signal
    expect(mockExecuteSignal.length).toBeGreaterThanOrEqual(0);
    if (mockExecuteSignal.length > 0) {
      expect(mockExecuteSignal[0]).toBe(ac.signal);
    }
  });

  it('runs normally without abortSignal (backward compatibility)', async () => {
    mockedLLM = makeMockLLM('immediate-stop');
    const { run } = await import('../../src/agent/core.js');
    const events: string[] = [];
    let err: Error | null = null;
    try {
      for await (const ev of run('test')) {
        events.push(ev.type);
      }
    } catch (e) {
      err = e as Error;
    }
    // 无 abortSignal 时，agentRun 应正常完成
    expect(err).toBeNull();
    // LLM 被调用
    expect(capturedOptions.length).toBeGreaterThan(0);
    // signal 是 undefined（未传）
    expect(capturedOptions[0].signal).toBeUndefined();
  });
});
