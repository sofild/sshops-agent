/**
 * 上下文预算（Context Budget）
 *
 * Agent 的上下文是有限资源，压缩决策必须以 **上下文窗口** 为准，
 * 而不是以 provider 的 `maxTokens`（单次输出上限）为准。
 *
 * 旧实现把 `maxTokens` 当上下文窗口使用（默认 8192），导致：
 *  - 200k 窗口的模型在 ~7k token 时就被过度压缩；
 *  - 压缩判断完全忽略 system prompt 与工具 schema；
 *  - 无法解释“为什么明明还有空间却丢了历史”。
 *
 * 该模块只做纯计算，便于单测和复用。
 */
import type { LLMClient, Message, ToolDefinition } from '../llm/types.js';

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 没有真实 tokenizer 时的保守估算：约 4 字符 / token */
export function estimateCharsToTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** 工具 schema 也会占用输入 token；不能只数 messages */
export function estimateToolsTokens(tools?: ToolDefinition[]): number {
  if (!tools || tools.length === 0) return 0;
  return estimateCharsToTokens(JSON.stringify(tools).length);
}

export function estimateSystemTokens(system?: string): number {
  return estimateCharsToTokens(system?.length ?? 0);
}

/**
 * 估算一次 LLM 请求的输入 token 数（messages + system + tools）。
 * `llm.countTokens` 目前是字符/4 的近似实现，这里保持一致。
 */
export function estimateRequestTokens(
  llm: Pick<LLMClient, 'countTokens'>,
  messages: Message[],
  system?: string,
  tools?: ToolDefinition[]
): number {
  return (
    llm.countTokens(messages) +
    estimateSystemTokens(system) +
    estimateToolsTokens(tools)
  );
}

export interface ContextBudgetOptions {
  /** 模型上下文窗口（输入 + 输出） */
  contextWindow: number;
  /** 单次响应预留的输出 token */
  maxOutputTokens: number;
  /** 触发压缩的窗口使用率（0~1），默认取 config.compression.autocompactRatio */
  compactionRatio?: number;
}

/**
 * 一次 run 的上下文预算。
 *
 * 可用输入预算 = floor(contextWindow * ratio) - maxOutputTokens。
 * 为输出预留空间，避免“刚好塞满输入，结果没有空间生成回答/工具调用”。
 */
export class ContextBudget {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly compactionRatio: number;

  constructor(opts: ContextBudgetOptions) {
    this.contextWindow = normalizeWindow(opts.contextWindow);
    // 输出预留最多占窗口一半：否则窗口很小时 prompt 预算会被压到 1，
    // 每一步都触发 L4 摘要，既慢又可能丢事实。
    this.maxOutputTokens = Math.min(
      Math.max(0, opts.maxOutputTokens || 0),
      Math.floor(this.contextWindow / 2)
    );
    this.compactionRatio = normalizeRatio(opts.compactionRatio ?? 0.85);
  }

  /** 允许用于输入的 token 上限 */
  get promptBudgetTokens(): number {
    return Math.max(
      1,
      Math.floor(this.contextWindow * this.compactionRatio) - this.maxOutputTokens
    );
  }

  /** 估算输入是否已超过压缩阈值 */
  shouldCompact(estimatedInputTokens: number): boolean {
    return estimatedInputTokens >= this.promptBudgetTokens;
  }

  /** 当前估算占整个上下文窗口的比例（仅用于指标/日志） */
  usageRatio(estimatedInputTokens: number): number {
    return estimatedInputTokens / this.contextWindow;
  }
}

export function normalizeWindow(value: number | undefined | null): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

function normalizeRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) return 0.85;
  return value;
}
