/**
 * 四级压缩测试
 */
import { describe, it, expect } from 'vitest';
import {
  snipL1,
  microcompactL2,
  countToolCalls,
  findSafeCut,
  isSafeConversationStart,
} from '../../src/agent/compressor.js';
import type { Message } from '../../src/llm/types.js';
import { resetConfigCache } from '../../src/config/loader.js';

describe('snipL1', () => {
  it('truncates tool_result larger than snipMaxBytes', () => {
    resetConfigCache();
    const big = 'x'.repeat(8000);
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: '1', content: big }],
      },
    ];
    const r = snipL1(messages);
    expect(r.changed).toBe(true);
    const blocks = r.messages[0].content as { type: string; content: string }[];
    expect(blocks[0].content.length).toBeLessThan(big.length);
    expect(blocks[0].content).toContain('[truncated');
  });
});

describe('microcompactL2', () => {
  it('merges consecutive tool_result with same toolUseId', () => {
    resetConfigCache();
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: '1', content: 'a' },
          { type: 'tool_result', toolUseId: '1', content: 'b' },
          { type: 'tool_result', toolUseId: '1', content: 'c' },
        ],
      },
    ];
    const r = microcompactL2(messages);
    expect(r.changed).toBe(true);
    const blocks = r.messages[0].content as { type: string; content: string }[];
    expect(blocks.length).toBe(1);
    expect(blocks[0].content).toContain('a');
    expect(blocks[0].content).toContain('b');
    expect(blocks[0].content).toContain('c');
  });

  it('keeps blocks separate when toolUseId differs', () => {
    resetConfigCache();
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: '1', content: 'a' },
          { type: 'tool_result', toolUseId: '2', content: 'b' },
        ],
      },
    ];
    const r = microcompactL2(messages);
    expect(r.changed).toBe(false);
  });
});

describe('countToolCalls', () => {
  it('counts tool_use blocks in assistant messages', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'a', input: {} },
          { type: 'tool_use', id: '2', name: 'b', input: {} },
        ],
      },
    ];
    expect(countToolCalls(messages)).toBe(2);
  });
});

describe('compaction boundaries', () => {
  const conversation: Message[] = [
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'ssh_ssh_exec', input: { command: 'ls' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', content: 'file-a' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];

  it('treats tool_result-only user messages as unsafe starts', () => {
    expect(isSafeConversationStart(conversation[0])).toBe(true);
    expect(isSafeConversationStart(conversation[1])).toBe(true);
    expect(isSafeConversationStart(conversation[2])).toBe(false);
    expect(isSafeConversationStart(conversation[3])).toBe(true);
  });

  it('moves a requested fold boundary away from a dangling tool_result', () => {
    // 期望从 index 2 开始，但 index 2 是 tool_result → 后移到 assistant(index 3)
    expect(findSafeCut(conversation, 2)).toBe(3);
  });

  it('keeps assistant + tool_result together when the tail ends in a result', () => {
    const tail: Message[] = [
      { role: 'user', content: 'start' },
      conversation[1],
      conversation[2],
    ];
    // 不能从 index 2 开始，否则 tool_result 没有对应的 tool_use
    expect(findSafeCut(tail, 2)).toBe(1);
  });
});
