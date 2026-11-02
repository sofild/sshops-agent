/**
 * Anthropic Provider 实现
 *
 * - 基于 @anthropic-ai/sdk
 * - 支持 streaming、tool_use、prompt cache
 * - 指数退避重试
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMClient,
  Message,
  ChatOptions,
  StreamEvent,
} from '../types.js';
import { LLMError, RetryExhaustedError } from '../../utils/errors.js';
import { getLogger } from '../../observability/logging.js';

const log = getLogger().child({ component: 'llm.anthropic' });

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  baseURL?: string | null;
  promptCache: boolean;
  maxRetries: number;
}

export class AnthropicProvider implements LLMClient {
  readonly providerName = 'anthropic';
  readonly defaultModel: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  private client: Anthropic;
  private opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    this.opts = opts;
    this.defaultModel = opts.model;
    this.contextWindow = opts.contextWindow;
    this.maxOutputTokens = opts.maxTokens;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL ?? undefined,
      maxRetries: 0, // 我们自己控制重试
    });
  }

  countTokens(messages: Message[]): number {
    let chars = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') chars += m.content.length;
      else for (const b of m.content) chars += JSON.stringify(b).length;
    }
    return Math.ceil(chars / 4);
  }

  async *chat(messages: Message[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    const maxRetries = this.opts.maxRetries;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        yield* this.doChat(messages, options);
        return;
      } catch (err) {
        lastErr = err;
        if (options.signal?.aborted) {
          throw new LLMError('aborted', this.providerName);
        }
        if (!isRetryable(err) || attempt === maxRetries) {
          if (attempt === maxRetries) {
            throw new RetryExhaustedError(
              `anthropic chat failed after ${attempt + 1} attempts: ${String(err)}`,
              attempt + 1
            );
          }
          throw new LLMError(
            err instanceof Error ? err.message : String(err),
            this.providerName
          );
        }
        const delay = backoffMs(attempt);
        log.warn({ attempt, delay, err: String(err) }, 'anthropic retry');
        await sleep(delay);
      }
    }
    throw lastErr instanceof Error ? lastErr : new LLMError('unknown', this.providerName);
  }

  private async *doChat(
    messages: Message[],
    options: ChatOptions
  ): AsyncIterable<StreamEvent> {
    const systemPrompt = options.system ?? '';

    // 转换消息格式
    const converted: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => convertMessage(m, this.opts.promptCache));

    // 工具定义：把 cache_control 放在最末尾的 tool 上以最大化 prompt cache 命中。
    // toolChoice=none 时不发送 tools，避免模型仍然产出 tool_use。
    const exposeTools = options.toolChoice !== 'none';
    const toolDefs: Anthropic.Tool[] | undefined = exposeTools
      ? options.tools?.map((t, idx, arr) => {
          const isLast = idx === arr.length - 1;
          return {
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            ...(isLast && this.opts.promptCache
              ? { cache_control: { type: 'ephemeral' as const } }
              : {}),
          };
        })
      : undefined;

    const toolChoice: Anthropic.Messages.ToolChoice | undefined =
      exposeTools && options.toolChoice
        ? options.toolChoice === 'auto'
          ? { type: 'auto' }
          : { type: 'any' }
        : undefined;

    // system prompt 末尾加 cache_control 标记（确保 Anthropic 视为稳定前缀）
    // 旧版 SDK 的 TextBlockParam 类型不一定有 cache_control 字段，断言为 any 解决。
    const systemBlocks: Anthropic.TextBlockParam[] | string = this.opts.promptCache
      ? ([
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ] as unknown as Anthropic.TextBlockParam[])
      : systemPrompt;

    const stream = this.client.messages.stream({
      model: options.model ?? this.opts.model,
      max_tokens: options.maxTokens ?? this.opts.maxTokens,
      temperature: options.temperature ?? this.opts.temperature,
      system: systemBlocks,
      messages: converted,
      tools: toolDefs,
      tool_choice: toolChoice,
      stop_sequences: options.stopSequences,
    });

    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    const messageId = `msg-${Date.now()}`;

    yield { type: 'message_start', messageId };

    for await (const event of stream) {
      if (options.signal?.aborted) {
        stream.controller.abort();
        throw new LLMError('aborted', this.providerName);
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolId = block.id;
          currentToolName = block.name;
          currentToolInput = '';
          yield {
            type: 'tool_use_start',
            id: block.id,
            name: block.name,
          };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { type: 'text_delta', text: delta.text };
        } else if (delta.type === 'input_json_delta') {
          currentToolInput += delta.partial_json;
          yield {
            type: 'tool_use_delta',
            id: currentToolId,
            inputDelta: delta.partial_json,
          };
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolId) {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = currentToolInput ? JSON.parse(currentToolInput) : {};
          } catch {
            parsed = { _raw: currentToolInput };
          }
          yield {
            type: 'tool_use_end',
            id: currentToolId,
            name: currentToolName,
            input: parsed,
          };
          currentToolId = '';
          currentToolName = '';
          currentToolInput = '';
        }
      } else if (event.type === 'message_delta') {
        if (event.delta.stop_reason) {
          yield { type: 'message_end', stopReason: event.delta.stop_reason };
        }
      } else if (event.type === 'message_stop') {
        const finalMsg = await stream.finalMessage();
        const usage = finalMsg.usage as unknown as {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        yield {
          type: 'usage',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
        };
      }
    }
  }
}

function convertMessage(m: Message, promptCache: boolean): Anthropic.MessageParam {
  if (typeof m.content === 'string') {
    return { role: m.role as 'user' | 'assistant', content: m.content };
  }
  const blocks = m.content.map((b) => {
    if (b.type === 'text') return { type: 'text' as const, text: b.text };
    if (b.type === 'tool_use') {
      return {
        type: 'tool_use' as const,
        id: b.id,
        name: b.name,
        input: b.input,
      };
    }
    if (b.type === 'tool_result') {
      return {
        type: 'tool_result' as const,
        tool_use_id: b.toolUseId,
        content: b.content,
        is_error: b.isError,
      };
    }
    throw new Error('unknown content block');
  }) as unknown as Anthropic.MessageParam['content'];
  if (promptCache && m.cacheControl) {
    const last = blocks[blocks.length - 1];
    if (last && typeof last === 'object' && 'type' in last && (last as { type: string }).type === 'text') {
      (last as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
    }
  }
  return { role: m.role as 'user' | 'assistant', content: blocks };
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (msg.includes('rate limit') || msg.includes('429')) return true;
  if (msg.includes('timeout') || msg.includes('etimedout')) return true;
  if (msg.includes('econnreset') || msg.includes('econnrefused')) return true;
  if (msg.includes('529') || msg.includes('overloaded')) return true;
  return false;
}

function backoffMs(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(100, base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
