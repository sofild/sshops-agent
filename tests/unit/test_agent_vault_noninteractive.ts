/**
 * 非交互模式下 vault 注入顺序测试
 *
 * 旧实现在 confirm 分支里先判断 nonInteractive，导致 CI / pipe 模式
 * 永远走不到 vault 自动注入；即使 keychain 里有凭证也会被直接拒绝。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LLMClient, StreamEvent } from '../../src/llm/types.js';

const state = vi.hoisted(() => ({
  calls: 0,
  connectArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/llm/factory.js', () => ({
  getLLMClient: () => llm,
  fallbackToNext: () => null,
}));

vi.mock('../../src/session/wal.js', () => ({
  Session: {
    open: () => ({ append: () => undefined, load: () => [], close: () => undefined }),
    newId: () => 'vault-test',
  },
  listSessions: () => [],
}));

vi.mock('../../src/vault/client.js', () => ({
  getVaultClient: () => ({
    listHosts: async () => ({
      hosts: [
        {
          alias: 'web1',
          host: '10.0.0.1',
          user: 'root',
          port: 22,
          authType: 'password',
        },
      ],
    }),
    getCredential: async () => 'secret123',
  }),
}));

vi.mock('../../src/tools/registry.js', () => ({
  getToolRegistry: () => ({
    list: () => [
      {
        name: 'ssh_ssh_connect',
        description: 'connect',
        inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
      },
    ],
    get: (name: string) => {
      if (name !== 'ssh_ssh_connect') throw new Error(`unknown tool: ${name}`);
      return {
        name,
        description: 'connect',
        inputSchema: { type: 'object', properties: {} },
        async execute(args: Record<string, unknown>) {
          state.connectArgs.push(args);
          return { content: 'connected', isError: false };
        },
      };
    },
  }),
}));

// 模拟“缺 username/password”的权限决策；真实 enforcer 在缺字段时返回 confirm
vi.mock('../../src/permissions/enforcer.js', () => ({
  evaluateToolCall: () => ({
    decision: 'confirm',
    reason: 'missing required field(s)',
    missingFields: ['username', 'password|privateKey|privateKeyPath'],
  }),
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
  async *chat(): AsyncIterable<StreamEvent> {
    state.calls += 1;
    yield { type: 'message_start', messageId: `m${state.calls}` };
    if (state.calls === 1) {
      yield { type: 'tool_use_start', id: 'c1', name: 'ssh_ssh_connect' };
      yield {
        type: 'tool_use_end',
        id: 'c1',
        name: 'ssh_ssh_connect',
        input: { host: '10.0.0.1' },
      };
      yield { type: 'message_end', stopReason: 'tool_use' };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      return;
    }
    yield { type: 'text_delta', text: 'connected ok' };
    yield { type: 'message_end', stopReason: 'end_turn' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
  },
};

describe('non-interactive vault injection', () => {
  beforeEach(() => {
    state.calls = 0;
    state.connectArgs = [];
  });

  it('injects vault credentials before applying the non-interactive denial', async () => {
    const { run } = await import('../../src/agent/core.js');
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    for await (const ev of run('connect 10.0.0.1', { nonInteractive: true })) {
      events.push(ev as { type: string } & Record<string, unknown>);
    }

    expect(state.connectArgs).toHaveLength(1);
    expect(state.connectArgs[0]).toMatchObject({
      host: '10.0.0.1',
      username: 'root',
      password: 'secret123',
    });
    expect(events.some((e) => e.type === 'tool_denied')).toBe(false);
    const final = events.find((e) => e.type === 'final') as { answer: string } | undefined;
    expect(final?.answer).toBe('connected ok');
  });
});
