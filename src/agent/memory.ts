/**
 * 文件记忆系统
 *
 * - 写入 sessions/memory/<key>.md
 * - 跨会话保留关键事实
 * - 支持命名空间（prefix）与 TTL
 * - hosts.md 特殊处理：可被 LLM 用作 options menu 数据源
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { PROJECT_ROOT } from '../config/loader.js';
import type { MenuOption } from './types.js';

const MEMORY_DIR = resolve(PROJECT_ROOT, 'sessions', 'memory');

/** 命名空间 → 默认 TTL（毫秒）。0 表示永久 */
const NAMESPACES: Record<string, number> = {
  hosts: 0,            // 永久
  preferences: 0,      // 永久
  credentials: 7 * 24 * 3600 * 1000,    // 7 天
  'last-errors': 24 * 3600 * 1000,      // 24 小时
};

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function parseKey(key: string): { namespace: string; name: string } {
  const idx = key.indexOf(':');
  if (idx < 0) return { namespace: 'default', name: key };
  return { namespace: key.slice(0, idx), name: key.slice(idx + 1) };
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_\-\.:]/g, '_');
}

export function memoryPath(key: string): string {
  return resolve(MEMORY_DIR, `${safeName(key)}.md`);
}

function readMeta(key: string): { expiresAt: number | null; setBy: MemorySource; setAt: number } | null {
  const metaP = memoryPath(key) + '.meta.json';
  if (!existsSync(metaP)) return null;
  try {
    return JSON.parse(readFileSync(metaP, 'utf-8')) as { expiresAt: number | null; setBy: MemorySource; setAt: number };
  } catch {
    return null;
  }
}

function writeMeta(key: string, expiresAt: number | null, setBy: MemorySource = 'unknown'): void {
  const metaP = memoryPath(key) + '.meta.json';
  writeFileSync(metaP, JSON.stringify({ expiresAt, setBy, setAt: Date.now() }, null, 2), 'utf-8');
}

/** 记忆来源（用于审计/区分"用户手动" vs "agent 写入" vs "导入"） */
export type MemorySource = 'user' | 'agent' | 'import' | 'unknown';

export function remember(key: string, value: string, ttlMs?: number, setBy: MemorySource = 'user'): void {
  ensureDir();
  writeFileSync(memoryPath(key), value, 'utf-8');
  const ns = parseKey(key).namespace;
  const ttl = ttlMs ?? NAMESPACES[ns] ?? 0;
  writeMeta(key, ttl > 0 ? Date.now() + ttl : null, setBy);
}

/** 读取记忆的元信息（来源 / 过期时间 / 写入时间）。找不到时返回 null */
export function recallMeta(key: string): { expiresAt: number | null; setBy: MemorySource; setAt: number } | null {
  return readMeta(key);
}

export function recall(key: string): string | null {
  const p = memoryPath(key);
  if (!existsSync(p)) return null;
  const meta = readMeta(key);
  if (meta?.expiresAt && Date.now() > meta.expiresAt) {
    // 已过期，惰性删除
    try {
      unlinkSync(p);
      const metaP = p + '.meta.json';
      if (existsSync(metaP)) unlinkSync(metaP);
    } catch {
      /* ignore */
    }
    return null;
  }
  return readFileSync(p, 'utf-8');
}

export function listMemory(): string[] {
  if (!existsSync(MEMORY_DIR)) return [];
  return readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, '').replace(/^\._/, ''));
}

export function forget(key: string): boolean {
  const p = memoryPath(key);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  const metaP = p + '.meta.json';
  if (existsSync(metaP)) unlinkSync(metaP);
  return true;
}

export function allMemoryAsContext(): string {
  if (!existsSync(MEMORY_DIR)) return '';
  const items = listMemory();
  if (items.length === 0) return '';
  const lines: string[] = [
    '## Persistent memory',
    '',
    '以下是本会话可用的持久化记忆（用户手动维护的参考清单，**不是必须使用的硬约束**）：',
    '- `hosts` 文件是用户维护的**主机参考清单**（IP / alias / 描述）。',
    '- 调用 ssh_ssh_connect 时，**用户口述的 IP / 主机名优先**；hosts 仅在用户模糊指代（"那台"、"上次那个"）时作为选项菜单的数据源。',
    '- 不要把 hosts 里的内容当作"必须连"的列表；残留的孤儿条目应忽略。',
    '',
  ];
  for (const k of items) {
    const v = recall(k);
    if (v) {
      const meta = recallMeta(k);
      const setByTag = meta?.setBy && meta.setBy !== 'unknown' ? ` _[setBy=${meta.setBy}]_` : '';
      lines.push(`### ${k}${setByTag}`);
      lines.push(v);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * 把 hosts.md 解析为 MenuOption[] 供 options menu 渲染。
 * 格式示例（每行一台主机）:
 *   10.222.10.21 | root@web-01 | nginx running
 *   10.222.10.22 | app@db-01   | postgres 15
 *
 * 孤儿行（只有裸 IP，没有 label / 描述）默认**过滤掉**，避免污染选项菜单。
 * 调用方可用 `includeOrphans: true` 强制保留。
 */
export function loadHostsAsOptions(opts: { includeOrphans?: boolean } = {}): MenuOption[] {
  const content = recall('hosts');
  if (!content) return [];
  const out: MenuOption[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length === 0) continue;
    const host = parts[0];
    if (!host) continue;
    const label = parts[1] || '';
    const description = parts.slice(2).join(' | ') || undefined;
    // 孤儿行：仅有 IP，没有 label / 描述。默认过滤；保留时也加 warning。
    if (!label && !description) {
      if (!opts.includeOrphans) continue;
      // 强制保留时，至少给一个警告用 label
      out.push({ value: host, label: `${host} _[orphan]_`, description: 'no label/description, please edit hosts.md' });
      continue;
    }
    out.push({ value: host, label: label || host, description });
  }
  return out;
}

/** 读取所有标记为 memory:xxx 数据源的选项（供 LLM 选 host/user/connectionId 时使用） */
export function loadMemoryDataSource(spec: string): MenuOption[] | null {
  // spec 形如 'memory:hosts'
  const m = /^memory:(.+)$/.exec(spec);
  if (!m) return null;
  const key = m[1];
  if (key === 'hosts') return loadHostsAsOptions();
  // 通用：每行作为 value，注释以 # 开头
  const content = recall(key);
  if (!content) return [];
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split('|').map((p) => p.trim());
      return {
        value: parts[0] ?? l,
        label: parts[1] ?? parts[0] ?? l,
        description: parts.slice(2).join(' | ') || undefined,
      };
    });
}
