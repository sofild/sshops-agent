/**
 * 四级上下文压缩
 *
 * - L1 Snip: tool_result 超过 snipMaxBytes 截断尾部
 * - L2 Microcompact: 合并连续同类型 tool_result
 * - L3 Context-Collapse: 累计 tool call 超过阈值，触发 LLM 摘要折叠
 * - L4 Autocompact: 上下文使用率 > autocompactRatio 触发完整重写
 */
import type { Message, ContentBlock } from '../llm/types.js';
import { getConfig } from '../config/loader.js';
import { getLLMClient } from '../llm/factory.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'compressor' });

/** L1：截断过大的 tool_result */
export function snipL1(messages: Message[]): { messages: Message[]; changed: boolean } {
  const cfg = getConfig().agent.compression;
  let changed = false;
  const out: Message[] = messages.map((m) => {
    if (m.role !== 'user' || typeof m.content === 'string') return m;
    const blocks: ContentBlock[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.content.length > cfg.snipMaxBytes) {
        const truncated = b.content.slice(0, cfg.snipMaxBytes) + `\n...[truncated ${b.content.length - cfg.snipMaxBytes} bytes]`;
        blocks.push({ ...b, content: truncated });
        changed = true;
      } else {
        blocks.push(b);
      }
    }
    return { ...m, content: blocks };
  });
  return { messages: out, changed };
}

/** L2：合并连续同类型 tool_result（仅当 type 完全一致且 content 较短时） */
export function microcompactL2(messages: Message[]): { messages: Message[]; changed: boolean } {
  const cfg = getConfig().agent.compression;
  let changed = false;
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') {
      out.push(m);
      continue;
    }
    const blocks = [...m.content];
    const merged: ContentBlock[] = [];
    let i = 0;
    while (i < blocks.length) {
      const cur = blocks[i];
      if (cur.type !== 'tool_result') {
        merged.push(cur);
        i++;
        continue;
      }
      // 收集连续的同 toolUseId 的 result（按 toolUseId 聚合，不跨 message）
      const group: typeof blocks = [cur];
      let j = i + 1;
      while (
        j < blocks.length &&
        blocks[j].type === 'tool_result' &&
        (blocks[j] as Extract<ContentBlock, { type: 'tool_result' }>).toolUseId ===
          (cur as Extract<ContentBlock, { type: 'tool_result' }>).toolUseId
      ) {
        group.push(blocks[j]);
        j++;
      }
      if (group.length >= cfg.microcompactMinRun) {
        const combined = group
          .map((g) => (g as Extract<ContentBlock, { type: 'tool_result' }>).content)
          .join('\n---\n');
        merged.push({ ...cur, content: combined });
        changed = true;
      } else {
        merged.push(...group);
      }
      i = j;
    }
    out.push({ ...m, content: merged });
  }
  return { messages: out, changed };
}

/** 统计当前 tool_call 数量 */
export function countToolCalls(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') n++;
      }
    }
  }
  return n;
}

/** L3：把早期 N 个 tool_call/result 折叠为 LLM 摘要 */
export async function contextCollapseL3(
  messages: Message[],
  foldCount: number
): Promise<{ messages: Message[]; summary: string }> {
  if (foldCount <= 0) return { messages, summary: '' };
  // 找到前 foldCount 个 tool_use 和它们的 tool_result
  const foldIdx: number[] = [];
  let seen = 0;
  for (let i = 0; i < messages.length && seen < foldCount; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use' && seen < foldCount) {
          foldIdx.push(i);
          seen++;
        }
      }
    }
  }
  if (seen === 0) return { messages, summary: '' };

  const toSummarize = messages.slice(0, Math.max(...foldIdx) + 2);
  const kept = messages.slice(Math.max(...foldIdx) + 2);

  const summary = await summarize(toSummarize, 'L3 折叠：' + toSummarize.length + ' 条历史消息');
  const summaryMsg: Message = {
    role: 'user',
    content: `[Earlier context collapsed]\n${summary}\n[End of earlier context]`,
    cacheControl: { type: 'ephemeral' },
  };
  return { messages: [summaryMsg, ...kept], summary };
}

/** L4：完整重写（保留 system + 最后 K 条） */
export async function autocompactL4(
  messages: Message[],
  keepLast = 4
): Promise<{ messages: Message[]; summary: string }> {
  if (messages.length <= keepLast + 1) return { messages, summary: '' };
  const head = messages.slice(0, messages.length - keepLast);
  const tail = messages.slice(messages.length - keepLast);
  const summary = await summarize(head, 'L4 Autocompact');
  const finalSummary =
    summary && summary !== '(empty summary)'
      ? summary
      : `[L4 折叠失败：原始 ${head.length} 条消息保留但不可信。请基于后续 ${tail.length} 条消息谨慎推断。]`;
  const summaryMsg: Message = {
    role: 'user',
    content: `[Full context compacted]\n${finalSummary}\n[End of compacted context]`,
    cacheControl: { type: 'ephemeral' },
  };
  return { messages: [summaryMsg, ...tail], summary: finalSummary };
}

/** 判断是否需要触发 L4 */
export function shouldAutocompact(messages: Message[]): boolean {
  const cfg = getConfig().agent.compression;
  const llm = getLLMClient();
  const tokens = llm.countTokens(messages);
  // 从 active provider 的 maxTokens 动态读取，不再硬编码 8192
  const active = getConfig().providers.active;
  const max = cfg.summarizerModel ? 8192 : (getConfig().providers.providers[active]?.maxTokens ?? 8192);
  return tokens / max > cfg.autocompactRatio;
}

async function summarize(messages: Message[], label: string): Promise<string> {
  const llm = getLLMClient();
  const sysMsg: Message = {
    role: 'system',
    content: `你是一个上下文压缩助手。请把以下历史消息压缩为不超过 800 字的中文摘要，保留所有可执行的关键事实（命令、输出码、错误信息、配置值），省略通用寒暄与重复信息。不要捏造任何事实。`,
  };
  const userMsg: Message = {
    role: 'user',
    content: messages
      .map((m) => {
        const role = m.role;
        let body: string;
        if (typeof m.content === 'string') body = m.content;
        else
          body = m.content
            .map((b) => {
              if (b.type === 'text') return b.text;
              if (b.type === 'tool_use') return `[tool_use ${b.name} ${JSON.stringify(b.input)}]`;
              if (b.type === 'tool_result') return `[tool_result ${b.isError ? 'ERR' : 'OK'} ${b.content.slice(0, 400)}]`;
              return '';
            })
            .join('\n');
        return `## ${role}\n${body}`;
      })
      .join('\n\n'),
  };
  let text = '';
  try {
    for await (const ev of llm.chat([sysMsg, userMsg], { maxTokens: 2000, temperature: 0 })) {
      if (ev.type === 'text_delta') text += ev.text;
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'summarize failed, fallback to truncation');
    text = `(${label})\n` +
      messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 200)))
        .join('\n')
        .slice(0, 2000);
  }
  return text || '(empty summary)';
}

export interface CompressResult {
  messages: Message[];
  /** 触发的级别：'L1'|'L2'|'L3'|'L4'|null */
  level: 'L1' | 'L2' | 'L3' | 'L4' | null;
  summary?: string;
}

/** 入口：按顺序尝试 L1→L2→L3→L4 */
export async function compress(messages: Message[]): Promise<CompressResult> {
  const cfg = getConfig().agent.compression;
  // L1
  let r = snipL1(messages);
  if (r.changed) return { messages: r.messages, level: 'L1' };
  // L2
  r = microcompactL2(messages);
  if (r.changed) return { messages: r.messages, level: 'L2' };
  // L3：达到折叠阈值
  const toolCount = countToolCalls(messages);
  if (toolCount >= cfg.contextCollapseThreshold) {
    const r3 = await contextCollapseL3(messages, Math.max(1, Math.floor(toolCount / 2)));
    return { messages: r3.messages, level: 'L3', summary: r3.summary };
  }
  // L4
  if (shouldAutocompact(messages)) {
    const r4 = await autocompactL4(messages);
    return { messages: r4.messages, level: 'L4', summary: r4.summary };
  }
  return { messages, level: null };
}
