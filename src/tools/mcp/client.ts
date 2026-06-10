/**
 * MCP 客户端封装
 *
 * - 基于 @modelcontextprotocol/sdk 的 stdio 传输
 * - 启动子进程
 * - listTools 缓存（会话级 TTL）
 * - callTool 含超时与重试
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../../config/loader.js';
import {
  MCPServerError,
  ToolExecutionError,
  ToolTimeoutError,
  RetryExhaustedError,
} from '../../utils/errors.js';
import { getLogger } from '../../observability/logging.js';
import { getConfig } from '../../config/loader.js';

const log = getLogger().child({ component: 'mcp.client' });

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

export class MCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private toolsCache: { tools: McpToolDescriptor[]; cachedAt: number } | null = null;
  private cfg: McpServerConfig;
  public readonly serverName: string;

  constructor(serverName: string, cfg: McpServerConfig) {
    this.serverName = serverName;
    this.cfg = cfg;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    // 解析环境变量
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [k, v] of Object.entries(this.cfg.env)) {
      env[k] = expandEnv(v, getConfig().env as unknown as Record<string, string>);
    }

    this.transport = new StdioClientTransport({
      command: this.cfg.command,
      args: this.cfg.args,
      env,
    });

    // 在 transport 上挂 'error' 监听：避免父进程退出后子进程写 stdio 触发未捕获 EPIPE
    // （MCP SDK 自身在某些版本未处理此事件）
    attachTransportErrorGuard(this.transport, this.serverName);

    this.client = new Client(
      { name: 'sshops-agent', version: '0.1.0' },
      { capabilities: {} }
    );

    const start = Date.now();
    try {
      // 关键修复：MCP SDK 1.29 的默认请求超时是 60s（DEFAULT_REQUEST_TIMEOUT_MSEC），
      // 比我们 config 里配的 120s 短。必须显式把 { timeout } 传给 connect()，
      // 否则 SDK 会先于我们的 wrapper timeout 报 -32001 错误。
      const connectOptions = {
        timeout: this.cfg.startupTimeoutMs,
        // maxTotalTimeout 比单次 timeout 更宽松，给冷启动留够时间
        maxTotalTimeout: this.cfg.startupTimeoutMs,
        // resetTimeoutOnProgress: SDK 收到 progress notification 时不重置 timer，
        // 但 initialize 阶段通常没有 progress。我们保持默认 false。
        resetTimeoutOnProgress: false,
      };
      await Promise.race([
        this.client.connect(this.transport, connectOptions),
        sleep(this.cfg.startupTimeoutMs).then(() => {
          // 我们的兜底超时：理论上不会触发（因为 SDK 已经被传了更长 timeout），
          // 但保留作为最后一道防线。
          forceKillTransportChild(this.transport, this.serverName);
          try {
            void this.transport?.close();
          } catch (cleanupErr) {
            log.warn(
              { server: this.serverName, err: String(cleanupErr) },
              'transport cleanup error after timeout'
            );
          }
          throw new MCPServerError(
            `mcp server ${this.serverName} startup timeout after ${this.cfg.startupTimeoutMs}ms — consider warming up: \`npx -y mcp-server-ssh &\` once to fill npm cache, or increase startupTimeoutMs in config/tools.yaml`,
            this.serverName
          );
        }),
      ]);
      log.info({ server: this.serverName, ms: Date.now() - start }, 'mcp server connected');
    } catch (err) {
      // 二次清理：即使 client.connect 报错，也要确保子进程不残留
      // 关键是 force-kill 子进程，否则它会写已经关闭的 pipe 触发 EPIPE 崩溃
      forceKillTransportChild(this.transport, this.serverName);
      try {
        await this.transport?.close();
      } catch (cleanupErr) {
        log.warn(
          { server: this.serverName, err: String(cleanupErr) },
          'transport cleanup error after connect failure'
        );
      }
      this.transport = null;
      this.client = null;
      throw new MCPServerError(
        `failed to connect mcp server ${this.serverName}: ${String(err)}`,
        this.serverName
      );
    }
  }

  async listTools(force = false): Promise<McpToolDescriptor[]> {
    if (!this.client) await this.connect();
    if (
      !force &&
      this.toolsCache &&
      Date.now() - this.toolsCache.cachedAt < this.cfg.toolCacheTtlMs
    ) {
      return this.toolsCache.tools;
    }
    const start = Date.now();
    const res = await this.client!.listTools();
    const tools: McpToolDescriptor[] = res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as McpToolDescriptor['inputSchema']) ?? { type: 'object' },
    }));
    this.toolsCache = { tools, cachedAt: Date.now() };
    log.info(
      { server: this.serverName, count: tools.length, ms: Date.now() - start },
      'mcp tools discovered'
    );
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) await this.connect();
    const maxRetries = 2; // MCP 层仅做轻量重试
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const start = Date.now();
        const result = await Promise.race([
          this.client!.callTool({ name, arguments: args }),
          sleep(this.cfg.callTimeoutMs).then(() => {
            throw new ToolTimeoutError(name, this.cfg.callTimeoutMs);
          }),
        ]);
        log.info(
          { server: this.serverName, tool: name, ms: Date.now() - start },
          'mcp tool called'
        );
        return result;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === maxRetries) {
          if (err instanceof ToolTimeoutError) throw err;
          if (attempt === maxRetries) {
            throw new RetryExhaustedError(
              `mcp tool ${name} failed after ${attempt + 1} attempts: ${String(err)}`,
              attempt + 1
            );
          }
          throw new ToolExecutionError(name, err);
        }
        const delay = 1000 * Math.pow(2, attempt);
        log.warn({ tool: name, attempt, delay, err: String(err) }, 'mcp tool retry');
        await sleep(delay);
      }
    }
    throw new ToolExecutionError(name, lastErr);
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch (err) {
      log.warn({ err: String(err) }, 'mcp close error');
    }
    this.client = null;
    this.transport = null;
    this.toolsCache = null;
  }

  invalidateCache(): void {
    this.toolsCache = null;
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ToolTimeoutError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('pipe closed') ||
    msg.includes('broken pipe')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function expandEnv(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name, def) => {
    return env[name] ?? process.env[name] ?? def ?? '';
  });
}

/**
 * 给 StdioClientTransport 挂载防御性 'error' 监听。
 *
 * 背景：MCP SDK 1.0.x 系列的 StdioClientTransport 内部把 child process 的
 * stdout/stderr 包装成 Socket。父进程 (sshops-agent) 退出时 pipe 关闭，
 * 子进程若仍尝试写 stdio，Socket 触发 'error' 事件（EPIPE）。
 * 该 SDK 在某些版本未注册 'error' 事件，会导致 Node 抛出 uncaughtException
 * 进程崩溃。
 *
 * 解决方案：在父进程侧 monkey-patch transport._process 的 stdout/stderr，
 * 注册 'error' handler 把 EPIPE 降级为 warn。
 */
function attachTransportErrorGuard(
  transport: StdioClientTransport,
  serverName: string
): void {
  // 异步处理：在子进程 spawn 之后才挂 error 监听
  // StdioClientTransport 启动后会有一个 `_process` 字段引用 child
  const tryAttach = (): boolean => {
    const proc = (transport as unknown as { _process?: { stdout?: NodeJS.ReadableStream; stderr?: NodeJS.ReadableStream } })._process;
    if (!proc) return false;
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue;
      stream.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
          log.warn(
            { server: serverName, code, err: err.message },
            'mcp stdio stream error (parent likely exiting, ignoring)'
          );
          return;
        }
        log.error(
          { server: serverName, err: err.message, code },
          'mcp stdio stream error'
        );
      });
    }
    return true;
  };
  // 立即尝试一次（connect 调用前 _process 可能尚未生成）
  if (tryAttach()) return;
  // 轮询兜底：最多等 5s，每 50ms 重试
  let attempts = 0;
  const t = setInterval(() => {
    if (tryAttach() || ++attempts > 100) clearInterval(t);
  }, 50);
}

/**
 * 强制 kill StdioClientTransport 持有的子进程。
 *
 * 背景：MCP SDK 的 StdioClientTransport.close() 仅 end() stdin 并等待 2s，
 * 不会主动 SIGKILL 子进程。如果子进程仍想写 stdout（已 broken pipe），
 * 它会触发 EPIPE unhandled error 崩溃。
 *
 * 解决方案：直接拿到 _process 句柄发 SIGKILL。这会同步杀掉子进程及其
 * 所有后代（npx -> node -> mcp-server-ssh），根本不会触发 EPIPE。
 */
function forceKillTransportChild(
  transport: StdioClientTransport | null,
  serverName: string
): void {
  if (!transport) return;
  const proc = (transport as unknown as { _process?: { killed?: boolean; kill?: (sig?: string) => boolean; pid?: number } })._process;
  if (!proc) return;
  if (proc.killed) return;
  if (typeof proc.kill !== 'function') {
    // 测试 mock 可能没有 kill 方法；这种情况下 skip 即可
    return;
  }
  try {
    proc.kill('SIGKILL');
    log.warn({ server: serverName, pid: proc.pid }, 'mcp child process SIGKILLed to prevent EPIPE');
  } catch (err) {
    log.warn(
      { server: serverName, err: String(err) },
      'failed to SIGKILL mcp child (may have already exited)'
    );
  }
}
