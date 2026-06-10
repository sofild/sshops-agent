/**
 * evaluateVaultCredentials 测试
 *
 * v2 行为：
 *  - 只对 ssh_ssh_connect 接管（注入 host/port/username + password/privateKey）
 *  - 其它 ssh 工具（exec / system_info / sftp_*）返回 not_applicable
 *  - 解析 host 找匹配 alias，从 keychain 取凭证
 *  - 失败时映射到 host_not_found / credential_missing / auth_failed / connection_denied / vault_error
 *  - 返回值用 username 字段（v1 误用 user，与 SshProvider 工具签名不一致）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resetConfigCache, PROJECT_ROOT } from '../../src/config/loader.js';
import { evaluateVaultCredentials } from '../../src/agent/core.js';
import { VAULT_ERROR_CODES } from '../../src/vault/types.js';
import { VaultRpcError } from '../../src/vault/types.js';

// memory.ts 用硬编码的 PROJECT_ROOT 写 hosts.md。test_memory 可能在并行 worker
// 里写一条 10.222.10.21，污染这个测试。beforeEach/afterEach 都清掉。
const REAL_HOSTS_MD = resolve(PROJECT_ROOT, 'sessions', 'memory', 'hosts.md');
const REAL_HOSTS_MD_META = REAL_HOSTS_MD + '.meta.json';

const mockListHosts = vi.fn();
const mockGetCredential = vi.fn();

vi.mock('../../src/vault/client.js', () => {
  return {
    getVaultClient: () => ({
      listHosts: mockListHosts,
      getCredential: mockGetCredential,
    }),
  };
});

describe('evaluateVaultCredentials', () => {
  beforeEach(() => {
    resetConfigCache();
    mockListHosts.mockReset();
    mockGetCredential.mockReset();
    // 清理真实 hosts.md（避免被并行 worker 污染导致 fallback 误触发）
    try { if (existsSync(REAL_HOSTS_MD)) unlinkSync(REAL_HOSTS_MD); } catch { /* ignore */ }
    try { if (existsSync(REAL_HOSTS_MD_META)) unlinkSync(REAL_HOSTS_MD_META); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { if (existsSync(REAL_HOSTS_MD)) unlinkSync(REAL_HOSTS_MD); } catch { /* ignore */ }
    try { if (existsSync(REAL_HOSTS_MD_META)) unlinkSync(REAL_HOSTS_MD_META); } catch { /* ignore */ }
  });

  it('returns not_applicable for non-ssh tool', async () => {
    const r = await evaluateVaultCredentials('local_fs_read', { host: 'x' }, ['password']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_applicable');
    }
  });

  it('returns not_applicable for ssh_execute (only connect is handled in v2)', async () => {
    const r = await evaluateVaultCredentials('ssh_ssh_exec', { connectionId: 'x' }, ['command']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_applicable');
    }
  });

  it('returns not_applicable for ssh_ssh_system_info (only connect in v2)', async () => {
    const r = await evaluateVaultCredentials('ssh_ssh_system_info', { connectionId: 'x' }, ['command']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_applicable');
    }
  });

  it('returns not_applicable when missing field is not auth-related', async () => {
    const r = await evaluateVaultCredentials('ssh_ssh_connect', { host: 'x' }, ['command']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not_applicable');
    }
  });

  it('returns host_not_found when no host in args', async () => {
    const r = await evaluateVaultCredentials('ssh_ssh_connect', {}, ['password']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('host_not_found');
    }
  });

  it('returns vault_disabled when config.vault.enabled=false', async () => {
    const configMod = await import('../../src/config/loader.js');
    const spy = vi.spyOn(configMod, 'getConfig').mockReturnValue({
      ...configMod.getConfig(),
      vault: { ...configMod.getConfig().vault, enabled: false },
    });
    const r = await evaluateVaultCredentials('ssh_ssh_connect', { host: 'h' }, ['password']);
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('vault_disabled');
    }
  });

  it('returns host_not_found when alias/ip not in vault', async () => {
    mockListHosts.mockResolvedValue({ hosts: [] });
    const r = await evaluateVaultCredentials('ssh_ssh_connect', { host: '10.0.0.99' }, ['password']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('host_not_found');
      expect(r.alias).toBe('10.0.0.99');
    }
  });

  it('injects password on success (matches by IP)', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: '10.0.0.1' },
      ['password']
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe('10.0.0.1');
      expect(r.username).toBe('root');
      expect(r.authType).toBe('password');
      // v2: credentialPatch 必须包含 host/port/username + 凭证（不止 password）
      expect(r.credentialPatch).toEqual({
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        password: 'secret123',
      });
    }
    expect(mockGetCredential).toHaveBeenCalledWith({ alias: 'web1' });
  });

  it('injects privateKey on success when authType=privateKey', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'ubuntu', port: 22, authType: 'privateKey' },
      ],
    });
    mockGetCredential.mockResolvedValue('---KEY---');
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['privateKey']
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.credentialPatch).toEqual({
        host: '10.0.0.1',
        port: 22,
        username: 'ubuntu',
        privateKey: '---KEY---',
      });
    }
  });

  it('matches by alias', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password']
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe('10.0.0.1');
    }
  });

  it('returns credential_missing when getCredential returns null', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue(null);
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password']
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('credential_missing');
    }
  });

  it('maps CREDENTIAL_MISSING error to credential_missing reason', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockRejectedValue(
      new VaultRpcError(VAULT_ERROR_CODES.CREDENTIAL_MISSING, 'no cred', null)
    );
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password']
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('credential_missing');
      expect(r.alias).toBe('web1');
    }
  });

  it('maps AUTH_FAILED error to auth_failed reason', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockRejectedValue(
      new VaultRpcError(VAULT_ERROR_CODES.AUTH_FAILED, 'auth fail', null)
    );
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password']
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('auth_failed');
    }
  });

  it('maps CONNECTION_DENIED error to connection_denied reason', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockRejectedValue(
      new VaultRpcError(VAULT_ERROR_CODES.CONNECTION_DENIED, 'denied by policy', null)
    );
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password']
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('connection_denied');
    }
  });

  it('maps unknown error to vault_error reason', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockRejectedValue(new Error('boom'));
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password']
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('vault_error');
      expect(r.error).toContain('boom');
    }
  });

  // ============ Phase 2 增强：模糊匹配 / 端口剥离 / 大小写不敏感 ============

  it('matches by alias case-insensitively (Phase 2)', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'WEB1' },  // 大写
      ['password']
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe('10.0.0.1');
    }
  });

  it('matches host with trailing :port (Phase 2)', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: '10.0.0.1:22' },  // 带端口
      ['password']
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe('10.0.0.1');
    }
  });

  it('matches host with surrounding whitespace (Phase 2)', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: '  10.0.0.1  ' },  // 带空格
      ['password']
    );
    expect(r.ok).toBe(true);
  });

  it('triggers on username missing too (Phase 2 wider authMissing)', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    // 缺 username 字段（不是 password|privateKey）
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: '10.0.0.1' },
      ['username']
    );
    expect(r.ok).toBe(true);
  });

  it('falls back to hosts.md unique IP when args.host missing (Phase 2)', async () => {
    // 先确保 real hosts.md 是干净的（beforeEach 已清，这里双保险）
    try { if (existsSync(REAL_HOSTS_MD)) unlinkSync(REAL_HOSTS_MD); } catch { /* ignore */ }
    // 再写入 hosts.md 一条孤儿 IP
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '10.0.0.1');
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.0.0.1', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');
    // args 里没 host
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      {},
      ['password']
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.host).toBe('10.0.0.1');
    }
    // 清理
    mem.forget('hosts');
  });
});
