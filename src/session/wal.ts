/**
 * Session WAL (Write-Ahead Log)
 *
 * - 追加式写入 sessions/<id>.jsonl
 * - 启动时可回放
 * - WAL-before-yield：每个事件先 fsync 落盘再返回（由 appendSync 实现）
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, openSync, writeSync, fsyncSync, closeSync, statSync, createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { PROJECT_ROOT } from '../config/loader.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'session' });

const SESSIONS_DIR = resolve(PROJECT_ROOT, 'sessions');

export type SessionEventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'compression'
  | 'system';

export interface SessionEvent {
  type: SessionEventType;
  ts: string;
  session_id: string;
  data: unknown;
}

export class Session {
  readonly id: string;
  private path: string;
  private events: SessionEvent[] = [];
  private fd: number | null = null;

  constructor(id: string) {
    this.id = id;
    this.path = resolve(SESSIONS_DIR, `${id}.jsonl`);
  }

  static open(id: string): Session {
    return new Session(id);
  }

  static newId(): string {
    const d = new Date();
    const ts =
      d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') +
      '-' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0') +
      String(d.getSeconds()).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
  }

  /** 确保目录存在 */
  ensureDir(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** 打开 fd（lazy），用于 fsync 强保证 */
  private ensureFd(): number {
    if (this.fd != null) return this.fd;
    this.ensureDir();
    this.fd = openSync(this.path, 'a');
    return this.fd;
  }

  /**
   * 追加事件。
   * - 默认行为：openSync + writeSync + fsyncSync（fsync-before-return）。
   * - 这是 Enterprise WAL 的硬要求：事件先落盘再被 yield 给调用方，
   *   即使进程被 kill -9，下次启动仍能从 WAL 完整恢复。
   */
  append(event: Omit<SessionEvent, 'ts' | 'session_id'>): SessionEvent {
    this.ensureDir();
    const full: SessionEvent = {
      ...event,
      ts: new Date().toISOString(),
      session_id: this.id,
    };
    this.events.push(full);
    const line = JSON.stringify(full) + '\n';
    try {
      const fd = this.ensureFd();
      writeSync(fd, line);
      // fsync 强制落盘：保证即便立即 kill -9 也能恢复
      fsyncSync(fd);
    } catch (err) {
      // 退化为 appendFileSync（fsync 失败时至少保证数据可写）
      log.warn({ err: String(err) }, 'fsync failed, fallback to appendFileSync');
      appendFileSync(this.path, line, 'utf-8');
    }
    return full;
  }

  /** 显式关闭 fd */
  close(): void {
    if (this.fd != null) {
      try {
        closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }

  /** 加载所有历史事件（用于 resume） */
  load(): SessionEvent[] {
    this.close(); // 重新加载前关闭 fd
    if (!existsSync(this.path)) return [];
    const content = readFileSync(this.path, 'utf-8');
    const out: SessionEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch (err) {
        log.warn({ line: line.slice(0, 80) }, 'skip malformed session line');
      }
    }
    this.events = out;
    return out;
  }

  async *stream(): AsyncIterable<SessionEvent> {
    if (!existsSync(this.path)) return;
    const rl = createInterface({ input: createReadStream(this.path, 'utf-8') });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as SessionEvent;
      } catch {
        // skip
      }
    }
  }

  events_(): SessionEvent[] {
    return this.events;
  }

  stat(): { size: number; mtime: Date } | null {
    if (!existsSync(this.path)) return null;
    const s = statSync(this.path);
    return { size: s.size, mtime: s.mtime };
  }
}

export function listSessions(): { id: string; size: number; mtime: Date }[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: { id: string; size: number; mtime: Date }[] = [];
  for (const name of readdirSync(SESSIONS_DIR) as string[]) {
    if (!name.endsWith('.jsonl')) continue;
    const p = resolve(SESSIONS_DIR, name);
    const s = statSync(p);
    out.push({ id: name.replace(/\.jsonl$/, ''), size: s.size, mtime: s.mtime });
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
