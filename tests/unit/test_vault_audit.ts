/**
 * Vault Audit Log 测试
 *
 * - 验证 fsync 强写入
 * - 验证 secret 字段被严格剔除
 * - 验证禁用模式
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultAuditLog } from '../../src/vault/audit.js';

describe('VaultAuditLog', () => {
  let tmpDir: string;
  let path: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sshops-vault-audit-'));
    path = join(tmpDir, 'audit.jsonl');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // ignore
    }
  });

  it('writes a single entry as JSONL', () => {
    const log = new VaultAuditLog({ path, enabled: true });
    log.write({
      method: 'vault.acquire',
      alias: 'web1',
      decision: 'success',
      durationMs: 12,
    });
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.method).toBe('vault.acquire');
    expect(entry.alias).toBe('web1');
    expect(entry.decision).toBe('success');
    expect(entry.ts).toBeTruthy();
  });

  it('appends multiple entries', () => {
    const log = new VaultAuditLog({ path, enabled: true });
    log.write({ method: 'vault.listHosts', alias: '', decision: 'success' });
    log.write({ method: 'vault.acquire', alias: 'web1', decision: 'success' });
    log.write({ method: 'vault.execute', alias: 'web1', decision: 'failure', errorCode: -32002 });
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('strips forbidden secret fields', () => {
    const log = new VaultAuditLog({ path, enabled: true });
    // 故意注入 secret-like 字段，验证被剔除
    log.write({
      method: 'vault.setCredential',
      alias: 'web1',
      decision: 'success',
      // @ts-expect-error 故意传入禁止字段
      password: 'supersecret',
      // @ts-expect-error
      secret: 'anothersecret',
      // @ts-expect-error
      privateKey: '-----BEGIN RSA PRIVATE KEY-----',
      // @ts-expect-error
      token: 'tok_xxx',
    });
    const content = readFileSync(path, 'utf-8');
    expect(content).not.toContain('supersecret');
    expect(content).not.toContain('anothersecret');
    expect(content).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(content).not.toContain('tok_xxx');
    // 普通字段仍在
    expect(content).toContain('web1');
    expect(content).toContain('vault.setCredential');
  });

  it('does not write when disabled', () => {
    const log = new VaultAuditLog({ path, enabled: false });
    log.write({ method: 'vault.acquire', alias: 'x', decision: 'success' });
    expect(existsSync(path)).toBe(false);
  });

  it('creates parent directory if missing', () => {
    const nested = join(tmpDir, 'deep', 'nested', 'audit.jsonl');
    const log = new VaultAuditLog({ path: nested, enabled: true });
    log.write({ method: 'vault.listHosts', alias: '', decision: 'success' });
    expect(existsSync(nested)).toBe(true);
  });
});
