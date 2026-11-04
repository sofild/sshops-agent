/**
 * OpenAI Chat Completions 消息协议转换
 *
 * 这是协议适配层，独立于 HTTP/流式实现，便于单测与复用。
 *
 * 关键点（旧实现缺失）：
 *  - 旧的 convertMessage() 对 role=user 只保留 text block，把 tool_result
 *    整块丢掉。OpenAI/DeepSeek/Ollama 因此永远看不到工具观测结果，
 *    多步工具循环实际不可用。
 *  - OpenAI 要求 tool_result 编码为 `role: "tool"` + `tool_call_id`，
 *    并且必须紧跟在带 tool_calls 的 assistant 消息之后。
 *  - 历史恢复/压缩可能留下没有对应 tool_call 的孤立 tool_result；
 *    这类块降级为普通 user 文本，避免整轮请求 400。
 */
import type OpenAI from 'openai';
import type { Message, ContentBlock } from '../types.js';

export type OpenAIMessage = OpenAI.Chat.ChatCompletionMessageParam;

/** 中断/崩溃的 run 可能只留下部分 tool_result；补齐后才能构造合法请求。 */
const MISSING_TOOL_RESULT =
  '[no tool result recorded; the run was interrupted or the result was lost]';

function asBlocks(content: ContentBlock[] | string): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

function blocksToText(content: ContentBlock[] | string): string {
  return asBlocks(content)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function assistantToolCalls(blocks: ContentBlock[]): OpenAI.Chat.ChatCompletionMessageToolCall[] {
  const calls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      calls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      });
    }
  }
  return calls;
}

function flushPendingToolResults(out: OpenAIMessage[], pending: Set<string>): void {
  for (const id of pending) {
    out.push({ role: 'tool', tool_call_id: id, content: MISSING_TOOL_RESULT });
  }
  pending.clear();
}

/**
 * 把内部 provider-neutral 消息转换为 OpenAI Chat Completions 消息。
 *
 * 输出顺序严格为：assistant(tool_calls) → tool × N → 后续 user 文本。
 * 未匹配到 tool_call 的 tool_result 会转成 user 文本，而不是被丢弃。
 * 有 tool_call 但没有结果的（中断/崩溃恢复）会补一条 synthetic tool 消息。
 */
export function convertMessages(messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  /** 当前 assistant 消息中尚未收到结果的 tool_call id */
  let pendingToolCalls = new Set<string>();

  for (const m of messages) {
    if (m.role === 'system') {
      flushPendingToolResults(out, pendingToolCalls);
      out.push({ role: 'system', content: blocksToText(m.content) });
      continue;
    }

    if (m.role === 'assistant') {
      flushPendingToolResults(out, pendingToolCalls);
      const blocks = asBlocks(m.content);
      const text = blocksToText(m.content);
      const toolCalls = assistantToolCalls(blocks);
      // 既没有文本也没有工具调用的空 assistant 消息对 OpenAI 非法，直接跳过。
      if (!text && toolCalls.length === 0) continue;
      for (const call of toolCalls) pendingToolCalls.add(call.id);
      out.push({
        role: 'assistant',
        content: text || (toolCalls.length > 0 ? null : ''),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      continue;
    }

    // role === 'tool'：只有字符串或 tool_result 块。没有 tool_call_id 时
    // 无法构造合法的 tool 消息，降级为 user 文本。
    if (m.role === 'tool') {
      const blocks = asBlocks(m.content);
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          if (pendingToolCalls.has(b.toolUseId)) {
            out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
            pendingToolCalls.delete(b.toolUseId);
          } else {
            texts.push(
              `[tool_result ${b.toolUseId}${b.isError ? ' (error)' : ''}] ${b.content}`
            );
          }
        } else if (b.type === 'text') {
          texts.push(b.text);
        }
      }
      flushPendingToolResults(out, pendingToolCalls);
      if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n') });
      continue;
    }

    // role === 'user'：可能同时包含 tool_result 与普通文本（如反幻觉提示）。
    // 必须先发 tool 消息，再发 user 文本，否则 OpenAI 会拒绝该请求。
    const texts: string[] = [];
    for (const b of asBlocks(m.content)) {
      if (b.type === 'text') {
        texts.push(b.text);
      } else if (b.type === 'tool_result') {
        if (pendingToolCalls.has(b.toolUseId)) {
          out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
          pendingToolCalls.delete(b.toolUseId);
        } else {
          texts.push(
            `[tool_result ${b.toolUseId}${b.isError ? ' (error)' : ''}] ${b.content}`
          );
        }
      }
    }
    // 先把未匹配的 tool_call 补成 tool 消息，再输出 user 文本；
    // role=tool 必须紧跟在 assistant.tool_calls 之后。
    flushPendingToolResults(out, pendingToolCalls);
    if (texts.length > 0) {
      out.push({ role: 'user', content: texts.join('\n') });
    }
  }

  flushPendingToolResults(out, pendingToolCalls);
  return out;
}
