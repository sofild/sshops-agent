/**
 * 自研 SSH Provider → Tool 包装
 *
 * 把 SshProvider 的方法注册为 LLM 工具，与 mcp-server-ssh v1.0.2 的
 * 工具签名（名称、参数、描述、返回值格式）严格对齐，让 LLM 训练上下文不变。
 *
 * 工具命名（与 mcp-server-ssh 一致，LLM 工具调用代码不需要改）：
 *   - ssh_ssh_connect
 *   - ssh_ssh_exec
 *   - ssh_ssh_system_info
 *   - ssh_ssh_disconnect
 *   - ssh_ssh_list_connections
 *   - sftp_ls
 *   - sftp_read
 *   - sftp_write
 *   - sftp_mkdir
 *   - sftp_rm
 *   - sftp_mv
 *   - sftp_stat
 */
import { z } from 'zod';
import type { Tool } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  SshProvider,
  SshError,
  type SshConnectionInfo,
  type SshExecResult,
} from './provider.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'ssh.registry' });

// ---------- 工具结果辅助 ----------
function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function toErrorContent(err: unknown): { content: string; isError: true } {
  if (err instanceof SshError) {
    return {
      content: `error: ${err.message} (kind=${err.kind})`,
      isError: true,
    };
  }
  return {
    content: `error: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  };
}

// ---------- Schemas ----------
const ConnectArgsSchema = z.object({
  host: z.string().describe('SSH 服务器地址（IP 或域名）'),
  port: z.number().int().positive().default(22),
  username: z.string().describe('SSH 用户名'),
  password: z.string().optional().describe('密码（password 认证）'),
  privateKey: z.string().optional().describe('私钥内容（privateKey 认证）'),
  privateKeyPath: z.string().optional().describe('私钥文件路径（~ 可用）'),
  passphrase: z.string().optional().describe('私钥口令'),
  name: z.string().optional().describe('连接别名（默认 host:port）'),
});

const ExecArgsSchema = z.object({
  connectionId: z.string().describe('ssh_ssh_connect 返回的 connectionId'),
  command: z.string().describe('要执行的 shell 命令'),
  timeoutMs: z.number().int().positive().optional().describe('命令超时（毫秒）'),
});

const SystemInfoArgsSchema = z.object({
  connectionId: z.string().describe('ssh_ssh_connect 返回的 connectionId'),
});

const DisconnectArgsSchema = z
  .object({
    connectionId: z.string().optional().describe('要断开的连接 id；不传则断开全部'),
  });

const ListConnectionsArgsSchema = z.object({});

const SftpLsArgsSchema = z.object({
  connectionId: z.string(),
  path: z.string().describe('要列出的目录路径'),
});

const SftpReadArgsSchema = z.object({
  connectionId: z.string(),
  path: z.string().describe('要读取的文件路径'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  maxSize: z.number().int().positive().default(1024 * 1024),
});

const SftpWriteArgsSchema = z.object({
  connectionId: z.string(),
  path: z.string().describe('要写入的目标文件路径'),
  content: z.string().describe('文件内容（utf8 或 base64）'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  mode: z.number().int().optional().describe('八进制权限位，如 0o644'),
});

const SftpMkdirArgsSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
  recursive: z.boolean().default(false),
});

const SftpRmArgsSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
  recursive: z.boolean().default(false),
});

const SftpMvArgsSchema = z.object({
  connectionId: z.string(),
  source: z.string(),
  destination: z.string(),
});

const SftpStatArgsSchema = z.object({
  connectionId: z.string(),
  path: z.string(),
});

// ---------- 工具描述（与 mcp-server-ssh 描述对齐） ----------
const DESC_CONNECT =
  '建立一条新的 SSH 连接。必填：host、username；至少提供 password 或 privateKey(privateKeyPath) 其中之一。可选 port（默认 22）。返回 connectionId，供后续 ssh_ssh_exec / ssh_ssh_system_info / sftp_* 使用。';
const DESC_EXEC =
  '在已建立的 SSH 连接上执行一条 shell 命令，返回 stdout / stderr / exitCode。connectionId 必须来自 ssh_ssh_connect。可选 timeoutMs 覆盖默认超时。';
const DESC_SYSTEM_INFO =
  '采集目标主机的系统信息：hostname、OS、内核、uptime、CPU、内存、磁盘。等价于 ssh_ssh_exec 一串 uname / free / df 命令。';
const DESC_DISCONNECT =
  '断开指定 SSH 连接；不传 connectionId 则断开所有。';
const DESC_LIST_CONNECTIONS =
  '列出当前 provider 持有的所有活跃 SSH 连接（id / host / port / username / connectedAt / lastUsedAt）。';
const DESC_SFTP_LS =
  '列出远程目录下的文件，包含大小、权限、修改时间。';
const DESC_SFTP_READ =
  '读取远程文件内容到字符串，默认 utf8，可指定 base64 编码；maxSize 防止拉取过大文件。';
const DESC_SFTP_WRITE =
  '把字符串内容写入远程文件，可指定八进制权限 mode。';
const DESC_SFTP_MKDIR = '创建远程目录，recursive=true 等价于 mkdir -p。';
const DESC_SFTP_RM = '删除远程文件或目录，recursive=true 等价于 rm -rf。';
const DESC_SFTP_MV = '移动 / 重命名远程文件或目录。';
const DESC_SFTP_STAT = '查看远程文件或目录的元信息（大小、权限、修改时间等）。';

// ---------- 工厂 ----------
export function registerSshTools(registry: ToolRegistry, provider: SshProvider): void {
  // ssh_ssh_connect
  const sshConnectTool: Tool = {
    name: 'ssh_ssh_connect',
    description: DESC_CONNECT,
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        port: { type: 'number' },
        username: { type: 'string' },
        password: { type: 'string' },
        privateKey: { type: 'string' },
        privateKeyPath: { type: 'string' },
        passphrase: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['host', 'username'],
    },
    zodSchema: ConnectArgsSchema,
    async execute(args) {
      try {
        const a = ConnectArgsSchema.parse(args);
        const info: SshConnectionInfo = await provider.connect(a);
        return {
          content: toJson({
            id: info.connectionId,
            host: info.host,
            port: info.port,
            username: info.username,
            fingerprint: info.fingerprint,
            message: `SSH connection to ${info.username}@${info.host}:${info.port} established with id ${info.connectionId}`,
          }),
        };
      } catch (err) {
        log.warn({ err: String(err) }, 'ssh_ssh_connect failed');
        return toErrorContent(err);
      }
    },
  };

  // ssh_ssh_exec
  const sshExecTool: Tool = {
    name: 'ssh_ssh_exec',
    description: DESC_EXEC,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['connectionId', 'command'],
    },
    zodSchema: ExecArgsSchema,
    async execute(args) {
      try {
        const a = ExecArgsSchema.parse(args);
        const r: SshExecResult = await provider.exec(
          a.connectionId,
          a.command,
          a.timeoutMs
        );
        return {
          content: toJson({
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
          }),
          data: r,
          isError: r.exitCode !== 0,
        };
      } catch (err) {
        log.warn({ err: String(err) }, 'ssh_ssh_exec failed');
        return toErrorContent(err);
      }
    },
  };

  // ssh_ssh_system_info
  const sshSystemInfoTool: Tool = {
    name: 'ssh_ssh_system_info',
    description: DESC_SYSTEM_INFO,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
      },
      required: ['connectionId'],
    },
    zodSchema: SystemInfoArgsSchema,
    async execute(args) {
      try {
        const a = SystemInfoArgsSchema.parse(args);
        const r = await provider.systemInfo(a.connectionId);
        return {
          content: toJson({
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
          }),
          data: r,
          isError: r.exitCode !== 0,
        };
      } catch (err) {
        log.warn({ err: String(err) }, 'ssh_ssh_system_info failed');
        return toErrorContent(err);
      }
    },
  };

  // ssh_ssh_disconnect
  const sshDisconnectTool: Tool = {
    name: 'ssh_ssh_disconnect',
    description: DESC_DISCONNECT,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
      },
    },
    zodSchema: DisconnectArgsSchema,
    async execute(args) {
      try {
        const a = DisconnectArgsSchema.parse(args);
        const closed = await provider.disconnect(a.connectionId);
        return {
          content: toJson({ closed, message: `disconnected ${closed.length} connection(s)` }),
        };
      } catch (err) {
        log.warn({ err: String(err) }, 'ssh_ssh_disconnect failed');
        return toErrorContent(err);
      }
    },
  };

  // ssh_ssh_list_connections
  const sshListTool: Tool = {
    name: 'ssh_ssh_list_connections',
    description: DESC_LIST_CONNECTIONS,
    inputSchema: { type: 'object', properties: {} },
    zodSchema: ListConnectionsArgsSchema,
    async execute() {
      try {
        const conns = provider.listConnections();
        return { content: toJson({ connections: conns, count: conns.length }) };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  // sftp_ls
  const sftpLsTool: Tool = {
    name: 'sftp_ls',
    description: DESC_SFTP_LS,
    inputSchema: {
      type: 'object',
      properties: { connectionId: { type: 'string' }, path: { type: 'string' } },
      required: ['connectionId', 'path'],
    },
    zodSchema: SftpLsArgsSchema,
    async execute(args) {
      try {
        const a = SftpLsArgsSchema.parse(args);
        const r = await provider.sftpLs(a.connectionId, a.path);
        return {
          content: toJson({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }),
          data: r,
          isError: r.exitCode !== 0,
        };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  // sftp_read
  const sftpReadTool: Tool = {
    name: 'sftp_read',
    description: DESC_SFTP_READ,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
        maxSize: { type: 'number' },
      },
      required: ['connectionId', 'path'],
    },
    zodSchema: SftpReadArgsSchema,
    async execute(args) {
      try {
        const a = SftpReadArgsSchema.parse(args);
        const content = await provider.sftpRead(
          a.connectionId,
          a.path,
          a.encoding,
          a.maxSize
        );
        return { content: toJson({ content, encoding: a.encoding, path: a.path }) };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  // sftp_write
  const sftpWriteTool: Tool = {
    name: 'sftp_write',
    description: DESC_SFTP_WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
        mode: { type: 'number' },
      },
      required: ['connectionId', 'path', 'content'],
    },
    zodSchema: SftpWriteArgsSchema,
    async execute(args) {
      try {
        const a = SftpWriteArgsSchema.parse(args);
        await provider.sftpWrite(
          a.connectionId,
          a.path,
          a.content,
          a.encoding,
          a.mode
        );
        return {
          content: toJson({ ok: true, path: a.path, message: 'file written' }),
        };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  // sftp_mkdir
  const sftpMkdirTool: Tool = {
    name: 'sftp_mkdir',
    description: DESC_SFTP_MKDIR,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
      required: ['connectionId', 'path'],
    },
    zodSchema: SftpMkdirArgsSchema,
    async execute(args) {
      try {
        const a = SftpMkdirArgsSchema.parse(args);
        await provider.sftpMkdir(a.connectionId, a.path, a.recursive);
        return { content: toJson({ ok: true, path: a.path }) };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  // sftp_rm
  const sftpRmTool: Tool = {
    name: 'sftp_rm',
    description: DESC_SFTP_RM,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
      required: ['connectionId', 'path'],
    },
    zodSchema: SftpRmArgsSchema,
    async execute(args) {
      try {
        const a = SftpRmArgsSchema.parse(args);
        await provider.sftpRm(a.connectionId, a.path, a.recursive);
        return { content: toJson({ ok: true, path: a.path }) };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  // sftp_mv
  const sftpMvTool: Tool = {
    name: 'sftp_mv',
    description: DESC_SFTP_MV,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['connectionId', 'source', 'destination'],
    },
    zodSchema: SftpMvArgsSchema,
    async execute(args) {
      try {
        const a = SftpMvArgsSchema.parse(args);
        await provider.sftpMv(a.connectionId, a.source, a.destination);
        return { content: toJson({ ok: true, source: a.source, destination: a.destination }) };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  // sftp_stat
  const sftpStatTool: Tool = {
    name: 'sftp_stat',
    description: DESC_SFTP_STAT,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['connectionId', 'path'],
    },
    zodSchema: SftpStatArgsSchema,
    async execute(args) {
      try {
        const a = SftpStatArgsSchema.parse(args);
        const r = await provider.sftpStat(a.connectionId, a.path);
        return {
          content: toJson({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }),
          data: r,
          isError: r.exitCode !== 0,
        };
      } catch (err) {
        return toErrorContent(err);
      }
    },
  };

  registry.register(sshConnectTool);
  registry.register(sshExecTool);
  registry.register(sshSystemInfoTool);
  registry.register(sshDisconnectTool);
  registry.register(sshListTool);
  registry.register(sftpLsTool);
  registry.register(sftpReadTool);
  registry.register(sftpWriteTool);
  registry.register(sftpMkdirTool);
  registry.register(sftpRmTool);
  registry.register(sftpMvTool);
  registry.register(sftpStatTool);

  log.info('ssh tools registered (12)');
}
