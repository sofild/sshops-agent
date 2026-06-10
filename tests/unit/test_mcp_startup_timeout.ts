/**
 * MCP 客户端启动超时 + 清理行为测试
 *
 * 验证：
 *  1. 超时后 transport.close() 被调用
 *  2. 超时后 child 进程被 SIGKILL（防止 EPIPE）
 *  3. connect() 失败后 child 进程被 SIGKILL
 *  4. 把 { timeout } 传给 client.connect() 以覆盖 SDK 默认 60s
 */
import { describe, it, expect, vi } from 'vitest';

// 用 vi.mock 在模块加载时替换整个 SDK 实现
const closeSpy = vi.fn().mockResolvedValue(undefined);
const killSpy = vi.fn();
const connectSpy = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: connectSpy.mockImplementation(() => new Promise(() => {})), // 永远不 resolve
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    close: closeSpy,
    _process: {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: killSpy,
      killed: false,
      pid: 12345,
    },
  })),
}));

describe('MCPClient connect timeout cleanup', () => {
  it('calls transport.close() and SIGKILL child after startup timeout', async () => {
    const { MCPClient } = await import('../../src/tools/mcp/client.js');
    const client = new MCPClient('test-ssh', {
      type: 'stdio',
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      env: {},
      toolCacheTtlMs: 600000,
      startupTimeoutMs: 100,
      callTimeoutMs: 1000,
    });

    await expect(client.connect()).rejects.toThrow(/startup timeout/);
    expect(closeSpy).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
  });

  it('passes startupTimeoutMs to client.connect() to override SDK 60s default', async () => {
    connectSpy.mockClear();
    closeSpy.mockClear();
    killSpy.mockClear();
    const { MCPClient } = await import('../../src/tools/mcp/client.js');
    const client = new MCPClient('test-ssh-2', {
      type: 'stdio',
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      env: {},
      toolCacheTtlMs: 600000,
      startupTimeoutMs: 250,
      callTimeoutMs: 1000,
    });

    // 让它跑 300ms 让我们的 wrapper timeout 触发
    await expect(client.connect()).rejects.toThrow(/startup timeout/);

    // 验证 connect() 被传了 { timeout: 250 }
    expect(connectSpy).toHaveBeenCalled();
    const callArgs = connectSpy.mock.calls[0];
    // 第二个参数是 options
    expect(callArgs[1]).toBeDefined();
    expect(callArgs[1]?.timeout).toBe(250);
    expect(callArgs[1]?.maxTotalTimeout).toBe(250);
  });
});
