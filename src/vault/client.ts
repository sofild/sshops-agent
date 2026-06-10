/**
 * sshops-vault client (agent 侧)
 *
 * - spawn 子进程 sshops-vault serve
 * - stdio JSON-RPC 2.0
 * - 自动重连（指数退避）
 * - 失败事件：把 VaultRpcError 抛给上层
 */
import { spawn, ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { getLogger } from '../observability/logging.js';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config/loader.js';
import {
  VAULT_METHODS,
  VAULT_ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type VaultMethod,
  type AcquireParams,
  type AcquireResult,
  type ExecuteParams,
  type ExecuteResult,
  type SetCredentialParams,
  type RotateParams,
  VaultRpcError,
} from './types.js';

const log = getLogger().child({ component: 'vault.client' });

export interface VaultClientOptions {
  binary?: string;
  autoStart?: boolean;
  reconnect?: {
    maxRetries: number;
    initialDelayMs: number;
    backoffFactor: number;
  };
}

export class VaultClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; method: string; startTime: number }>();
  private notifications: ((n: { method: string; params: unknown }) => void)[] = [];
  private buf = '';
  private ready: Promise<void> | null = null;
  private shuttingDown = false;
  private opts: Required<VaultClientOptions>;

  constructor(opts: VaultClientOptions = {}) {
    const cfg = getConfig();
    this.opts = {
      binary: opts.binary ?? cfg.vault?.binary ?? 'sshops-vault',
      autoStart: opts.autoStart ?? cfg.vault?.autoStart ?? true,
      reconnect: opts.reconnect ?? {
        maxRetries: 3,
        initialDelayMs: 500,
        backoffFactor: 2,
      },
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return;
    if (!this.opts.autoStart) {
      throw new Error('vault not running and autoStart is false');
    }
    await this.startProcess();
  }

  async call<T = unknown>(method: VaultMethod | string, params?: unknown): Promise<T> {
    await this.ensureStarted();
    await this.ready;
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, method, startTime: Date.now() });
      this.writeMessage(req);
    });
  }

  /** 显式发送 notification（不需要 id） */
  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    const msg = { jsonrpc: '2.0', method, params };
    this.writeMessage(msg);
  }

  onNotification(cb: (n: { method: string; params: unknown }) => void): void {
    this.notifications.push(cb);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (!this.proc) return;
    try {
      await this.call('vault.shutdown');
    } catch {
      // ignore
    }
    await wait(200);
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.proc = null;
  }

  // ---------- typed convenience methods ----------
  async listHosts() {
    return this.call<{ hosts: Array<{
      alias: string;
      host: string;
      user: string;
      port: number;
      authType: 'password' | 'privateKey';
      lastConnectedAt: string | null;
      lastSuccessAt: string | null;
      tags: string[];
    }> }>(VAULT_METHODS.LIST_HOSTS);
  }

  /**
   * v1：直接从 keychain 取凭证（不创建 connection）。
   * 用法：ssh_ssh_connect 缺 password 时，agent 调用此方法拿到密码注入到 tool args。
   * 注意：返回的 secret 会进入 LLM 上下文（作为 tool call 参数）。这是 v1 妥协。
   */
  async getCredential(p: { alias: string }): Promise<string | null> {
    const r = await this.call<{ secret: string | null }>(VAULT_METHODS.GET_CREDENTIAL, p);
    return r?.secret ?? null;
  }

  async acquire(p: AcquireParams) {
    return this.call<AcquireResult>(VAULT_METHODS.ACQUIRE, p);
  }

  async execute(p: ExecuteParams) {
    return this.call<ExecuteResult>(VAULT_METHODS.EXECUTE, p);
  }

  async setCredential(p: SetCredentialParams) {
    return this.call<{ ok: true; keychainAccount: string }>(VAULT_METHODS.SET_CREDENTIAL, p);
  }

  async rotate(p: RotateParams) {
    return this.call<{ ok: true; rotatedAt: number }>(VAULT_METHODS.ROTATE, p);
  }

  // ---------- private ----------
  private async startProcess(): Promise<void> {
    this.ready = new Promise<void>((resolve, reject) => {
      const onFirstResponse = (id: number, resp: JsonRpcResponse) => {
        if (id === 1 && 'result' in resp) {
          log.info({ result: resp.result }, 'vault daemon handshake ok');
          resolve();
        }
      };
      this.pending.set(1, {
        resolve: (r) => {
          onFirstResponse(1, { jsonrpc: '2.0', id: 1, result: r } as JsonRpcResponse);
        },
        reject,
        method: VAULT_METHODS.HELLO,
        startTime: Date.now(),
      });
    });

    // 关键修复：原本简单的 "spawn('sshops-vault', ['serve'])" 假设有独立二进制，
    // 但 v1 单二进制分发下没有 sshops-vault 文件存在。resolveBinaryPath 在
    // binary='' 时会把 dist 目录当二进制返回，spawn ENOENT。
    //
    // 正确策略：
    //   1. binary 有值 → 用它作为独立可执行（old-school 分发模式）
    //   2. binary 为空 → 用当前进程的 node + 当前入口 + ['vault', 'serve']
    //      （单二进制模式，vault 作为子命令由主 CLI 调度）
    const { command, args } = this.resolveSpawnCommand(this.opts.binary);
    log.info({ binary: command, args, mode: this.opts.binary ? 'standalone' : 'subcommand' }, 'spawning vault daemon');
    // Windows 修复：npx.cmd / 其它 .cmd 是 batch 文件，posix_spawnp 不能直接执行，
    // 会返回 EINVAL。两种修法：
    //   1) shell: true — Node 会用 cmd.exe 包装，但会把 args 拼成字符串传给 shell，
    //      含空格/引号的参数会被 cmd 二次解析，可能被改写。
    //   2) 直接 spawn cmd.exe /c —— 参数结构保留更安全。
    // 我们走 (2)：先把 command 拼到 args 前面，command 改成 cmd.exe。
    const isWin = process.platform === 'win32';
    const isCmd = command.toLowerCase().endsWith('.cmd') || command.toLowerCase().endsWith('.bat');
    let finalCommand = command;
    let finalArgs = args;
    if (isWin && isCmd) {
      finalCommand = 'cmd.exe';
      finalArgs = ['/d', '/s', '/c', command, ...args];
    }
    try {
      this.proc = spawn(finalCommand, finalArgs, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      log.error({ err: String(err), finalCommand, finalArgs }, 'spawn() threw synchronously');
      this.proc = null;
      this.ready = null;
      throw err;
    }
    // 挂 error guard：避免 stdio EPIPE 触发 uncaughtException
    this.attachStdioGuards(this.proc);
    this.proc.once('error', (err) => {
      // 关键：spawn 失败（如 EINVAL）时，proc 已存在但 stdin/stdout 不可用。
      // 不重置 this.proc 的话，ensureStarted 会被早退阻塞。
      log.error({ err: String(err), code: (err as NodeJS.ErrnoException).code }, 'vault daemon spawn error');
      this.proc = null;
      this.ready = null;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });

    this.proc.stdout!.setEncoding('utf-8');
    this.proc.stdout!.on('data', (chunk: string) => this.handleStdout(chunk));
    this.proc.on('exit', (code) => {
      log.warn({ code }, 'vault daemon exited');
      this.proc = null;
      this.ready = null;
      // 拒绝所有 pending
      for (const [, p] of this.pending) p.reject(new Error(`vault daemon exited (code ${code})`));
      this.pending.clear();
    });

    // 触发 hello
    setTimeout(() => {
      this.writeMessage({ jsonrpc: '2.0', id: 1, method: VAULT_METHODS.HELLO, params: { agentVersion: '0.2.0', pid: process.pid } });
    }, 50);
  }

  private handleStdout(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    if (!line || line.startsWith('#')) return; // 注释/keepalive
    let resp: JsonRpcResponse | { method: string; params?: unknown };
    try {
      resp = JSON.parse(line) as typeof resp;
    } catch (err) {
      log.warn({ line: line.slice(0, 80) }, 'invalid JSON from vault');
      return;
    }
    // 通知
    if (!('id' in resp) && 'method' in resp) {
      for (const cb of this.notifications) {
        try {
          cb({ method: resp.method, params: resp.params });
        } catch (err) {
          log.warn({ err: String(err) }, 'notification handler error');
        }
      }
      return;
    }
    // 响应
    const r = resp as JsonRpcResponse;
    const id = r.id as number;
    const pending = this.pending.get(id);
    if (!pending) {
      log.warn({ id }, 'response with no pending call');
      return;
    }
    this.pending.delete(id);
    if ('error' in r) {
      const err = new VaultRpcError(r.error.code, r.error.message, r.error.data);
      pending.reject(err);
    } else {
      pending.resolve(r.result);
    }
  }

  private writeMessage(msg: object): void {
    if (!this.proc?.stdin?.writable) {
      log.error('stdin not writable, dropping message');
      return;
    }
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      log.error({ err: String(err) }, 'stdin write failed');
    }
  }

  private attachStdioGuards(proc: ChildProcess): void {
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue;
      stream.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
          log.warn({ code: err.code }, 'vault stdio EPIPE ignored');
          return;
        }
        log.error({ err: err.message, code: err.code }, 'vault stdio error');
      });
    }
  }

  /**
   * 解析 vault daemon 的启动命令。
   *
   * 返回 { command, args } 而不是单一字符串，因为 v1 单二进制分发场景下：
   *   - 旧设计：spawn('sshops-vault', ['serve']) — 假设有独立二进制
   *   - 新设计：spawn('node', ['<dist>/main.js', 'vault', 'serve']) — 复用主二进制
   *
   * 解析策略：
   *   1. opts.binary 有值且文件存在 → 用它作为独立可执行
   *   2. opts.binary 为空 / 不存在 → 退化到当前进程的 node + 当前入口 + 子命令
   *
   * 不会返回 dist 目录之类"看起来存在但实际不是可执行"的东西。
   */
  private resolveSpawnCommand(binary: string): { command: string; args: string[] } {
    // 模式 1：用户显式指定了独立二进制
    if (binary && binary.trim().length > 0) {
      const resolved = this.resolveStandaloneBinary(binary);
      if (resolved) {
        return { command: resolved, args: ['serve'] };
      }
      // 用户指定了 binary 但解析失败：fallback 到子命令模式，并记 warn
      log.warn(
        { binary },
        'configured vault binary not found, falling back to subcommand mode (single-binary distribution)'
      );
    }
    // 模式 2：单二进制子命令模式
    return this.resolveSubcommandMode();
  }

  private resolveStandaloneBinary(binary: string): string | null {
    // 直接使用
    if (existsSync(binary)) return binary;
    // 候选 1：node_modules/.bin/<name>.cmd（Windows）或 <name>（Unix）
    try {
      const here = fileURLToPath(import.meta.url);
      const local = resolve(
        dirname(here),
        '..',
        '..',
        'node_modules',
        '.bin',
        binary + (process.platform === 'win32' ? '.cmd' : '')
      );
      if (existsSync(local)) return local;
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * 找到当前 agent 进程的入口脚本（dist/main.js 或 src/main.ts），
   * 然后用同一个 node + 子命令 'vault serve' 来启动 daemon。
   */
  private resolveSubcommandMode(): { command: string; args: string[] } {
    // 当前进程的入口（dist/main.js 或 src/main.ts）
    const here = process.argv[1] ?? '';
    // 兜底：根据 import.meta.url 推断
    let script = here;
    if (!script || !existsSync(script)) {
      try {
        const hereFile = fileURLToPath(import.meta.url);
        // client.ts 位于 dist/vault/client.js，回退到 dist/main.js
        const candidate = resolve(dirname(hereFile), '..', 'main.js');
        if (existsSync(candidate)) {
          script = candidate;
        } else {
          // 开发模式：src/vault/client.ts → src/main.ts
          const devCandidate = resolve(dirname(hereFile), '..', '..', 'main.ts');
          if (existsSync(devCandidate)) script = devCandidate;
        }
      } catch {
        // ignore
      }
    }
    if (script && existsSync(script)) {
      // 关键修复：dev 模式（.ts 源文件 + tsx 加载器）下，原生 node 无法解析
      // `.js` import → `.ts` 文件，会 ERR_MODULE_NOT_FOUND。
      // 改用 `npx tsx` 加载器，让子进程也能跑 .ts 源。
      if (script.endsWith('.ts')) {
        // Windows 下 npx 必须用 npx.cmd（posix_spawnp 不能直接 spawn npx）
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        return {
          command: npxCmd,
          args: ['tsx', script, 'vault', 'serve'],
        };
      }
      return {
        command: process.execPath,
        args: [script, 'vault', 'serve'],
      };
    }
    // 最后的兜底：尝试 node_modules/.bin/sshops-agent
    try {
      const here = fileURLToPath(import.meta.url);
      const shim = resolve(
        dirname(here),
        '..',
        '..',
        'node_modules',
        '.bin',
        'sshops-agent' + (process.platform === 'win32' ? '.cmd' : '')
      );
      if (existsSync(shim)) {
        return { command: shim, args: ['vault', 'serve'] };
      }
    } catch {
      // ignore
    }
    // 实在找不到：返回一个肯定会失败的命令，让上层报清晰错误
    log.error(
      { argv1: process.argv[1] },
      'cannot determine sshops-agent entry path for vault subcommand; set vault.binary in config/vault.yaml'
    );
    return {
      command: process.execPath,
      args: ['__sshops_agent_entry_not_found__', 'vault', 'serve'],
    };
  }
}

// 单例（agent 侧）
let _client: VaultClient | null = null;
export function getVaultClient(): VaultClient {
  if (!_client) _client = new VaultClient();
  return _client;
}
