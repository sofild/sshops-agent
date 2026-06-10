/**
 * Agent 内部共享类型
 *
 * - 状态机：五状态（idle | running | paused | expired | error）
 * - 反幻觉/可选项菜单的输入输出结构
 * - AgentRunState 是单次 run() 的可变状态容器
 */
import type { Message, ContentBlock } from '../llm/types.js';

export type AgentState = 'idle' | 'running' | 'paused' | 'expired' | 'error';

export interface AgentRunState {
  status: AgentState;
  /** 完整消息历史（伪不可变：每个 continue 站点整体替换） */
  messages: Message[];
  /** 当前轮次计数 */
  turnNumber: number;
  /** 最大轮次（防止 LLM 死循环） */
  maxTurns: number;
  /** 会话开始时间（monotonic，毫秒） */
  sessionStartedAt: number;
  /** 会话级超时（秒） */
  sessionTimeoutSeconds: number;
  /** 单轮超时（秒） */
  turnTimeoutSeconds: number;
  /** 是否已尝试过 reactive compact（防止 dead loop） */
  hasAttemptedReactiveCompact: boolean;
  /** 外部请求暂停（如 SIGUSR1） */
  pauseRequested: boolean;
  /** 连续错误计数（用于熔断） */
  consecutiveErrors: number;
  /** 熔断阈值 */
  maxConsecutiveErrors: number;
  /** 已执行的 tool_use_id（消息去重） */
  seenToolUseIds: Set<string>;
  /** 模型降级链当前索引 */
  fallbackIndex: number;
  /**
   * v1 auto-connect 缓存：alias / host:port / "alias:port" → mcp-server-ssh 的真实 connectionId。
   * 由 resolveConnectionId() 自动维护，跨多轮会话复用。
   * - key: 原始字符串（用户输入或 vault alias）
   * - value: mcp-server-ssh 返回的真实 id（UUID 形式）
   */
  connectionIdCache: Map<string, string>;
}

export interface Question {
  field: string;
  prompt: string;
  sensitive?: boolean;
}

export interface MenuOption {
  label: string;
  value: string;
  description?: string;
}

export interface AgentEventTypeMap {
  need_input: { toolUseId: string; questions: Question[] };
  options_menu: { toolUseId: string; prompt: string; options: MenuOption[] };
  state_change: { from: AgentState; to: AgentState; reason?: string };
  fallback: { fromModel: string; toModel: string; reason: string };
  final_history: { messages: Message[] };
}

export interface ToolFailureSignal {
  isError: boolean;
  matchedKeyword?: string;
  toolName: string;
  toolUseId: string;
}

export function isFailureSignal(
  toolName: string,
  toolUseId: string,
  isError: boolean,
  content: string,
  failureKeywords: string[]
): ToolFailureSignal {
  if (isError) return { isError: true, toolName, toolUseId };
  const lower = content.toLowerCase();
  for (const kw of failureKeywords) {
    if (lower.includes(kw.toLowerCase())) {
      return { isError: true, matchedKeyword: kw, toolName, toolUseId };
    }
  }
  return { isError: false, toolName, toolUseId };
}

/** 解析 LLM 文本中的结构化追问标记 */
export function parseNeedInputMarker(text: string): Question[] | null {
  // 格式：[NEED_INPUT:field1|field2|field3]
  const m = /\[NEED_INPUT:([^\]]+)\]/.exec(text);
  if (!m) return null;
  return m[1].split('|').map((field) => ({
    field: field.trim(),
    prompt: `请提供 ${field.trim()}`,
    sensitive: /password|key|token|secret/i.test(field),
  }));
}

/** 解析 LLM 文本中的结构化选项菜单标记 */
export function parseOptionsMenuMarker(
  text: string
): { field: string; prompt: string; options: MenuOption[] } | null {
  // 格式：[OPTIONS:field|opt1=label1, opt2=label2, ...]
  const m = /\[OPTIONS:([^\]]+)\]/.exec(text);
  if (!m) return null;
  const parts = m[1].split('|');
  if (parts.length < 2) return null;
  const field = parts[0].trim();
  const prompt = `请选择 ${field}`;
  const options: MenuOption[] = parts[1].split(',').map((entry) => {
    const [value, ...labelParts] = entry.split('=');
    const valueStr = (value ?? '').trim();
    const label = (labelParts.join('=') || valueStr).trim();
    return { value: valueStr, label };
  });
  return { field, prompt, options };
}

/** 去掉结构化标记后的 LLM 文本（供用户阅读） */
export function stripStructuredMarkers(text: string): string {
  return text
    .replace(/\[NEED_INPUT:[^\]]+\]/g, '')
    .replace(/\[OPTIONS:[^\]]+\]/g, '')
    .trim();
}

/** 用于在 [tool_result] 中注入反幻觉提示 */
export const HALLUCINATION_GUARD_HINT =
  '[Previous tool call failed. Do NOT proceed with downstream tools until the user provides the missing information. If you need user input, append `[NEED_INPUT:field1|field2]` to your response. If you need the user to choose from known options, append `[OPTIONS:field|val1=label1,val2=label2]`. DO NOT fabricate tool outputs.]\n' +
  '[Hallucination rules:]\n' +
  '- If a tool_result isError=true, you MUST quote the verbatim error message (or key parts of it) and append [NEED_INPUT:...]. Do not paraphrase.\n' +
  '- If a tool_result isError=false, you MUST quote the relevant lines from content (not paraphrase). Do not add files, dates, or numbers not present in tool_result.\n' +
  '- If a tool_result is truncated (shows `...[truncated N bytes]`), say so explicitly and ask the user to narrow the query instead of inventing content.\n' +
  '- When listing files / processes / services, the list MUST come from tool_result verbatim. If you have general knowledge of what "should" be there, do NOT add to the list.';

/** 用于压缩后的反幻觉提示 */
export const POST_COMPACTION_HINT =
  '[Context has been compacted. The following tool_result lines are facts retrieved from the prior WAL, NOT regenerated by you. Do not use general knowledge to fill in details that were not provided.]';

export type { ContentBlock, Message };
