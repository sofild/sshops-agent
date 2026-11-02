/**
 * LLM 抽象层类型定义
 *
 * - 不依赖任何具体 Provider
 * - 通过 AsyncIterable 流式输出事件
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

export interface Message {
  role: Role;
  /** 多模态内容块列表；纯文本时也可传字符串 */
  content: ContentBlock[] | string;
  /** Anthropic prompt cache 控制点（仅 anthropic provider 使用） */
  cacheControl?: { type: 'ephemeral' } | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/**
 * 工具选择策略：
 * - auto：模型自行决定是否调用工具
 * - none：本轮禁止调用工具（只允许文本回答）
 * - required：本轮必须调用至少一个工具
 *
 * 这是 provider 原生能力，不再依赖 prompt 中的文字约定。
 */
export type ToolChoice = 'auto' | 'none' | 'required';

export interface ChatOptions {
  /** 模型覆盖 */
  model?: string;
  /** 工具定义 */
  tools?: ToolDefinition[];
  /** 工具选择策略（默认 auto） */
  toolChoice?: ToolChoice;
  /** 最大 token */
  maxTokens?: number;
  /** 温度 */
  temperature?: number;
  /** 系统提示 */
  system?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 停止序列 */
  stopSequences?: string[];
  /** 元数据：trace_id 等 */
  metadata?: Record<string, string>;
}

export type StreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; inputDelta: string }
  | { type: 'tool_use_end'; id: string; name?: string; input: Record<string, unknown> }
  | { type: 'message_end'; stopReason: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: 'error'; error: Error };

export interface LLMClient {
  /** 供应商标识 */
  readonly providerName: string;
  /** 默认模型 */
  readonly defaultModel: string;
  /**
   * 模型上下文窗口（输入 + 输出）。压缩策略必须以此为准；
   * 不能用 maxTokens（输出上限）冒充。
   */
  readonly contextWindow: number;
  /** 流式 chat */
  chat(messages: Message[], options?: ChatOptions): AsyncIterable<StreamEvent>;
  /** 估算 token 数（粗略字符/4 估算，避免依赖具体分词器） */
  countTokens(messages: Message[]): number;
}
