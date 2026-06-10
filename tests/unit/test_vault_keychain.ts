/**
 * EncryptedFile keychain backend 测试
 *
 * 直接 import EncryptedFile backend（绕开 DPAPI 等慢后端）以保证测试快速且与平台无关。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileBackend, resetCachedKey } from '../../src/vault/keychain.js';

describe('EncryptedFileBackend (direct unit test)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let backend: EncryptedFileBackend;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sshops-enc-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    resetCachedKey();
    backend = new EncryptedFileBackend();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    try {
      rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignore
    }
  });

  it('is always available', async () => {
    expect(await backend.available()).toBe(true);
    expect(backend.name).toBe('encrypted-file');
  });

  it('round-trips ASCII secret', async () => {
    await backend.setPassword('sshops-test', 'alice', 'p@ssw0rd');
    expect(await backend.getPassword('sshops-test', 'alice')).toBe('p@ssw0rd');
  });

  it('round-trips unicode + special chars', async () => {
    const tricky = "abc'\"\n\t\\u00ff${PATH}漢字🦊";
    await backend.setPassword('sshops-test', 'bob', tricky);
    expect(await backend.getPassword('sshops-test', 'bob')).toBe(tricky);
  });

  it('returns null for missing account', async () => {
    expect(await backend.getPassword('sshops-test', 'ghost')).toBeNull();
  });

  it('deletes existing secret and returns true; missing returns false', async () => {
    await backend.setPassword('sshops-test', 'carol', 's3cret');
    expect(await backend.deletePassword('sshops-test', 'carol')).toBe(true);
    expect(await backend.getPassword('sshops-test', 'carol')).toBeNull();
    expect(await backend.deletePassword('sshops-test', 'carol')).toBe(false);
  });

  it('overwrites previous value for same account', async () => {
    await backend.setPassword('sshops-test', 'dave', 'v1');
    await backend.setPassword('sshops-test', 'dave', 'v2');
    expect(await backend.getPassword('sshops-test', 'dave')).toBe('v2');
  });

  it('isolates secrets across accounts', async () => {
    await backend.setPassword('sshops-test', 'e1', 'A');
    await backend.setPassword('sshops-test', 'e2', 'B');
    expect(await backend.getPassword('sshops-test', 'e1')).toBe('A');
    expect(await backend.getPassword('sshops-test', 'e2')).toBe('B');
  });

  it('isolates secrets across services', async () => {
    await backend.setPassword('svc-a', 'shared', 'from-a');
    await backend.setPassword('svc-b', 'shared', 'from-b');
    expect(await backend.getPassword('svc-a', 'shared')).toBe('from-a');
    expect(await backend.getPassword('svc-b', 'shared')).toBe('from-b');
  });

  it('encrypted file does not contain plaintext', async () => {
    const secret = 'plaintext-must-not-leak-9000';
    await backend.setPassword('sshops-test', 'leak', secret);
    const path = join(tmpHome, '.sshops', 'secrets', 'sshops-test__leak.enc');
    expect(existsSync(path)).toBe(true);
    const onDisk = readFileSync(path, 'utf-8');
    expect(onDisk).not.toContain(secret);
    // 仍是合法 JSON 加密 blob
    const parsed = JSON.parse(onDisk) as { v: number; iv: string; ct: string; tag: string };
    expect(parsed.v).toBe(1);
    expect(typeof parsed.iv).toBe('string');
    expect(typeof parsed.ct).toBe('string');
    expect(typeof parsed.tag).toBe('string');
  });

  it('file permissions are owner-only (0o600)', async () => {
    await backend.setPassword('sshops-test', 'perm', 'v');
    const path = join(tmpHome, '.sshops', 'secrets', 'sshops-test__perm.enc');
    const { statSync } = await import('node:fs');
    const s = statSync(path);
    // Windows 上 mode 总是 0o666，我们跳过 mode 断言
    if (process.platform !== 'win32') {
      expect(s.mode & 0o777).toBe(0o600);
    } else {
      // 仅验证文件存在
      expect(s.isFile()).toBe(true);
    }
  });

  it('survives re-derivation: getPassword works across same key', async () => {
    await backend.setPassword('sshops-test', 'persist', 'value-X');
    // 同一 backend 实例（同一 cachedKey）应能解密
    const backend2 = new EncryptedFileBackend();
    expect(await backend2.getPassword('sshops-test', 'persist')).toBe('value-X');
  });

  it('corrupt file is treated as null (no throw)', async () => {
    const path = join(tmpHome, '.sshops', 'secrets', 'sshops-test__corrupt.enc');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(tmpHome, '.sshops', 'secrets'), { recursive: true });
    writeFileSync(path, 'not valid json {{{');
    expect(await backend.getPassword('sshops-test', 'corrupt')).toBeNull();
  });
});
