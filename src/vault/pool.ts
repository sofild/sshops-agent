/**
 * Vault Connection Pool
 *
 * v1 MVP 实现：
 *  - 不自己实现 SSH 客户端（v1 通过 mcp-server-ssh 子子进程持有连接）
 *  - 维护 connectionId → Connection 映射
 *  - LRU 淘汰 + idle reaper
 *  - 在 spawn 子子进程时把 keychain 中的 secret 注入到 env，spawn 后立即清零
 */
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { getLogger } from '../observability/logging.js';
import { getKeychain } from './keychain.js';
import type { VaultHost } from './store.js';
import type { Scope as ScopeType } from './types.js';
import { ScopeSchema } from './types.js';
type Scope = ScopeType;

const log = getLogger().child({ component: 'vault.pool' });

export interface Connection {
  id: string;
  host: VaultHost;
  scope?: Scope;
  child: ChildProcess | null;
  mcpClientId: string | null; // 关联的 mcp-server-ssh 调用句柄
  lastUsedAt: number;
  busy: boolean;
  closed: boolean;
  scopeFingerprint: string;
}

function scopeFingerprint(scope?: Scope): string {
  if (!scope) return '*';
  return JSON.stringify({
    a: scope.allowedCommands?.slice().sort(),
    d: scope.deniedCommands?.slice().sort(),
    s: scope.requireSudo,
    m: scope.maxDurationMs,
  });
}

export class ConnectionPool {
  private pools = new Map<string, Connection[]>(); // key: `${alias}:${user}:${port}`
  private byId = new Map<string, Connection>();
  private reaperHandle: NodeJS.Timeout | null = null;

  constructor(private readonly opts: {
    maxConnectionsPerHost: number;
    idleTimeoutMs: number;
    keepaliveIntervalMs: number;
  }) {
    this.startReaper();
  }

  private makeKey(host: VaultHost): string {
    return `${host.alias}:${host.user}:${host.port}`;
  }

  async acquire(host: VaultHost, scope?: Scope): Promise<Connection> {
    const key = this.makeKey(host);
    const fp = scopeFingerprint(scope);
    let pool = this.pools.get(key) ?? [];
    const candidate = pool.find((c) => !c.busy && !c.closed && c.scopeFingerprint === fp);
    if (candidate) {
      candidate.busy = true;
      candidate.lastUsedAt = Date.now();
      log.info({ id: candidate.id, alias: host.alias }, 'connection reused from pool');
      return candidate;
    }

    if (pool.length >= this.opts.maxConnectionsPerHost) {
      // LRU 淘汰
      const lru = pool.filter((c) => !c.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (lru) {
        log.info({ id: lru.id }, 'LRU evicting connection');
        await this.destroy(lru);
        pool = pool.filter((c) => c !== lru);
      } else {
        // 全部忙：拒绝新开
        throw new Error(`pool exhausted for ${key}: all ${pool.length} connections busy`);
      }
    }

    const conn = await this.openConnection(host, scope, fp);
    pool.push(conn);
    this.pools.set(key, pool);
    this.byId.set(conn.id, conn);
    return conn;
  }

  release(connectionId: string): void {
    const c = this.byId.get(connectionId);
    if (!c) return;
    c.busy = false;
    c.lastUsedAt = Date.now();
  }

  async revoke(connectionId: string): Promise<boolean> {
    const c = this.byId.get(connectionId);
    if (!c) return false;
    await this.destroy(c);
    this.byId.delete(connectionId);
    const key = this.makeKey(c.host);
    const pool = this.pools.get(key);
    if (pool) this.pools.set(key, pool.filter((x) => x !== c));
    return true;
  }

  get(connectionId: string): Connection | null {
    return this.byId.get(connectionId) ?? null;
  }

  status(): Array<{ host: string; user: string; alive: number; idle: number; busy: number }> {
    const out: Array<{ host: string; user: string; alive: number; idle: number; busy: number }> = [];
    for (const [key, pool] of this.pools) {
      const [alias, user] = key.split(':');
      const alive = pool.filter((c) => !c.closed).length;
      const idle = pool.filter((c) => !c.busy && !c.closed).length;
      const busy = pool.filter((c) => c.busy && !c.closed).length;
      out.push({ host: alias ?? key, user: user ?? '', alive, idle, busy });
    }
    return out;
  }

  async shutdown(): Promise<number> {
    let closed = 0;
    for (const c of this.byId.values()) {
      await this.destroy(c);
      closed++;
    }
    this.byId.clear();
    this.pools.clear();
    if (this.reaperHandle) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    return closed;
  }

  // ---------- private ----------
  private async openConnection(host: VaultHost, scope: Scope | undefined, fp: string): Promise<Connection> {
    const id = generateConnectionId(host);
    let secret: string | null = null;
    try {
      const kc = await getKeychain();
      secret = await kc.getPassword('sshops-vault', host.keychainAccount);
      if (!secret) {
        throw new Error(`No credential in keychain for ${host.keychainAccount}. Run: sshops-vault set ${host.alias}`);
      }
    } catch (err) {
      throw new Error(`keychain access failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // v1 MVP: spawn mcp-server-ssh，把 secret 注入 env
    // 注意：env 中的 secret 会在子进程 /proc/<pid>/environ 残留。v2 加 PR_SET_DUMPABLE。
    let child: ChildProcess | null = null;
    try {
      child = spawn('npx', ['-y', 'mcp-server-ssh'], {
        env: {
          ...process.env,
          SSH_HOST: host.host,
          SSH_USER: host.user,
          SSH_PORT: String(host.port),
          ...(host.authType === 'password'
            ? { SSH_PASSWORD: secret }
            : { SSH_PRIVATE_KEY: secret }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 立即清零 secret 引用（heap 残留概率降低）
      secret = null;
    } finally {
      secret = null;
    }

    const conn: Connection = {
      id,
      host,
      scope,
      child,
      mcpClientId: null,
      lastUsedAt: Date.now(),
      busy: true,
      closed: false,
      scopeFingerprint: fp,
    };

    // 监听子子进程意外退出
    if (child) {
      child.on('exit', (code) => {
        log.warn({ id, alias: host.alias, code }, 'mcp-server-ssh child exited');
        conn.closed = true;
        conn.child = null;
      });
      child.on('error', (err) => {
        log.error({ id, alias: host.alias, err: String(err) }, 'mcp-server-ssh child error');
        conn.closed = true;
      });
    }

    return conn;
  }

  private async destroy(c: Connection): Promise<void> {
    c.closed = true;
    if (c.child && !c.child.killed) {
      try {
        c.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      // 给子进程 1s 优雅退出
      await wait(1000);
      if (c.child && !c.child.killed) {
        try {
          c.child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    c.child = null;
  }

  private startReaper(): void {
    if (this.reaperHandle) return;
    this.reaperHandle = setInterval(() => {
      const now = Date.now();
      for (const pool of this.pools.values()) {
        for (const c of pool) {
          if (!c.closed && !c.busy && now - c.lastUsedAt > this.opts.idleTimeoutMs) {
            log.info({ id: c.id, idleMs: now - c.lastUsedAt }, 'reaping idle connection');
            this.destroy(c).catch((err) => log.warn({ err: String(err) }, 'reaper destroy error'));
          }
        }
      }
    }, 5000);
    this.reaperHandle.unref();
  }
}

function generateConnectionId(host: VaultHost): string {
  // 第一段：host 的不可逆 hash（agent 拿 connectionId 也猜不出 host）
  const hash = simpleHash(host.host + ':' + host.user);
  // 第二段：UUID v4（base32）
  return `conn_${hash}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function simpleHash(input: string): string {
  // 简单 FNV-1a 32-bit，输出 base32
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(32);
}
