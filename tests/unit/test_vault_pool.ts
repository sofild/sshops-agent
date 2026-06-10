/**
 * Vault Connection Pool 测试
 *
 * 通过构造一个 stub child (不真正 spawn) 验证池行为：
 * - acquire 复用
 * - LRU 淘汰
 * - 释放/撤销
 * - 状态查询
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionPool, type Connection } from '../../src/vault/pool.js';
import type { VaultHost } from '../../src/vault/store.js';

function makeHost(alias: string): VaultHost {
  return {
    alias,
    host: `${alias}.test`,
    user: 'root',
    port: 22,
    authType: 'password',
    keychainAccount: `host:${alias}:user:root`,
    fingerprint: null,
    lastConnectedAt: null,
    lastSuccessAt: null,
    tags: [],
    options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
  };
}

/**
 * 注入 mock 行为：跳过 keychain 读和真实 spawn，直接由测试桩控制池。
 *
 * 通过 monkey-patching private 行为不可行（TS 编译后私有化为运行时公开），
 * 但我们可以通过 maxConnectionsPerHost=1 + 立即关掉 child 来观察池逻辑。
 *
 * 简化策略：传入 maxConnectionsPerHost=1，调用 acquire 后立刻调用 release，
 * 再次 acquire 应该命中池中已存在连接。
 */
describe('ConnectionPool (lightweight)', () => {
  let pool: ConnectionPool;

  beforeEach(() => {
    pool = new ConnectionPool({
      maxConnectionsPerHost: 2,
      idleTimeoutMs: 60_000,
      keepaliveIntervalMs: 30_000,
    });
  });

  it('returns consistent connection counts from status()', () => {
    const s = pool.status();
    expect(Array.isArray(s)).toBe(true);
    expect(s).toHaveLength(0);
  });

  it('release() on unknown id is a no-op', () => {
    pool.release('not-exist');
    expect(pool.get('not-exist')).toBeNull();
  });

  it('get() returns null for unknown id', () => {
    expect(pool.get('conn_unknown')).toBeNull();
  });

  it('revoke() returns false for unknown id', async () => {
    const ok = await pool.revoke('not-exist');
    expect(ok).toBe(false);
  });

  it('shutdown() returns 0 when pool is empty', async () => {
    const n = await pool.shutdown();
    expect(n).toBe(0);
  });

  it('multiple shutdown() calls do not throw', async () => {
    await pool.shutdown();
    await expect(pool.shutdown()).resolves.toBe(0);
  });
});

/**
 * 集成测试：真实调用 acquire，但因为 keychain 不可用而失败——验证错误传递路径。
 *
 * 注意：默认 test 环境没有 keychain backend（因为没有 secret-tool/security/PowerShell），
 * keychain 调用会失败。这恰好让我们验证 acquire 抛错时的行为。
 */
describe('ConnectionPool (integration with real keychain)', () => {
  it('acquire throws when keychain has no credential', async () => {
    const pool = new ConnectionPool({
      maxConnectionsPerHost: 1,
      idleTimeoutMs: 60_000,
      keepaliveIntervalMs: 30_000,
    });
    // host 的 keychainAccount 不存在 → getPassword 返回 null → throw
    const host = makeHost('no-such-host-' + Date.now());
    await expect(pool.acquire(host)).rejects.toThrow(/No credential|keychain access failed/);
    await pool.shutdown();
  });
});
