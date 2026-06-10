/**
 * 通用错误类型
 */

export class SshopsError extends Error {
  override readonly name: string = 'SshopsError';
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
  }
}

export class PermissionDeniedError extends SshopsError {
  override readonly name: string = 'PermissionDeniedError';
  constructor(message: string, public readonly policy: string) {
    super(message, 'PERMISSION_DENIED');
  }
}

export class ConfigError extends SshopsError {
  override readonly name: string = 'ConfigError';
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

export class ToolNotFoundError extends SshopsError {
  override readonly name: string = 'ToolNotFoundError';
  constructor(tool: string) {
    super(`tool not found: ${tool}`, 'TOOL_NOT_FOUND');
  }
}

export class ToolTimeoutError extends SshopsError {
  override readonly name: string = 'ToolTimeoutError';
  constructor(tool: string, public readonly timeoutMs: number) {
    super(`tool ${tool} timed out after ${timeoutMs}ms`, 'TOOL_TIMEOUT');
  }
}

export class ToolExecutionError extends SshopsError {
  override readonly name: string = 'ToolExecutionError';
  constructor(tool: string, cause: unknown) {
    super(`tool ${tool} execution failed: ${String(cause)}`, 'TOOL_EXECUTION', cause);
  }
}

export class RetryExhaustedError extends SshopsError {
  override readonly name: string = 'RetryExhaustedError';
  constructor(message: string, public readonly attempts: number) {
    super(message, 'RETRY_EXHAUSTED');
  }
}

export class LLMError extends SshopsError {
  override readonly name: string = 'LLMError';
  constructor(message: string, public readonly provider: string) {
    super(message, 'LLM_ERROR');
  }
}

export class MCPServerError extends SshopsError {
  override readonly name = 'MCPServerError';
  constructor(message: string, public readonly serverName: string) {
    super(message, 'MCP_SERVER_ERROR');
  }
}

export class MissingInfoError extends SshopsError {
  override readonly name = 'MissingInfoError';
  constructor(
    message: string,
    public readonly fields: string[]
  ) {
    super(message, 'MISSING_INFO');
  }
}

export class HallucinationGuardError extends SshopsError {
  override readonly name = 'HallucinationGuardError';
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly matchedKeyword?: string
  ) {
    super(message, 'HALLUCINATION_GUARD');
  }
}

export class SessionMigrationError extends SshopsError {
  override readonly name = 'SessionMigrationError';
  constructor(message: string) {
    super(message, 'SESSION_MIGRATION');
  }
}

export class CircuitOpenError extends SshopsError {
  override readonly name = 'CircuitOpenError';
  constructor(
    message: string,
    public readonly consecutiveErrors: number
  ) {
    super(message, 'CIRCUIT_OPEN');
  }
}

export class InvalidOptionError extends SshopsError {
  override readonly name = 'InvalidOptionError';
  constructor(message: string, public readonly input: string) {
    super(message, 'INVALID_OPTION');
  }
}

export class TurnTimeoutError extends SshopsError {
  override readonly name = 'TurnTimeoutError';
  constructor(message: string, public readonly turn: number) {
    super(message, 'TURN_TIMEOUT');
  }
}
