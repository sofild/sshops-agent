/**
 * Agent 工具循环端到端（mock LLM）
 *
 * 验证：assistant.tool_use → 执行工具 → tool_result 回灌给模型 → 最终回答。
 * 这类测试是旧测试集的空白；OpenAI tool_result 丢失正是因为没有 loop 级测试。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LLMClient, Message, StreamEvent } from '../../src/llm/types.js';

const state = vi.hoisted(() => ({
  calls: 0,
  messagesSeen: [] as Message[][],
}));

vi.mock('../../src/llm/factory.js', () => ({
  getLLMClient: () => llm,
  fallbackToNext: () => null,
}));

vi.mock('../../src/session/wal.js', () => ({
  Session: {
    open: () => ({ append: () => undefined, load: () => [], close: () => undefined }),
    newId: () => 'loop-test',
  },
  listSessions: () => [],
}));

vi.mock('../../src/tools/registry.js', () => ({
  getToolRegistry: () => ({
    list: () => [
      {
        name: 'echo_tool',
        description: 'echo',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ],
    get: (name: string) => {
      if (name !== 'echo_tool') throw new Error(`unknown tool: ${name}`);
      return {
        name,
        description: 'echo',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        async execute(args: Record<string, unknown>) {
          return { content: `echoed: ${String(args.message)}`, isError: false };
        },
      };
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

const llm: LLMClient = {
  providerName: 'mock',
  defaultModel: 'mock-model',
  contextWindow: 128000,
  countTokens: () => 1,
  async *chat(messages: Message[]): AsyncIterable<StreamEvent> {
    state.calls += 1;
    state.messagesSeen.push(messages);
    yield { type: 'message_start', messageId: `m${state.calls}` };

    if (state.calls === 1) {
      yield { type: 'tool_use_start', id: 't1', name: 'echo_tool' };
      yield { type: 'tool_use_end', id: 't1', name: 'echo_tool', input: { message: 'hello' } };
      yield { type: 'message_end', stopReason: 'tool_use' };
      yield { type: 'usage', inputTokens: 20, outputTokens: 5 };
      return;
    }

    yield { type: 'text_delta', text: 'done' };
    yield { type: 'message_end', stopReason: 'end_turn' };
    yield { type: 'usage', inputTokens: 30, outputTokens: 5 };
  },
};

describe('agent tool loop', () => {
  beforeEach(() => {
    state.calls = 0;
    state.messagesSeen = [];
  });

  it('round-trips tool_result back into the next LLM request', async () => {
    const { run } = await import('../../src/agent/core.js');
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    for await (const ev of run('echo hello', { nonInteractive: true })) {
      events.push(ev as { type: string } & Record<string, unknown>);
    }

    expect(state.calls).toBe(2);
    const secondRequest = state.messagesSeen[1];
    const last = secondRequest[secondRequest.length - 1];
    expect(last.role).toBe('user');
    const blocks = last.content as Array<Record<string, unknown>>;
    const toolResult = blocks.find((b) => b.type === 'tool_result');
    expect(toolResult).toMatchObject({
      toolUseId: 't1',
      content: 'echoed: hello',
      isError: false,
    });

    const final = events.find((e) => e.type === 'final') as { answer: string } | undefined;
    expect(final?.answer).toBe('done');
  });
});
