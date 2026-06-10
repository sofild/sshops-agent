/**
 * resolveConnectionId 测试
 *
 * 覆盖：
 *  - 工具不需要 connectionId 时直接放行
 *  - 真实 id (UUID / conn_token) 形式直接放行
 *  - 缓存命中直接 patch
 *  - alias / host:port / IP → vault 解析 → 自动 connect → patch
 *  - vault disabled → 直接放行（让 mcp-server-ssh 自己报错）
 *  - vault 无匹配 → 直接放行
 *  - getCredential 失败 → 直接放行
 *  - ssh_ssh_connect 返回 isError → 直接放行
 *  - 解析不到 connectionId → 直接放行
 *  - privateKey 认证走 privateKey 字段
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveConnectionId } from '../../src/agent/core.js';
import { resetConfigCache } from '../../src/config/loader.js';

const mockListHosts = vi.fn();
const mockGetCredential = vi.fn();
const mockConnectExecute = vi.fn();

vi.mock('../../src/vault/client.js', () => {
  return {
    getVaultClient: () => ({
      listHosts: mockListHosts,
      getCredential: mockGetCredential,
    }),
  };
});

vi.mock('../../src/tools/registry.js', () => {
  return {
    getToolRegistry: () => ({
      get: () => ({ execute: mockConnectExecute }),
    }),
  };
});

describe('resolveConnectionId', () => {
  beforeEach(() => {
    resetConfigCache();
    mockListHosts.mockReset();
    mockGetCredential.mockReset();
    mockConnectExecute.mockReset();
  });

  it('passes through tools that do not need connectionId', async () => {
    const cache = new Map<string, string>();
    const r = await resolveConnectionId('ssh_ssh_list_connections', {}, cache);
    expect(r.autoConnected).toBe(false);
    expect(r.args).toEqual({});
    expect(cache.size).toBe(0);
  });

  it('passes through ssh_ssh_connect itself (no need to auto-connect recursively)', async () => {
    const cache = new Map<string, string>();
    const r = await resolveConnectionId('ssh_ssh_connect', { host: 'x' }, cache);
    expect(r.autoConnected).toBe(false);
  });

  it('passes through real UUID connectionId without touching vault', async () => {
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: '123e4567-e89b-12d3-a456-426614174000' },
      cache
    );
    expect(r.autoConnected).toBe(false);
    expect(mockListHosts).not.toHaveBeenCalled();
  });

  it('passes through long opaque connectionId without touching vault', async () => {
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'conn_abc123XYZ_xyz' },
      cache
    );
    expect(r.autoConnected).toBe(false);
    expect(mockListHosts).not.toHaveBeenCalled();
  });

  it('returns cached real connectionId on cache hit', async () => {
    const cache = new Map<string, string>();
    cache.set('web1', 'real-uuid-1234');
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'web1' },
      cache
    );
    expect(r.autoConnected).toBe(true);
    expect(r.args.connectionId).toBe('real-uuid-1234');
    expect(mockListHosts).not.toHaveBeenCalled();
  });

  it('auto-connects when given alias and caches the result', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    mockConnectExecute.mockResolvedValue({
      content: JSON.stringify({ id: 'real-uuid-aaaa' }),
      isError: false,
    });
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'web1' },
      cache
    );
    expect(r.autoConnected).toBe(true);
    expect(r.args.connectionId).toBe('real-uuid-aaaa');
    expect(mockConnectExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        password: 'secret123',
      }),
      expect.any(Object)
    );
    expect(cache.get('web1')).toBe('real-uuid-aaaa');
    expect(cache.get('10.0.0.1')).toBe('real-uuid-aaaa');
  });

  it('auto-connects when given host:port string', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    mockConnectExecute.mockResolvedValue({
      content: 'connectionId: real-uuid-bbbb',
      isError: false,
    });
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_exec',
      { connectionId: '10.0.0.1:22', command: 'ls' },
      cache
    );
    expect(r.autoConnected).toBe(true);
    expect(r.args.connectionId).toBe('real-uuid-bbbb');
    expect(r.args.command).toBe('ls');
  });

  it('uses privateKey field for privateKey authType', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'k8s', host: '10.0.0.2', user: 'ubuntu', port: 2222, authType: 'privateKey' },
      ],
    });
    mockGetCredential.mockResolvedValue('---KEY---');
    mockConnectExecute.mockResolvedValue({
      content: '{"connectionId":"real-uuid-cccc"}',
      isError: false,
    });
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'k8s' },
      cache
    );
    expect(r.autoConnected).toBe(true);
    expect(mockConnectExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '10.0.0.2',
        port: 2222,
        username: 'ubuntu',
        privateKey: '---KEY---',
      }),
      expect.any(Object)
    );
  });

  it('uses custom port from host:port string when not 22', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    mockConnectExecute.mockResolvedValue({
      content: '{"id":"real-uuid-dddd"}',
      isError: false,
    });
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: '10.0.0.1:2222' },
      cache
    );
    expect(r.autoConnected).toBe(true);
    expect(mockConnectExecute).toHaveBeenCalledWith(
      expect.objectContaining({ port: 2222 }),
      expect.any(Object)
    );
  });

  it('passes through when vault has no match', async () => {
    mockListHosts.mockResolvedValue({ hosts: [] });
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'unknown-alias' },
      cache
    );
    expect(r.autoConnected).toBe(false);
    expect(r.args.connectionId).toBe('unknown-alias');
  });

  it('passes through when getCredential returns null', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue(null);
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'web1' },
      cache
    );
    expect(r.autoConnected).toBe(false);
    expect(r.args.connectionId).toBe('web1');
  });

  it('passes through when ssh_ssh_connect returns isError', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    mockConnectExecute.mockResolvedValue({
      content: 'authentication failed',
      isError: true,
    });
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'web1' },
      cache
    );
    expect(r.autoConnected).toBe(false);
    expect(r.args.connectionId).toBe('web1');
    expect(cache.size).toBe(0);
  });

  it('passes through when ssh_ssh_connect returns no parseable connectionId', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    mockConnectExecute.mockResolvedValue({
      content: 'random text without connectionId',
      isError: false,
    });
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'web1' },
      cache
    );
    expect(r.autoConnected).toBe(false);
    expect(r.args.connectionId).toBe('web1');
  });

  it('passes through when vault.listHosts throws', async () => {
    mockListHosts.mockRejectedValue(new Error('vault offline'));
    const cache = new Map<string, string>();
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: 'web1' },
      cache
    );
    expect(r.autoConnected).toBe(false);
    expect(r.args.connectionId).toBe('web1');
  });

  it('matches by alias OR by host IP', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    mockConnectExecute.mockResolvedValue({
      content: '{"id":"real-uuid-eeee"}',
      isError: false,
    });
    const cache = new Map<string, string>();
    // LLM passes the IP directly
    const r = await resolveConnectionId(
      'ssh_ssh_system_info',
      { connectionId: '10.0.0.1' },
      cache
    );
    expect(r.autoConnected).toBe(true);
    expect(r.args.connectionId).toBe('real-uuid-eeee');
  });
});
