/**
 * Agent 主循环的模型降级链测试
 *
 * 旧实现中 factory.fallbackToNext() 从未被调用：provider 内部重试耗尽后
 * 直接进入 circuit breaker，配置里的 fallback 链完全无效。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LLMClient, StreamEvent } from '../../src/llm/types.js';

const state = vi.hoisted(() => ({
  current: null as unknown as LLMClient,
  next: null as unknown as LLMClient,
  fallbackCalls: 0,
}));

vi.mock('../../src/llm/factory.js', () => ({
  getLLMClient: () => state.current,
  fallbackToNext: () => {
    state.fallbackCalls += 1;
    if (!state.next) return null;
    const from = state.current.defaultModel;
    const to = state.next.defaultModel;
    state.current = state.next;
    state.next = null as unknown as LLMClient;
    return { from: `mock:${from}`, to: `mock:${to}` };
  },
}));

vi.mock('../../src/session/wal.js', () => ({
  Session: {
    open: () => ({
      append: () => undefined,
      load: () => [],
      close: () => undefined,
    }),
    newId: () => 'test-session',
  },
  listSessions: () => [],
}));

vi.mock('../../src/tools/registry.js', () => ({
  getToolRegistry: () => ({
    list: () => [],
    get: (name: string) => {
      throw new Error(`unexpected tool: ${name}`);
    },
  }),
}));

vi.mock('../../src/permissions/enforcer.js', () => ({
  evaluateToolCall: () => ({ decision: 'allow', reason: 'test-allow' }),
}));

vi.mock('../../src/permissions/audit.js', () => ({
  auditWrite: () => undefined,
  summarize: (s: string, n: number) => (s.length > n ? s.slice(0, n) : s),
}));

vi.mock('../../src/agent/memory.js', () => ({
  allMemoryAsContext: () => '',
  loadMemoryDataSource: () => null,
}));

function makeLLM(
  model: string,
  behavior: 'throw' | 'success'
): LLMClient {
  return {
    providerName: 'mock',
    defaultModel: model,
    contextWindow: 128000,
    countTokens: () => 1,
    async *chat(): AsyncIterable<StreamEvent> {
      if (behavior === 'throw') {
        throw new Error('rate limited (429)');
      }
      yield { type: 'message_start', messageId: 'm1' };
      yield { type: 'text_delta', text: 'fallback ok' };
      yield { type: 'message_end', stopReason: 'end_turn' };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    },
  };
}

describe('agent model fallback', () => {
  beforeEach(() => {
    state.current = makeLLM('primary', 'throw');
    state.next = makeLLM('secondary', 'success');
    state.fallbackCalls = 0;
  });

  it('switches to the fallback model and completes the turn', async () => {
    const { run } = await import('../../src/agent/core.js');
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    for await (const ev of run('hello', { nonInteractive: true })) {
      events.push(ev as { type: string } & Record<string, unknown>);
    }

    const fallback = events.find((e) => e.type === 'fallback');
    expect(fallback).toMatchObject({
      fromModel: 'mock:primary',
      toModel: 'mock:secondary',
    });

    const final = events.find((e) => e.type === 'final') as
      | { answer: string }
      | undefined;
    expect(final?.answer).toBe('fallback ok');
    expect(state.fallbackCalls).toBe(1);
  });
});
