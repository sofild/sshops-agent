/**
 * OpenAI 兼容 Provider
 *
 * - 基于 openai SDK
 * - 支持自定义 base_url（vLLM / Ollama / DeepSeek / 任何 OpenAI 兼容 API）
 * - tool calling 转换
 */
import OpenAI from 'openai';
import type {
  LLMClient,
  Message,
  ChatOptions,
  StreamEvent,
} from '../types.js';
import { LLMError, RetryExhaustedError } from '../../utils/errors.js';
import { getLogger } from '../../observability/logging.js';
import { convertMessages } from './openai-messages.js';

const log = getLogger().child({ component: 'llm.openai' });

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  baseURL: string;
  promptCache: boolean;
  maxRetries: number;
}

export class OpenAICompatibleProvider implements LLMClient {
  readonly providerName = 'openai';
  readonly defaultModel: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  private client: OpenAI;
  private opts: OpenAIProviderOptions;

  constructor(opts: OpenAIProviderOptions) {
    this.opts = opts;
    this.defaultModel = opts.model;
    this.contextWindow = opts.contextWindow;
    this.maxOutputTokens = opts.maxTokens;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxRetries: 0,
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
              `openai chat failed after ${attempt + 1} attempts: ${String(err)}`,
              attempt + 1
            );
          }
          throw new LLMError(
            err instanceof Error ? err.message : String(err),
            this.providerName
          );
        }
        const delay = backoffMs(attempt);
        log.warn({ attempt, delay, err: String(err) }, 'openai retry');
        await sleep(delay);
      }
    }
    throw lastErr instanceof Error ? lastErr : new LLMError('unknown', this.providerName);
  }

  private async *doChat(
    messages: Message[],
    options: ChatOptions
  ): AsyncIterable<StreamEvent> {
    const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (options.system) {
      oaiMessages.push({ role: 'system', content: options.system });
    }
    oaiMessages.push(...convertMessages(messages));

    const tools: OpenAI.Chat.ChatCompletionTool[] | undefined = options.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model: options.model ?? this.opts.model,
      max_tokens: options.maxTokens ?? this.opts.maxTokens,
      temperature: options.temperature ?? this.opts.temperature,
      messages: oaiMessages,
      tools,
      tool_choice: tools && tools.length > 0 ? options.toolChoice : undefined,
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: options.signal });

    const messageId = `msg-${Date.now()}`;
    yield { type: 'message_start', messageId };

    // 用于累积工具调用。某些 OpenAI 兼容网关会把 id / name / arguments
    // 拆到不同 chunk，甚至 name 晚于 id 到达，因此这里按 index 累积，
    // 等 name 可用时再发 tool_use_start。
    const toolCalls = new Map<
      number,
      { id: string; name: string; input: string; started: boolean }
    >();

    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        throw new LLMError('aborted', this.providerName);
      }
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        yield { type: 'text_delta', text: choice.delta.content };
      }
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, {
              id: tc.id ?? `call_${idx}`,
              name: tc.function?.name ?? '',
              input: '',
              started: false,
            });
          }
          const acc = toolCalls.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (!acc.started && acc.name) {
            acc.started = true;
            yield { type: 'tool_use_start', id: acc.id, name: acc.name };
          }
          if (tc.function?.arguments) {
            acc.input += tc.function.arguments;
            yield { type: 'tool_use_delta', id: acc.id, inputDelta: tc.function.arguments };
          }
        }
      }
      if (choice?.finish_reason) {
        yield { type: 'message_end', stopReason: choice.finish_reason };
      }
      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }

    for (const [, tc] of toolCalls) {
      // 极端情况下 name 始终缺失：仍然发出 start，让上层明确报错而不是
      // 用一个空工具名去执行。
      if (!tc.started) {
        yield { type: 'tool_use_start', id: tc.id, name: tc.name };
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = tc.input ? JSON.parse(tc.input) : {};
      } catch {
        parsed = { _raw: tc.input };
      }
      yield { type: 'tool_use_end', id: tc.id, name: tc.name, input: parsed };
    }
  }
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
