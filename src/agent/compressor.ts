/**
 * 四级上下文压缩
 *
 * - L1 Snip: tool_result 超过 snipMaxBytes 截断尾部
 * - L2 Microcompact: 合并连续同类型 tool_result
 * - L3 Context-Collapse: 累计 tool call 超过阈值，触发 LLM 摘要折叠
 * - L4 Autocompact: 上下文使用率 > autocompactRatio 触发完整重写
 *
 * 预算口径：上下文窗口（provider.contextWindow），而不是输出上限
 * maxTokens。折叠只会发生在消息边界上，避免把 assistant.tool_use 与
 * 对应的 user.tool_result 拆散（Anthropic 会直接拒绝这种历史）。
 */
import type { Message, ContentBlock, ToolDefinition } from '../llm/types.js';
import { getConfig } from '../config/loader.js';
import { getLLMClient } from '../llm/factory.js';
import { getLogger } from '../observability/logging.js';
import { ContextBudget, estimateRequestTokens, normalizeWindow } from './context-budget.js';

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

/**
 * 判断一条消息能否作为“保留历史”的起点。
 *
 * tool_result 必须紧跟在 assistant.tool_use 之后；如果压缩后的 tail 从
 * 一条 tool_result 开始，就会产生没有对应 tool_use 的孤立结果。
 */
export function isSafeConversationStart(m: Message): boolean {
  if (typeof m.content === 'string') {
    return m.role === 'user' || m.role === 'assistant';
  }
  if (m.role === 'assistant') return true;
  if (m.role !== 'user') return false;
  return !m.content.some((b) => b.type === 'tool_result');
}

/**
 * 从 desiredStart 开始寻找一个安全的折叠边界。
 * 优先向后找（多折叠一点），找不到再向前找（少折叠一点）。
 */
export function findSafeCut(messages: Message[], desiredStart: number): number {
  const n = messages.length;
  if (n <= 1) return 0;
  const desired = Math.min(Math.max(desiredStart, 1), n - 1);
  for (let i = desired; i < n; i++) {
    if (isSafeConversationStart(messages[i])) return i;
  }
  for (let i = desired - 1; i >= 1; i--) {
    if (isSafeConversationStart(messages[i])) return i;
  }
  // 没有安全边界：调用方应保持原历史，而不是强行从 tool_result 开始
  return 0;
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

  // 不能简单取 max(foldIdx)+2：多工具调用的结果可能位于同一 user 消息，
  // 或 fold 边界落在 tool_result 上。向前/向后找安全边界。
  const cut = findSafeCut(messages, Math.max(...foldIdx) + 2);
  if (cut <= 0 || cut >= messages.length) return { messages, summary: '' };
  const toSummarize = messages.slice(0, cut);
  const kept = messages.slice(cut);

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
  const cut = findSafeCut(messages, messages.length - keepLast);
  if (cut <= 0 || cut >= messages.length) return { messages, summary: '' };
  const head = messages.slice(0, cut);
  const tail = messages.slice(cut);
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

export interface CompressOptions {
  /** system prompt 也占输入 token，必须纳入预算 */
  system?: string;
  /** 工具 schema 也占输入 token，必须纳入预算 */
  tools?: ToolDefinition[];
  /** 覆盖上下文窗口（默认取当前 LLM client） */
  contextWindow?: number;
  /** 为输出预留的 token（默认取 active provider.maxTokens） */
  maxOutputTokens?: number;
  /** 覆盖压缩阈值比例 */
  compactionRatio?: number;
}

function defaultMaxOutputTokens(): number {
  const cfg = getConfig();
  const active = cfg.providers.active;
  return cfg.providers.providers[active]?.maxTokens ?? 0;
}

/**
 * 判断是否触发完整重写（L4）。
 *
 * 口径：
 *   input(messages + system + tools) >= floor(contextWindow * ratio) - outputReserve
 * 而不是旧实现的 tokens / maxTokens（把输出上限当上下文窗口）。
 */
export function shouldAutocompact(
  messages: Message[],
  opts: CompressOptions = {}
): boolean {
  const cfg = getConfig().agent.compression;
  const llm = getLLMClient();
  const budget = new ContextBudget({
    contextWindow: normalizeWindow(opts.contextWindow ?? llm.contextWindow),
    maxOutputTokens: opts.maxOutputTokens ?? defaultMaxOutputTokens(),
    compactionRatio: opts.compactionRatio ?? cfg.autocompactRatio,
  });
  return budget.shouldCompact(
    estimateRequestTokens(llm, messages, opts.system, opts.tools)
  );
}

async function summarize(messages: Message[], label: string): Promise<string> {
  const llm = getLLMClient();
  // 必须通过 ChatOptions.system 传递：Anthropic provider 会过滤 role=system
  // 的消息（system 走独立参数），旧实现把压缩指令当普通消息，在 Anthropic 上
  // 会被静默丢弃，摘要质量无法保证。
  const system = `你是一个上下文压缩助手。请把以下历史消息压缩为不超过 800 字的中文摘要，保留所有可执行的关键事实（命令、输出码、错误信息、配置值），省略通用寒暄与重复信息。不要捏造任何事实。`;
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
    for await (const ev of llm.chat([userMsg], {
      system,
      maxTokens: 2000,
      temperature: 0,
    })) {
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
export async function compress(
  messages: Message[],
  opts: CompressOptions = {}
): Promise<CompressResult> {
  const cfg = getConfig().agent.compression;
  let current = messages;
  let level: CompressResult['level'] = null;
  let summary: string | undefined;

  // L1
  const l1 = snipL1(current);
  if (l1.changed) {
    current = l1.messages;
    level = 'L1';
  }

  // L2（保持协议安全：只在同 toolUseId 的重复块上合并）
  const l2 = microcompactL2(current);
  if (l2.changed) {
    current = l2.messages;
    level = 'L2';
  }

  const over = () => shouldAutocompact(current, opts);

  // L3：累计工具调用达到阈值，或上下文已超预算
  const toolCount = countToolCalls(current);
  if (over() || toolCount >= cfg.contextCollapseThreshold) {
    const r3 = await contextCollapseL3(
      current,
      Math.max(1, Math.floor(toolCount / 2))
    );
    if (r3.summary) {
      current = r3.messages;
      level = 'L3';
      summary = r3.summary;
    }
  }

  // L4：L3 之后仍超预算，做完整重写
  if (over()) {
    const r4 = await autocompactL4(current);
    if (r4.summary) {
      current = r4.messages;
      level = 'L4';
      summary = r4.summary;
    }
  }

  return { messages: current, level, summary };
}
