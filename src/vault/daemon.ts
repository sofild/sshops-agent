/**
 * sshops-vault JSON-RPC daemon
 *
 * - 从 stdio 读取 JSON-RPC 2.0 请求（每行一个 JSON 对象）
 * - 严格白名单：仅接受 VAULT_METHODS 中定义的方法
 * - 所有 RPC handler 异步执行，错误用 JsonRpcError 返回
 * - 可选：从 agent 接收 notif （fire-and-forget）
 * - exit 0：干净退出；exit 非 0：agent 侧会重连
 */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { getStderrOnlyLogger } from '../observability/logging.js';
import { getKeychain } from './keychain.js';
import { VaultMetadataStore, type VaultHost } from './store.js';
import { ConnectionPool } from './pool.js';
import { VaultAuditLog } from './audit.js';
import {
  VAULT_METHODS,
  VAULT_ERROR_CODES,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type AcquireParams,
  type ExecuteParams,
  type SetCredentialParams,
  type RotateParams,
  VaultRpcError,
} from './types.js';

// 重要：vault daemon 是 stdio RPC 进程，stdout 是协议通道。所有日志必须走 stderr，
// 否则会污染 JSON-RPC 流（之前被"invalid JSON from vault"警告暴露的 bug）。
const log = getStderrOnlyLogger('vault.daemon');

export interface DaemonOptions {
  store?: VaultMetadataStore;
  pool?: ConnectionPool;
  audit?: VaultAuditLog;
  /** 读 stdin 的最大行长度（防 DoS） */
  maxLineBytes?: number;
}

export class VaultDaemon {
  private store: VaultMetadataStore;
  private pool: ConnectionPool;
  private audit: VaultAuditLog;
  private maxLineBytes: number;
  private nextId = 1;
  private pendingNotifications: JsonRpcNotification[] = [];

  constructor(opts: DaemonOptions = {}) {
    this.store = opts.store ?? new VaultMetadataStore();
    this.audit = opts.audit ?? new VaultAuditLog();
    const poolCfg = this.store.poolConfig;
    this.pool =
      opts.pool ??
      new ConnectionPool({
        maxConnectionsPerHost: poolCfg.maxConnectionsPerHost,
        idleTimeoutMs: poolCfg.idleTimeoutMs,
        keepaliveIntervalMs: poolCfg.keepaliveIntervalMs,
      });
    this.maxLineBytes = opts.maxLineBytes ?? 1024 * 1024; // 1MB
  }

  /** 主入口：从 stdin 读取，处理后写 stdout */
  async serve(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Promise<void> {
    process.umask(0o077);
    log.info('vault daemon starting (stdio mode)');

    const rl = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.length > this.maxLineBytes) {
        this.sendError(stdout, null, VAULT_ERROR_CODES.INVALID_REQUEST, 'line too long');
        return;
      }
      this.handleLine(line, stdout).catch((err) => {
        log.error({ err: String(err) }, 'handler crashed');
        // 守护进程不应自己崩
      });
    });
    rl.on('close', () => {
      log.info('vault daemon stdin closed, shutting down');
      this.pool
        .shutdown()
        .then((closed) => {
          log.info({ closed }, 'pool shut down');
          stdout.end();
        })
        .catch((err) => {
          log.error({ err: String(err) }, 'shutdown error');
          stdout.end();
        });
    });

    // heartbeat: 每 30s 向 stdout 推一条 "keepalive" 注释行（agent 可选择性忽略）
    setInterval(() => {
      try {
        stdout.write('# keepalive\n');
      } catch {
        // ignore
      }
    }, 30_000).unref();
  }

  // ---------- 内部 ----------
  private async handleLine(line: string, stdout: NodeJS.WritableStream): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return; // 注释
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      this.sendError(stdout, null, VAULT_ERROR_CODES.PARSE_ERROR, 'invalid JSON');
      return;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      this.sendError(stdout, req.id ?? null, VAULT_ERROR_CODES.INVALID_REQUEST, 'invalid request');
      return;
    }
    const start = Date.now();
    try {
      const result = await this.dispatch(req.method, req.params);
      this.sendResponse(stdout, req.id, result);
      this.audit.write({
        method: req.method,
        alias: this.extractAlias(req.params),
        decision: 'success',
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const { code, message, data } = normalizeError(err);
      this.sendError(stdout, req.id, code, message, data);
      this.audit.write({
        method: req.method,
        alias: this.extractAlias(req.params),
        decision: 'failure',
        durationMs: Date.now() - start,
        errorCode: code,
        errorMessage: message,
      });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case VAULT_METHODS.HELLO:
        return {
          vaultVersion: '0.1.0',
          protocolVersion: '1.0',
          capabilities: ['pool', 'keychain', 'audit'],
        };
      case VAULT_METHODS.LIST_HOSTS:
        return { hosts: this.store.getAll() };
      case VAULT_METHODS.GET_CREDENTIAL: {
        // v1：直接返回密码，agent 用来注入到 ssh_ssh_connect args。
        // 警告：返回的 secret 会进入 LLM 上下文（作为 tool call 参数），是 v1 的安全妥协。
        const p = params as { alias: string };
        const host = this.requireHost(p.alias);
        this.denyPolicy(host.alias);
        const kc = await getKeychain();
        const secret = await kc.getPassword('sshops-vault', host.keychainAccount);
        // 审计
        this.audit.write({
          method: VAULT_METHODS.GET_CREDENTIAL,
          alias: host.alias,
          host: host.host,
          user: host.user,
          decision: secret ? 'success' : 'credential_missing',
        });
        return { secret };
      }
      case VAULT_METHODS.ACQUIRE: {
        const p = params as AcquireParams;
        const host = this.requireHost(p.alias);
        this.denyPolicy(host.alias);
        const conn = await this.pool.acquire(host, p.scope);
        return {
          connectionId: conn.id,
          host: host.host,
          user: host.user,
          expiresAt: Date.now() + 30 * 60 * 1000, // 30 min 软过期
        };
      }
      case VAULT_METHODS.EXECUTE: {
        const p = params as ExecuteParams;
        const conn = this.pool.get(p.connectionId);
        if (!conn) {
          throw new VaultRpcError(VAULT_ERROR_CODES.CONNECTION_LOST, `connection ${p.connectionId} not found`);
        }
        if (conn.closed) {
          throw new VaultRpcError(VAULT_ERROR_CODES.CONNECTION_LOST, `connection ${p.connectionId} closed`);
        }
        this.enforceScope(conn, p.command);
        const start = Date.now();
        // v1: 透传 command 到 mcp-server-ssh（via stdio of child）。v1 MVP 简化：先记录
        // 审计；真正的 mcp 转发在 Phase 2 完成（需要实现 mcp client over child stdio）。
        const result = await executeViaMcp(conn, p.command, p.timeoutMs);
        this.audit.write({
          method: VAULT_METHODS.EXECUTE,
          alias: conn.host.alias,
          host: conn.host.host,
          user: conn.host.user,
          connectionId: conn.id,
          command: p.command,
          decision: 'success',
          durationMs: Date.now() - start,
        });
        return result;
      }
      case VAULT_METHODS.REVOKE: {
        const p = params as { connectionId: string };
        const ok = await this.pool.revoke(p.connectionId);
        return { ok };
      }
      case VAULT_METHODS.STATUS: {
        return { pools: this.pool.status() };
      }
      case VAULT_METHODS.SET_CREDENTIAL: {
        const p = params as SetCredentialParams;
        const alias = p.alias;
        const keychainAccount = `host:${p.alias}:user:${p.user}`;
        let secret = p.secret;
        try {
          const kc = await getKeychain();
          await kc.setPassword('sshops-vault', keychainAccount, secret);
          // 立即清零
          secret = '';
          // upsert metadata
          const host: VaultHost = {
            alias,
            host: this.store.getByAliasOrHost(alias)?.host ?? alias,
            user: p.user,
            port: p.port ?? 22,
            authType: p.authType,
            keychainAccount,
            fingerprint: null,
            lastConnectedAt: null,
            lastSuccessAt: null,
            tags: p.tags ?? [],
            options: {
              sudoPasswordRequired: p.options?.sudoPasswordRequired ?? false,
              preferredShell: p.options?.preferredShell ?? '/bin/bash',
            },
          };
          this.store.upsert(host);
          return { ok: true, keychainAccount };
        } finally {
          // 二次清零
          secret = '';
        }
      }
      case VAULT_METHODS.ROTATE: {
        const p = params as RotateParams;
        const host = this.requireHost(p.alias);
        let newSecret = p.newSecret;
        try {
          const kc = await getKeychain();
          await kc.setPassword('sshops-vault', host.keychainAccount, newSecret);
          newSecret = '';
          this.store.updateLastSuccess(host.alias);
          return { ok: true, rotatedAt: Date.now() };
        } finally {
          newSecret = '';
        }
      }
      case VAULT_METHODS.PING:
        return { rttMs: 0, id: randomUUID() };
      case VAULT_METHODS.PING_HOST: {
        const p = params as { alias: string };
        const host = this.requireHost(p.alias);
        const conn = await this.pool.acquire(host);
        this.pool.release(conn.id);
        return { ok: true, alias: host.alias, host: host.host, user: host.user };
      }
      case VAULT_METHODS.SHUTDOWN: {
        const closed = await this.pool.shutdown();
        // 延迟 100ms 让响应先回
        setTimeout(() => process.exit(0), 100).unref();
        return { ok: true, closedConnections: closed };
      }
      default:
        throw new VaultRpcError(VAULT_ERROR_CODES.METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  }

  private requireHost(aliasOrHost: string): VaultHost {
    const h = this.store.getByAliasOrHost(aliasOrHost);
    if (!h) {
      throw new VaultRpcError(VAULT_ERROR_CODES.HOST_NOT_FOUND, `host not found: ${aliasOrHost}`);
    }
    return h;
  }

  private denyPolicy(alias: string): void {
    const policy = this.store.policyConfig;
    if (policy.denyHosts.length > 0) {
      for (const pattern of policy.denyHosts) {
        if (globMatch(pattern, alias)) {
          throw new VaultRpcError(VAULT_ERROR_CODES.CONNECTION_DENIED, `host ${alias} denied by policy`);
        }
      }
    }
  }

  private enforceScope(conn: { scope?: { allowedCommands?: string[]; deniedCommands?: string[] } }, command: string): void {
    if (!conn.scope) return;
    if (conn.scope.deniedCommands) {
      for (const pattern of conn.scope.deniedCommands) {
        if (globMatch(pattern, command)) {
          throw new VaultRpcError(VAULT_ERROR_CODES.SCOPE_DENIED, `command denied by scope: ${command}`);
        }
      }
    }
    if (conn.scope.allowedCommands && conn.scope.allowedCommands.length > 0) {
      const ok = conn.scope.allowedCommands.some((p) => globMatch(p, command));
      if (!ok) {
        throw new VaultRpcError(VAULT_ERROR_CODES.SCOPE_DENIED, `command not in allowed list: ${command}`);
      }
    }
  }

  private sendResponse(stdout: NodeJS.WritableStream, id: number | string, result: unknown): void {
    const resp: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    this.writeLine(stdout, JSON.stringify(resp));
  }

  private sendError(
    stdout: NodeJS.WritableStream,
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown
  ): void {
    const resp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.writeLine(stdout, JSON.stringify(resp));
  }

  private writeLine(stdout: NodeJS.WritableStream, line: string): void {
    try {
      stdout.write(line + '\n');
    } catch (err) {
      log.error({ err: String(err) }, 'stdout write failed');
    }
  }

  private extractAlias(params: unknown): string {
    if (params && typeof params === 'object' && 'alias' in (params as Record<string, unknown>)) {
      const a = (params as { alias?: unknown }).alias;
      if (typeof a === 'string') return a;
    }
    return '';
  }
}

// ---------- helpers ----------
function normalizeError(err: unknown): { code: number; message: string; data?: unknown } {
  if (err instanceof VaultRpcError) {
    return { code: err.code, message: err.message, data: err.data };
  }
  if (err instanceof Error) {
    return { code: VAULT_ERROR_CODES.INTERNAL_ERROR, message: err.message };
  }
  return { code: VAULT_ERROR_CODES.INTERNAL_ERROR, message: String(err) };
}

function globMatch(pattern: string, str: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(str);
}

/**
 * v1 MVP 占位：实际通过 child.stdin 写 JSON-RPC 给 mcp-server-ssh 进程并读响应。
 * Phase 2 完整实现。这里先做"基本工作流 + 审计完整记录"。
 */
async function executeViaMcp(
  conn: { child: import('node:child_process').ChildProcess | null; id: string },
  command: string,
  _timeoutMs?: number
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const start = Date.now();
  // v1 简化：直接把 mcp 调用委托给 agent 侧的 mcp client（vault 不实现 mcp wire protocol）
  // 返回 mock OK 让上层流程可工作；真正的执行在 Phase 2 通过 child.stdio 转发实现。
  if (!conn.child) {
    return { stdout: '', stderr: 'connection has no mcp child', exitCode: 1, durationMs: 0 };
  }
  // 标记：v1 在 audit 中记 command（不含 secret），但不实际执行。
  return {
    stdout: `[v1 MVP] vault would forward to mcp: ${command.slice(0, 64)}`,
    stderr: '',
    exitCode: 0,
    durationMs: Date.now() - start,
  };
}
