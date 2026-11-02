/**
 * OpenAI Chat Completions 消息协议转换测试
 *
 * 覆盖旧实现的核心缺陷：tool_result 被丢弃，导致 OpenAI / DeepSeek /
 * Ollama 等兼容 provider 的多步工具循环看不到工具观测结果。
 */
import { describe, it, expect } from 'vitest';
import { convertMessages } from '../../src/llm/providers/openai-messages.js';
import type { Message } from '../../src/llm/types.js';

describe('convertMessages (OpenAI protocol)', () => {
  it('encodes tool_result as role=tool messages and keeps trailing user text', () => {
    const messages: Message[] = [
      { role: 'user', content: '帮我检查两台机器' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '开始执行' },
          { type: 'tool_use', id: 'call_a', name: 'ssh_ssh_exec', input: { command: 'uptime' } },
          { type: 'tool_use', id: 'call_b', name: 'ssh_ssh_exec', input: { command: 'df -h' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_a', content: 'up 2 days' },
          { type: 'tool_result', toolUseId: 'call_b', content: 'permission denied', isError: true },
          { type: 'text', text: '请谨慎判断上述错误' },
        ],
      },
    ];

    const out = convertMessages(messages);

    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ role: 'user', content: '帮我检查两台机器' });

    expect(out[1]).toMatchObject({
      role: 'assistant',
      content: '开始执行',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'ssh_ssh_exec' } },
        { id: 'call_b', type: 'function', function: { name: 'ssh_ssh_exec' } },
      ],
    });
    const assistant = out[1] as { tool_calls: Array<{ function: { arguments: string } }> };
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({
      command: 'uptime',
    });

    // 关键断言：工具结果不再丢失
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'up 2 days' });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_b', content: 'permission denied' });

    // tool 消息必须在 user 文本之前
    expect(out[4]).toEqual({ role: 'user', content: '请谨慎判断上述错误' });
  });

  it('downgrades orphan tool_result to user text instead of emitting invalid tool message', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'missing', content: 'stale output' }],
      },
    ];

    const out = convertMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect((out[0] as { content: string }).content).toContain('stale output');
    expect(out[0].role).not.toBe('tool');
  });

  it('synthesizes tool messages for unanswered tool calls before user text', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'probe', input: {} },
          { type: 'tool_use', id: 'c2', name: 'probe', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'only one' }],
      },
      { role: 'user', content: '继续' },
    ];

    const out = convertMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(out[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'c2',
    });
    expect(String((out[2] as { content: string }).content)).toContain(
      'no tool result recorded'
    );
    expect(out[3]).toEqual({ role: 'user', content: '继续' });
  });

  it('drops empty assistant messages that would be invalid for OpenAI', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];
    const out = convertMessages(messages);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'assistant', content: 'hello' });
  });

  it('handles assistant messages with only tool calls (content=null)', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'probe', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }],
      },
    ];

    const out = convertMessages(messages);
    expect(out[0]).toMatchObject({ role: 'assistant', content: null });
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });
});
