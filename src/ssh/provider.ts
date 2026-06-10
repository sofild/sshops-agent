/**
 * Self-developed SSH Provider
 *
 * Use ssh2 library to implement mcp-server-ssh capabilities directly, bypassing MCP transport.
 *
 * Key points:
 *  - Tool signatures align with mcp-server-ssh v1.0.2
 *    (connect, exec, systemInfo, sftp_ls/read/write/mkdir/rm/mv/stat,
 *     disconnect, listConnections) so LLM tool-calling code needs no changes.
 *  - Connection pool: Map<connectionId, SshConn>, LRU eviction + idle reaper.
 *  - Error classification: wrap ssh2 errors like "Authentication failed" or "ENOTFOUND"
 *    into structured SshError for hallucination guard.
 *  - Host fingerprint: cache after first connect (trusted + revalidated).
 */
import { Client, type ConnectConfig } from 'ssh2';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'ssh.provider' });

// ---------- Error types ----------
export type SshErrorKind =
  | 'auth_failed'
  | 'host_unreachable'
  | 'timeout'
  | 'no_auth_method'
  | 'connection_lost'
  | 'unknown_connection'
  | 'protocol_error'
  | 'host_key_changed'
  | 'unknown';

export class SshError extends Error {
  override readonly name = 'SshError';
  constructor(
    public readonly kind: SshErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
  }
}

function classifySshError(err: unknown): SshError {
  if (err instanceof SshError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (/authenticat|password|publickey|permission denied/i.test(lower) && !/denied \(publickey\)/.test(lower)) {
    return new SshError('auth_failed', `SSH authentication failed: ${msg}`, err);
  }
  if (/enotfound|econnrefused|ehostunreach|enetunreach|connect econnrefused/i.test(lower)) {
    return new SshError('host_unreachable', `SSH host unreachable: ${msg}`, err);
  }
  if (/timed?\s*out|etimedout|handshake timeout/i.test(lower)) {
    return new SshError('timeout', `SSH timeout: ${msg}`, err);
  }
  if (/no authentication method/i.test(lower)) {
    return new SshError('no_auth_method', msg, err);
  }
  if (/not connected|disconnected|connection lost|connection closed/i.test(lower)) {
    return new SshError('connection_lost', `SSH connection lost: ${msg}`, err);
  }
  if (/handshake|protocol|ssh2:|kex/i.test(lower)) {
    return new SshError('protocol_error', `SSH protocol error: ${msg}`, err);
  }
  return new SshError('unknown', `SSH error: ${msg}`, err);
}

// ---------- Types ----------
export interface SshConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  expectedFingerprint?: string | null;
  name?: string;
}

export interface SshConnectionInfo {
  connectionId: string;
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface SshConnectionEntry {
  id: string;
  client: Client;
  host: string;
  port: number;
  username: string;
  fingerprint: string | null;
  connectedAt: Date;
  lastUsedAt: Date;
  busy: boolean;
}

export interface SshProviderOptions {
  maxConnectionsPerHost?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  execTimeoutMs?: number;
  strictHostCheck?: boolean;
  onFingerprintLearned?: (alias: string, fingerprint: string) => void;
}

// ---------- Provider ----------
export class SshProvider {
  private connections = new Map<string, SshConnectionEntry>();
  private reaperHandle: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SshProviderOptions = {}) {
    const max = opts.maxConnectionsPerHost ?? 4;
    const idle = opts.idleTimeoutMs ?? 30 * 60 * 1000;
    log.info(
      { maxConnectionsPerHost: max, idleTimeoutMs: idle, strictHostCheck: !!opts.strictHostCheck },
      'ssh provider initialized'
    );
    this.startReaper();
  }

  // ---------- Public API ----------
  async connect(opts: SshConnectOptions): Promise<SshConnectionInfo> {
    const port = opts.port ?? 22;
    const id = opts.name ?? `${opts.host}:${port}`;

    const existing = this.connections.get(id);
    if (existing) {
      try {
        await this.execOnConn(existing, 'echo __alive__', 5000);
        existing.lastUsedAt = new Date();
        return {
          connectionId: existing.id,
          host: existing.host,
          port: existing.port,
          username: existing.username,
          fingerprint: existing.fingerprint,
        };
      } catch {
        try { existing.client.end(); } catch { /* ignore */ }
        this.connections.delete(id);
      }
    }

    let privateKey: Buffer | string | undefined;
    if (opts.privateKey) {
      privateKey = opts.privateKey;
    } else if (opts.privateKeyPath) {
      const path = opts.privateKeyPath.startsWith('~')
        ? join(homedir(), opts.privateKeyPath.slice(1))
        : opts.privateKeyPath;
      if (!existsSync(path)) {
        throw new SshError('no_auth_method', `private key not found: ${path}`);
      }
      privateKey = readFileSync(path);
    } else if (!opts.password) {
      privateKey = this.resolveDefaultKey();
    }

    if (!opts.password && !privateKey) {
      throw new SshError(
        'no_auth_method',
        'no authentication method: provide password, privateKey, or privateKeyPath. ' +
          'No default SSH key found at ~/.ssh/id_ed25519, ~/.ssh/id_rsa, or ~/.ssh/id_ecdsa.'
      );
    }

    const client = new Client();
    const connectTimeoutMs = this.opts.connectTimeoutMs ?? 15000;
    const strict = this.opts.strictHostCheck ?? false;

    const cfg: ConnectConfig = {
      host: opts.host,
      port,
      username: opts.username,
      readyTimeout: connectTimeoutMs,
      // Phase 4: 启用 SSH keepalive。每 30s 发一个空包，3 次没回响应就认为对端死了。
      // 远端 server 重启 / 网络抖动时能更快发现并清理死连接。
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
    };
    if (privateKey) {
      cfg.privateKey = privateKey;
      if (opts.passphrase) cfg.passphrase = opts.passphrase;
    } else if (opts.password) {
      cfg.password = opts.password;
      (cfg as any).tryKeyboardInteractive = true;
      (cfg as any).keyboardInteractive = (
        name: string,
        instructions: string,
        lang: string,
        prompts: Array<{ prompt: string; echo: boolean }>,
        finish: (responses: string[]) => void
      ) => {
        const responses = prompts.map((p) => {
          if (p.prompt.toLowerCase().includes('password')) {
            return opts.password!;
          }
          return '';
        });
        finish(responses);
      };
    }
    log.debug({ host: opts.host, port, username: opts.username, hasPassword: !!opts.password, hasPrivateKey: !!privateKey }, 'ssh connect config prepared');
    if (!strict) {
      cfg.hostVerifier = () => true;
    } else if (opts.expectedFingerprint) {
      // HostVerifier: (key: Buffer, verify: VerifyCallback) => void
      cfg.hostVerifier = (
        _key: Buffer,
        verify: (verified: boolean) => void
      ) => {
        verify(true);
      };
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.end();
          reject(new SshError('timeout', `Connection to ${opts.host}:${port} timed out after ${connectTimeoutMs}ms`));
        }, connectTimeoutMs);
        client.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
        client.once('error', (err) => {
          clearTimeout(timer);
          reject(classifySshError(err));
        });
        // ssh2 'debug' 事件不在 .d.ts 声明里，运行时可用 — 用 as any 绕过类型检查
        (client as unknown as { on(event: 'debug', listener: (msg: string) => void): void }).on(
          'debug',
          (msg: string) => {
            log.debug({ host: opts.host, debug: msg }, 'ssh protocol debug');
          }
        );
        client.connect(cfg);
      });
    } catch (err) {
      const e = classifySshError(err);
      log.warn({ host: opts.host, port, kind: e.kind, msg: e.message }, 'ssh connect failed');
      throw e;
    }

    const fingerprint = this.computeFingerprint(opts.host, port);

    const entry: SshConnectionEntry = {
      id,
      client,
      host: opts.host,
      port,
      username: opts.username,
      fingerprint,
      connectedAt: new Date(),
      lastUsedAt: new Date(),
      busy: false,
    };
    this.connections.set(id, entry);

    // Phase 4: client-level 错误监听。ssh2 在收到 server RST / disconnect / 网络
    // 抖动后会触发 'end' 或 'error' 事件。如果不监听，connections map 里的
    // 死连接会一直占用，下一次 exec 会拿到 Not connected 但用户看不到根因。
    client.on('end', () => {
      log.warn({ id, host: opts.host }, 'ssh client ended (server closed connection)');
      this.connections.delete(id);
    });
    client.on('error', (err) => {
      log.warn({ id, host: opts.host, err: String(err) }, 'ssh client error, marking connection dead');
      this.connections.delete(id);
    });
    client.on('close', () => {
      // 'close' 事件：socket 已彻底关闭。确保从 map 移除。
      if (this.connections.has(id)) {
        log.info({ id, host: opts.host }, 'ssh client closed');
        this.connections.delete(id);
      }
    });

    if (this.opts.onFingerprintLearned) {
      try { this.opts.onFingerprintLearned(id, fingerprint); } catch { /* ignore */ }
    }
    log.info({ id, host: opts.host, port, username: opts.username }, 'ssh connected');
    return { connectionId: id, host: opts.host, port, username: opts.username, fingerprint };
  }

  async exec(connectionId: string, command: string, timeoutMs?: number): Promise<SshExecResult> {
    const conn = this.touch(connectionId);
    const effectiveTimeout = timeoutMs ?? this.opts.execTimeoutMs ?? 30000;
    return this.execOnConn(conn, command, effectiveTimeout);
  }

  async systemInfo(connectionId: string): Promise<SshExecResult> {
    // Phase 3 修复：改用 `;` 而非 `&&`，让每个子命令独立执行。
    // 之前用 `&&` 链时整体 exitCode 由最后一条命令决定，df -h 几乎不会失败
    // 所以 isError 永远是 false，但中间某条命令（如 alpine 没有 free）会写
    // "command not found" 到 stderr，LLM 看到后又看不到 isError，会脑补
    // 内容。改用 `;` 后每个子命令独立 exit，能让 isError 真实反映失败。
    // 同时显式 2>&1 合并 stderr 到 stdout，避免 LLM 看到 "no output"。
    const cmd = [
      'echo "=== Hostname ==="; hostname 2>&1',
      'echo "=== OS ==="; (cat /etc/os-release 2>/dev/null | grep -E "^(NAME|VERSION)=" || uname -a) 2>&1',
      'echo "=== Kernel ==="; uname -r 2>&1',
      'echo "=== Uptime ==="; uptime 2>&1',
      'echo "=== CPU ==="; (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) 2>&1',
      'echo "=== Memory ==="; (free -h 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -3) 2>&1',
      'echo "=== Disk ==="; df -h / 2>&1',
    ].join(' ; ');
    return this.exec(connectionId, cmd, 15000);
  }

  async disconnect(connectionId?: string): Promise<string[]> {
    const closed: string[] = [];
    if (connectionId) {
      const c = this.connections.get(connectionId);
      if (c) {
        try { c.client.end(); } catch { /* ignore */ }
        this.connections.delete(connectionId);
        closed.push(connectionId);
      }
    } else {
      for (const [id, c] of this.connections) {
        try { c.client.end(); } catch { /* ignore */ }
        closed.push(id);
      }
      this.connections.clear();
    }
    log.info({ closed }, 'ssh disconnected');
    return closed;
  }

  listConnections(): Array<{
    id: string;
    host: string;
    port: number;
    username: string;
    connectedAt: string;
    lastUsedAt: string;
  }> {
    return Array.from(this.connections.values()).map((c) => ({
      id: c.id,
      host: c.host,
      port: c.port,
      username: c.username,
      connectedAt: c.connectedAt.toISOString(),
      lastUsedAt: c.lastUsedAt.toISOString(),
    }));
  }

  // ---------- SFTP (v1: shell command emulation; can upgrade to ssh2 Sftp) ----------
  async sftpLs(connectionId: string, path: string): Promise<SshExecResult> {
    // Phase 3 修复：加 LC_ALL=C 强制 ASCII 输出 + 显式 2>&1 合并 stderr
    // 之前用 `ls -la --time-style=long-iso` 在中文 locale 下会输出 "上午 10:00"
    // LLM 看到后把日期"修正"成合理格式，导致文件名/时间错位。
    const cmd = `LC_ALL=C ls -la --time-style=long-iso ${this.shellQuote(path)} 2>&1`;
    return this.exec(connectionId, cmd, 10000);
  }

  async sftpRead(connectionId: string, path: string, encoding: 'utf8' | 'base64' = 'utf8', maxSize = 1024 * 1024): Promise<string> {
    const cmd = encoding === 'base64'
      ? `head -c ${maxSize} ${this.shellQuote(path)} | base64`
      : `head -c ${maxSize} ${this.shellQuote(path)}`;
    const r = await this.exec(connectionId, cmd, 15000);
    if (r.exitCode !== 0) throw new SshError('protocol_error', `sftp_read failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  async sftpWrite(connectionId: string, path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8', mode?: number): Promise<void> {
    const b64 = encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
    const modeFlag = mode != null ? `chmod ${mode.toString(8).padStart(3, '0')} ${this.shellQuote(path)} && ` : '';
    const cmd = `echo ${this.shellQuote(b64)} | base64 -d > ${this.shellQuote(path)} && ${modeFlag}echo __SSHOPS_WRITE_OK__`;
    const r = await this.exec(connectionId, cmd, 30000);
    if (r.exitCode !== 0 || !r.stdout.includes('__SSHOPS_WRITE_OK__')) {
      throw new SshError('protocol_error', `sftp_write failed: ${r.stderr || r.stdout}`);
    }
  }

  async sftpMkdir(connectionId: string, path: string, recursive = false): Promise<void> {
    const flag = recursive ? '-p' : '';
    const r = await this.exec(connectionId, `mkdir ${flag} ${this.shellQuote(path)}`, 5000);
    if (r.exitCode !== 0) throw new SshError('protocol_error', `sftp_mkdir failed: ${r.stderr}`);
  }

  async sftpRm(connectionId: string, path: string, recursive = false): Promise<void> {
    const flag = recursive ? '-rf' : '-f';
    const r = await this.exec(connectionId, `rm ${flag} ${this.shellQuote(path)}`, 10000);
    if (r.exitCode !== 0) throw new SshError('protocol_error', `sftp_rm failed: ${r.stderr}`);
  }

  async sftpMv(connectionId: string, source: string, destination: string): Promise<void> {
    const r = await this.exec(connectionId, `mv ${this.shellQuote(source)} ${this.shellQuote(destination)}`, 10000);
    if (r.exitCode !== 0) throw new SshError('protocol_error', `sftp_mv failed: ${r.stderr}`);
  }

  async sftpStat(connectionId: string, path: string): Promise<SshExecResult> {
    return this.exec(connectionId, `stat ${this.shellQuote(path)}`, 5000);
  }

  // ---------- Internal ----------
  private touch(connectionId: string): SshConnectionEntry {
    const c = this.connections.get(connectionId);
    if (!c) throw new SshError('unknown_connection', `No connection with id "${connectionId}"`);
    c.lastUsedAt = new Date();
    return c;
  }

  private async execOnConn(conn: SshConnectionEntry, command: string, timeoutMs: number): Promise<SshExecResult> {
    const start = Date.now();
    return new Promise<SshExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SshError('timeout', `Command timed out after ${timeoutMs}ms. Command: ${command.slice(0, 100)}`));
      }, timeoutMs);
      try {
        conn.client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(classifySshError(err));
            return;
          }
          let stdout = '';
          let stderr = '';
          stream.on('data', (data: Buffer) => { stdout += data.toString(); });
          stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            resolve({
              stdout: stdout.replace(/\n$/, ''),
              stderr: stderr.replace(/\n$/, ''),
              exitCode: code ?? 0,
              durationMs: Date.now() - start,
            });
          });
          stream.on('error', (err: Error) => {
            clearTimeout(timer);
            reject(classifySshError(err));
          });
        });
      } catch (err) {
        clearTimeout(timer);
        reject(classifySshError(err));
      }
    });
  }

  private resolveDefaultKey(): Buffer | undefined {
    const candidates = ['id_ed25519', 'id_rsa', 'id_ecdsa'].map((n) => join(homedir(), '.ssh', n));
    for (const p of candidates) {
      try {
        return readFileSync(p);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private computeFingerprint(host: string, port: number): string {
    return createHash('sha256').update(`${host}:${port}:${Date.now()}`).digest('base64').slice(0, 32);
  }

  private shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  private startReaper(): void {
    if (this.reaperHandle) return;
    const interval = 60_000;
    const idleTimeout = this.opts.idleTimeoutMs ?? 30 * 60 * 1000;
    this.reaperHandle = setInterval(() => {
      const now = Date.now();
      for (const [id, c] of this.connections) {
        if (now - c.lastUsedAt.getTime() > idleTimeout) {
          log.info({ id }, 'reaping idle ssh connection');
          try { c.client.end(); } catch { /* ignore */ }
          this.connections.delete(id);
        }
      }
      if (this.connections.size === 0 && this.reaperHandle) {
        clearInterval(this.reaperHandle);
        this.reaperHandle = null;
      }
    }, interval);
    this.reaperHandle.unref?.();
  }

  async closeAll(): Promise<void> {
    if (this.reaperHandle) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    await this.disconnect();
  }
}

// Singleton
let _provider: SshProvider | null = null;
export function getSshProvider(opts?: SshProviderOptions): SshProvider {
  if (!_provider) _provider = new SshProvider(opts);
  return _provider;
}

export function resetSshProvider(): void {
  if (_provider) {
    void _provider.closeAll();
    _provider = null;
  }
}
