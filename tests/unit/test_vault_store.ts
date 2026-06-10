/**
 * Vault Metadata Store 测试
 *
 * - 不依赖 keychain，纯文件 IO
 * - 验证 upsert/getByAliasOrHost/remove/updateLastSuccess 行为
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultMetadataStore } from '../../src/vault/store.js';

describe('VaultMetadataStore', () => {
  let tmpDir: string;
  let store: VaultMetadataStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sshops-vault-store-'));
    store = new VaultMetadataStore({ path: join(tmpDir, 'vault.json') });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows 偶发 EPERM
    }
  });

  it('starts empty when file does not exist', () => {
    const all = store.getAll();
    expect(all).toEqual([]);
  });

  it('upsert adds a new host', () => {
    store.upsert({
      alias: 'web1',
      host: '10.0.0.1',
      user: 'root',
      port: 22,
      authType: 'password',
      keychainAccount: 'host:web1:user:root',
      fingerprint: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      tags: ['prod'],
      options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
    });
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].alias).toBe('web1');
    expect(all[0].host).toBe('10.0.0.1');
    expect(all[0].tags).toEqual(['prod']);
  });

  it('upsert overwrites existing alias', () => {
    store.upsert({
      alias: 'web1',
      host: '10.0.0.1',
      user: 'root',
      port: 22,
      authType: 'password',
      keychainAccount: 'k1',
      fingerprint: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      tags: [],
      options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
    });
    store.upsert({
      alias: 'web1',
      host: '10.0.0.99',
      user: 'admin',
      port: 2222,
      authType: 'privateKey',
      keychainAccount: 'k2',
      fingerprint: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      tags: ['v2'],
      options: { sudoPasswordRequired: true, preferredShell: '/bin/zsh' },
    });
    const h = store.getByAliasOrHost('web1');
    expect(h?.host).toBe('10.0.0.99');
    expect(h?.user).toBe('admin');
    expect(h?.port).toBe(2222);
    expect(h?.authType).toBe('privateKey');
    expect(h?.tags).toEqual(['v2']);
  });

  it('getByAliasOrHost matches by alias or host IP', () => {
    store.upsert({
      alias: 'web1',
      host: '10.0.0.1',
      user: 'root',
      port: 22,
      authType: 'password',
      keychainAccount: 'k1',
      fingerprint: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      tags: [],
      options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
    });
    expect(store.getByAliasOrHost('web1')?.alias).toBe('web1');
    expect(store.getByAliasOrHost('10.0.0.1')?.alias).toBe('web1');
    expect(store.getByAliasOrHost('notexists')).toBeNull();
  });

  it('remove deletes a host', () => {
    store.upsert({
      alias: 'tmp',
      host: '1.2.3.4',
      user: 'root',
      port: 22,
      authType: 'password',
      keychainAccount: 'k',
      fingerprint: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      tags: [],
      options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
    });
    expect(store.remove('tmp')).toBe(true);
    expect(store.remove('tmp')).toBe(false);
    expect(store.getByAliasOrHost('tmp')).toBeNull();
  });

  it('updateLastSuccess sets timestamps', () => {
    store.upsert({
      alias: 'a',
      host: 'h',
      user: 'u',
      port: 22,
      authType: 'password',
      keychainAccount: 'k',
      fingerprint: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      tags: [],
      options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
    });
    store.updateLastSuccess('a');
    const h = store.getByAliasOrHost('a');
    expect(h?.lastConnectedAt).toBeTruthy();
    expect(h?.lastSuccessAt).toBeTruthy();
  });

  it('persists across instances', () => {
    store.upsert({
      alias: 'p',
      host: 'h',
      user: 'u',
      port: 22,
      authType: 'password',
      keychainAccount: 'k',
      fingerprint: null,
      lastConnectedAt: null,
      lastSuccessAt: null,
      tags: [],
      options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
    });
    const store2 = new VaultMetadataStore({ path: join(tmpDir, 'vault.json') });
    expect(store2.getByAliasOrHost('p')?.host).toBe('h');
  });
});
