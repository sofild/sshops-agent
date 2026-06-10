/**
 * sshops-vault JSON-RPC 类型定义
 *
 * 请求/响应/通知 严格分类型
 */
import { z } from 'zod';

// ---------- 基础类型 ----------
export const HostMetaSchema = z.object({
  alias: z.string(),
  host: z.string(),
  user: z.string(),
  port: z.number().int().positive().default(22),
  authType: z.enum(['password', 'privateKey']),
  lastConnectedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  tags: z.array(z.string()).default([]),
});
export type HostMeta = z.infer<typeof HostMetaSchema>;

export const HostMetaWithFingerprintSchema = HostMetaSchema.extend({
  fingerprint: z.string().nullable(),
  options: z
    .object({
      sudoPasswordRequired: z.boolean().default(false),
      preferredShell: z.string().default('/bin/bash'),
    })
    .default({}),
});
export type HostMetaWithFingerprint = z.infer<typeof HostMetaWithFingerprintSchema>;

export const ScopeSchema = z
  .object({
    allowedCommands: z.array(z.string()).optional(),
    deniedCommands: z.array(z.string()).optional(),
    requireSudo: z.boolean().optional(),
    maxDurationMs: z.number().int().positive().optional(),
  })
  .optional();
export type Scope = z.infer<typeof ScopeSchema>;

// ---------- RPC Params/Result ----------
export const AcquireParamsSchema = z.object({
  alias: z.string().min(1),
  scope: ScopeSchema,
});
export type AcquireParams = z.infer<typeof AcquireParamsSchema>;

export const AcquireResultSchema = z.object({
  connectionId: z.string(),
  host: z.string(),
  user: z.string(),
  expiresAt: z.number().int(),
});
export type AcquireResult = z.infer<typeof AcquireResultSchema>;

export const ExecuteParamsSchema = z.object({
  connectionId: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});
export type ExecuteParams = z.infer<typeof ExecuteParamsSchema>;

export const ExecuteResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
});
export type ExecuteResult = z.infer<typeof ExecuteResultSchema>;

export const SetCredentialParamsSchema = z.object({
  alias: z.string().min(1),
  user: z.string().min(1),
  authType: z.enum(['password', 'privateKey']),
  /** 实际密码/私钥内容。vault 写入 keychain 后立即清零内存引用 */
  secret: z.string().min(1),
  port: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
  options: z
    .object({
      sudoPasswordRequired: z.boolean().optional(),
      preferredShell: z.string().optional(),
    })
    .optional(),
});
export type SetCredentialParams = z.infer<typeof SetCredentialParamsSchema>;

export const RotateParamsSchema = z.object({
  alias: z.string().min(1),
  newSecret: z.string().min(1),
});
export type RotateParams = z.infer<typeof RotateParamsSchema>;

// ---------- JSON-RPC envelope ----------
export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: R;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcError;

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

// ---------- RPC 方法名常量 ----------
export const VAULT_METHODS = {
  HELLO: 'vault.hello',
  LIST_HOSTS: 'vault.listHosts',
  /** v1：直接取密码（不创建 connection）。agent 用来注入到 ssh_ssh_connect args。 */
  GET_CREDENTIAL: 'vault.getCredential',
  ACQUIRE: 'vault.acquire',
  EXECUTE: 'vault.execute',
  UPLOAD: 'vault.upload',
  DOWNLOAD: 'vault.download',
  REVOKE: 'vault.revoke',
  STATUS: 'vault.status',
  SET_CREDENTIAL: 'vault.setCredential',
  ROTATE: 'vault.rotate',
  PING: 'vault.ping',
  SHUTDOWN: 'vault.shutdown',
  PING_HOST: 'vault.pingHost', // 测试某个 alias 的连接
} as const;

export type VaultMethod = (typeof VAULT_METHODS)[keyof typeof VAULT_METHODS];

// ---------- 标准错误码 ----------
export const VAULT_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // 自定义
  CREDENTIAL_MISSING: -32001,
  AUTH_FAILED: -32002,
  CONNECTION_LOST: -32003,
  HOST_NOT_FOUND: -32004,
  CONNECTION_DENIED: -32005,
  SCOPE_DENIED: -32006,
} as const;

export class VaultRpcError extends Error {
  override readonly name = 'VaultRpcError';
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

// ---------- 通知类型 ----------
export const VAULT_NOTIFICATIONS = {
  CONNECTION_FAILED: 'connection.failed',
  CONNECTION_IDLE_TIMEOUT: 'connection.idle.timeout',
  AUTH_FAILED: 'auth.failed',
  HOST_KEY_CHANGED: 'host.key.changed',
} as const;

export type VaultNotification =
  | {
      method: typeof VAULT_NOTIFICATIONS.CONNECTION_FAILED;
      params: { connectionId: string; error: string };
    }
  | {
      method: typeof VAULT_NOTIFICATIONS.CONNECTION_IDLE_TIMEOUT;
      params: { connectionId: string };
    }
  | {
      method: typeof VAULT_NOTIFICATIONS.AUTH_FAILED;
      params: { alias: string; reason: string };
    }
  | {
      method: typeof VAULT_NOTIFICATIONS.HOST_KEY_CHANGED;
      params: { alias: string; oldFingerprint: string; newFingerprint: string };
    };
