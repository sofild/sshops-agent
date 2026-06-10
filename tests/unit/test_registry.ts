/**
 * 工具注册表测试
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Tool, ToolContext, ToolResult } from '../../src/tools/types.js';

function makeTool(name: string): Tool {
  return {
    name,
    description: `mock ${name}`,
    inputSchema: { type: 'object' },
    async execute(_args, _ctx): Promise<ToolResult> {
      return { content: `executed ${name}` };
    },
  };
}

describe('ToolRegistry', () => {
  it('register / get / list', () => {
    const r = new ToolRegistry();
    r.register(makeTool('a'));
    r.register(makeTool('b'));
    expect(r.names().sort()).toEqual(['a', 'b']);
    expect(r.get('a').name).toBe('a');
  });
  it('throws on unknown', () => {
    const r = new ToolRegistry();
    expect(() => r.get('x')).toThrow();
  });
  it('execute success', async () => {
    const r = new ToolRegistry();
    r.register(makeTool('a'));
    const res = await r.execute('a', {}, {
      sessionId: 's',
      traceId: 't',
      signal: new AbortController().signal,
    });
    expect(res.content).toBe('executed a');
  });
  it('validates args via zod', () => {
    const r = new ToolRegistry();
    const t: Tool = {
      name: 'a',
      description: 'a',
      inputSchema: { type: 'object' },
      zodSchema: { parse: () => { throw new Error('bad'); } } as never,
      async execute() {
        return { content: '' };
      },
    };
    r.register(t);
    return expect(
      r.execute('a', {}, { sessionId: 's', traceId: 't', signal: new AbortController().signal })
    ).rejects.toThrow();
  });
});
