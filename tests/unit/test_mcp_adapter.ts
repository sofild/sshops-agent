/**
 * MCP Adapter 测试（mock client）
 */
import { describe, it, expect, vi } from 'vitest';
import { adaptMcpTools } from '../../src/tools/mcp/adapter.js';
import type { MCPClient } from '../../src/tools/mcp/client.js';

function makeMockClient(serverName: string, behavior: (name: string, args: Record<string, unknown>) => Promise<unknown>): MCPClient {
  return {
    serverName,
    callTool: vi.fn(async (name, args) => behavior(name, args as Record<string, unknown>)),
  } as unknown as MCPClient;
}

describe('adaptMcpTools', () => {
  it('wraps descriptors as Tool and namespaces names', async () => {
    const client = makeMockClient('ssh', async () => ({ content: [{ type: 'text', text: 'hello' }] }));
    const tools = adaptMcpTools(client, [
      {
        name: 'ssh_execute',
        description: 'execute a command',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('ssh_ssh_execute');
    const r = await tools[0].execute(
      { command: 'ls' },
      { sessionId: 's', traceId: 't', signal: new AbortController().signal }
    );
    expect(r.content).toBe('hello');
    expect(r.isError).toBeFalsy();
  });

  it('captures errors gracefully', async () => {
    const client = makeMockClient('ssh', async () => {
      throw new Error('boom');
    });
    const tools = adaptMcpTools(client, [
      { name: 'ssh_execute', description: 'd', inputSchema: { type: 'object' } },
    ]);
    const r = await tools[0].execute(
      {},
      { sessionId: 's', traceId: 't', signal: new AbortController().signal }
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('boom');
  });
});
