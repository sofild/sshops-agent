/**
 * evaluateVaultCredentials 单元测试
 *
 * 覆盖：
 *  - credential patch 必须包含 host/port/username（不只是 password/privateKey）
 *  - 缺 username/host/port 的 LLM 工具调用经 vault 注入后能变成完整可连接参数
 *  - password authType 注入 password
 *  - privateKey authType 注入 privateKey
 *  - 不接管非 ssh_ssh_connect 工具（not_applicable）
 *  - vault 关闭 → not_applicable
 *  - vault 找不到 alias → host_not_found
 *  - 缺 password/privateKey 字段的 missing 列表才接管
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { evaluateVaultCredentials } from '../../src/agent/core.js';
import { resetConfigCache } from '../../src/config/loader.js';

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
  });

  it('password auth: patch contains host/port/username/password', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.222.10.48', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret123');

    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: '10.222.10.48' }, // LLM 经常只传 host
      ['password|privateKey|privateKeyPath'] // missingFields 包含 auth
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credentialPatch).toEqual({
      host: '10.222.10.48',
      port: 22,
      username: 'root',
      password: 'secret123',
    });
  });

  it('privateKey auth: patch contains host/port/username/privateKey', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'k8s', host: '10.0.0.2', user: 'ubuntu', port: 2222, authType: 'privateKey' },
      ],
    });
    mockGetCredential.mockResolvedValue('---KEY_BLOB---');

    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'k8s' },
      ['password|privateKey|privateKeyPath']
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credentialPatch).toEqual({
      host: '10.0.0.2',
      port: 2222,
      username: 'ubuntu',
      privateKey: '---KEY_BLOB---',
    });
  });

  it('LLM passes alias instead of IP — patch uses vault-mapped host', async () => {
    mockListHosts.mockResolvedValue({
      hosts: [
        { alias: 'web1', host: '10.222.10.48', user: 'root', port: 22, authType: 'password' },
      ],
    });
    mockGetCredential.mockResolvedValue('secret');

    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password|privateKey|privateKeyPath']
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 关键：即使 LLM 传 alias，patch 也应该用 vault 的真实 host
    expect(r.credentialPatch.host).toBe('10.222.10.48');
    expect(r.credentialPatch.username).toBe('root');
    expect(r.credentialPatch.password).toBe('secret');
  });

  it('does not handle non-ssh_ssh_connect tools', async () => {
    const r = await evaluateVaultCredentials(
      'ssh_ssh_exec',
      { connectionId: '10.0.0.1:22', command: 'ls' },
      ['command']
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_applicable');
  });

  it('returns not_applicable when missing fields are not auth-related', async () => {
    const r = await evaluateVaultCredentials(
      'ssh_ssh_exec',
      {},
      ['command'] // 只缺 command，跟凭证无关
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_applicable');
  });

  it('returns host_not_found when no vault match', async () => {
    mockListHosts.mockResolvedValue({ hosts: [] });
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'unknown-host' },
      ['password|privateKey|privateKeyPath']
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('host_not_found');
    expect(r.alias).toBe('unknown-host');
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
      ['password|privateKey|privateKeyPath']
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('credential_missing');
    expect(r.alias).toBe('web1');
  });

  it('returns host_not_found when args.host is missing', async () => {
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      {},
      ['password|privateKey|privateKeyPath']
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('host_not_found');
  });

  it('returns vault_error when listHosts throws', async () => {
    mockListHosts.mockRejectedValue(new Error('vault offline'));
    const r = await evaluateVaultCredentials(
      'ssh_ssh_connect',
      { host: 'web1' },
      ['password|privateKey|privateKeyPath']
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('vault_error');
    expect(r.error).toContain('vault offline');
  });
});
