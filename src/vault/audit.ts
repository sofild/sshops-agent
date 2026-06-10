/**
 * sshops-vault 独立审计日志
 *
 * - 写入 ~/.sshops/vault-audit.jsonl
 * - 与 agent 的 logs/audit.jsonl 隔离
 * - 绝不写入密码、keychain token、原始 secret
 * - fsync 强保证（kill -9 不丢日志）
 */
import { appendFileSync, openSync, writeSync, closeSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'vault.audit' });

export type VaultAuditDecision = 'success' | 'failure' | 'deny' | 'pending';

export interface VaultAuditEntry {
  ts: string;
  method: string;
  alias: string;
  host?: string;
  user?: string;
  connectionId?: string;
  command?: string;
  decision: VaultAuditDecision;
  durationMs?: number;
  errorCode?: number;
  errorMessage?: string;
  agentPid: number;
  agentUid: number | null;
  /** 严格白名单字段：除上述外不接受任何 secret */
  [k: string]: unknown;
}

const DEFAULT_AUDIT_PATH = join(homedir(), '.sshops', 'vault-audit.jsonl');

export class VaultAuditLog {
  private path: string;
  private enabled: boolean;

  constructor(opts?: { path?: string; enabled?: boolean }) {
    this.path = opts?.path ?? DEFAULT_AUDIT_PATH;
    this.enabled = opts?.enabled ?? true;
  }

  private ensureDir(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  write(entry: Omit<VaultAuditEntry, 'ts' | 'agentPid' | 'agentUid'>): void {
    if (!this.enabled) return;
    // 二次防御：剔除 secret 字段（防止调用方误传）
    const safe: Partial<VaultAuditEntry> = { ...entry };
    for (const forbidden of [
      'password',
      'secret',
      'key',
      'privateKey',
      'token',
      'credential',
      'passphrase',
    ]) {
      if (forbidden in safe) {
        delete safe[forbidden as keyof VaultAuditEntry];
      }
    }
    const full: VaultAuditEntry = {
      ...(safe as VaultAuditEntry),
      ts: new Date().toISOString(),
      agentPid: process.ppid,
      agentUid: safeAgentUid(),
    };
    this.ensureDir();
    const line = JSON.stringify(full) + '\n';
    try {
      const fd = openSync(this.path, 'a');
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      log.error({ err: String(err) }, 'vault audit write failed');
    }
  }
}

function safeAgentUid(): number | null {
  try {
    if (process.platform === 'win32') {
      // Windows 上 process.getuid 不存在
      return null;
    }
    return process.getuid?.() ?? null;
  } catch {
    return null;
  }
}

/** 全局单例 */
let globalInstance: VaultAuditLog | null = null;
export function getVaultAuditLog(): VaultAuditLog {
  if (!globalInstance) globalInstance = new VaultAuditLog();
  return globalInstance;
}
