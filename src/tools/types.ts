/**
 * 工具抽象
 *
 * - Tool 接口
 * - ToolContext：传给 execute 的上下文
 * - inputSchema: JSON Schema（与 LLM 工具调用协议对齐）
 */
import type { z } from 'zod';

export type ToolDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'confirm'; reason: string; requiresUserConfirm: boolean };

export interface ToolContext {
  sessionId: string;
  traceId: string;
  /** 信号：外部取消 */
  signal: AbortSignal;
  /** 经过权限评估后的最终决策 */
  decision?: ToolDecision;
}

export interface Tool {
  /** 唯一名称（建议带命名空间，如 ssh_ssh_execute） */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  /**
   * 可选的 zod schema（用于在 execute 前强校验）
   * execute 内部应再做一次校验防御
   */
  readonly zodSchema?: z.ZodTypeAny;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  /** 文本结果 */
  content: string;
  /** 结构化结果（可选） */
  data?: unknown;
  /** 是否错误 */
  isError?: boolean;
}
