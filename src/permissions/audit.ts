/**
 * 审计日志
 *
 * - 写入 logs/audit-YYYY-MM-DD.jsonl
 * - 每行一个 JSON 对象
 * - 可选 fsync
 */
import { appendFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from '../config/loader.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'audit' });

export interface AuditEntry {
  timestamp: string;
  session_id: string;
  trace_id: string;
  user: string;
  tool: string;
  host?: string;
  command?: string;
  decision: 'allow' | 'deny' | 'confirm';
  reason: string;
  exit_code?: number;
  stdout_summary?: string;
  stderr_summary?: string;
  [k: string]: unknown;
}

function auditPath(): string {
  const cfg = getConfig();
  const p = resolve(PROJECT_ROOT, cfg.permissions.audit.path);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return p;
}

function getUser(): string {
  return process.env.USER || process.env.USERNAME || 'unknown';
}

export function auditWrite(entry: Omit<AuditEntry, 'timestamp' | 'user'>): void {
  const cfg = getConfig();
  if (!cfg.permissions.audit.enabled) return;
  const full: AuditEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
    user: getUser(),
  } as AuditEntry;
  const line = JSON.stringify(full) + '\n';
  try {
    if (cfg.permissions.audit.fsync) {
      const fd = openSync(auditPath(), 'a');
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } else {
      appendFileSync(auditPath(), line, 'utf-8');
    }
  } catch (err) {
    log.error({ err: String(err) }, 'audit write failed');
  }
}

export function summarize(s: string, max = 256): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `...[truncated ${s.length - max} bytes]`;
}
