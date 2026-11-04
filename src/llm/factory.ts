/**
 * LLM Factory
 *
 * - 读取 config/providers.yaml 的 active 字段
 * - 单例缓存
 * - 支持模型降级链：通过 fallback() 切换到 chain 中下一个 provider 实例
 */
import { getConfig, isUnresolvedPlaceholder } from '../config/loader.js';
import type { LLMClient } from './types.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { ConfigError } from '../utils/errors.js';

let cached: LLMClient | null = null;
let primaryClient: LLMClient | null = null;
let fallbackChain: LLMClient[] = [];
let currentIdx = 0;
let activeProviderName = '';

export function getLLMClient(): LLMClient {
  if (cached) return cached;
  const cfg = getConfig();
  const active = cfg.providers.active as 'anthropic' | 'openai';
  const provider = cfg.providers.providers[active];
  if (!provider) {
    throw new ConfigError(`active provider not configured: ${active}`);
  }
  if (isUnresolvedPlaceholder(provider.apiKey)) {
    throw new ConfigError(
      `provider ${active} apiKey is unresolved (${provider.apiKey}). ` +
        `Set the referenced environment variable or LLM_API_KEY.`
    );
  }
  cached = buildProvider(
    active,
    provider.model,
    provider.apiKey,
    provider.maxTokens,
    provider.contextWindow,
    provider.temperature,
    provider.baseURL ?? null,
    provider.promptCache,
    cfg.providers.maxRetries
  );
  primaryClient = cached;
  activeProviderName = active;
  // 构建降级链
  fallbackChain = buildFallbackChain(active, cfg);
  currentIdx = 0;
  return cached;
}

function buildProvider(
  type: 'anthropic' | 'openai',
  model: string,
  apiKey: string,
  maxTokens: number,
  contextWindow: number,
  temperature: number,
  baseURL: string | null,
  promptCache: boolean,
  maxRetries: number
): LLMClient {
  if (type === 'anthropic') {
    return new AnthropicProvider({
      apiKey,
      model,
      maxTokens,
      contextWindow,
      temperature,
      baseURL,
      promptCache,
      maxRetries,
    });
  }
  return new OpenAICompatibleProvider({
    apiKey,
    model,
    maxTokens,
    contextWindow,
    temperature,
    baseURL: baseURL ?? 'https://api.openai.com/v1',
    promptCache,
    maxRetries,
  });
}

function buildFallbackChain(active: 'anthropic' | 'openai', cfg: ReturnType<typeof getConfig>): LLMClient[] {
  const fb = cfg.agent.fallback?.[active] ?? [];
  const out: LLMClient[] = [];
  for (const f of fb) {
    try {
      const provider = cfg.providers.providers[active];
      if (!provider) continue;
      out.push(
        buildProvider(
          active,
          f.model,
          provider.apiKey,
          f.maxTokens ?? provider.maxTokens,
          f.contextWindow ?? provider.contextWindow,
          provider.temperature,
          provider.baseURL ?? null,
          provider.promptCache,
          cfg.providers.maxRetries
        )
      );
    } catch {
      // 跳过不可用的 fallback
    }
  }
  return out;
}

/** 切换到降级链下一个模型；返回 { from, to, ok } */
export function fallbackToNext(reason: string): { from: string; to: string } | null {
  if (currentIdx >= fallbackChain.length) return null;
  const prev = cached!;
  currentIdx++;
  const next = fallbackChain[currentIdx - 1];
  cached = next;
  return {
    from: `${activeProviderName}:${prev.defaultModel}`,
    to: `${activeProviderName}:${next.defaultModel}`,
  };
}

/**
 * 每个新 run 开始时恢复到主模型。
 *
 * 旧实现只有模块级 cached/currentIdx：一次瞬时错误会让整个进程（包括
 * 后续会话/并发 run）永久停在 fallback 模型上，链耗尽后也永远不会恢复。
 * 可选的冷却/健康检查留给后续里程碑；至少保证 run 之间可恢复。
 */
export function resetModelFallback(): void {
  if (!primaryClient) return;
  cached = primaryClient;
  currentIdx = 0;
}

export function resetLLMCache(): void {
  cached = null;
  primaryClient = null;
  fallbackChain = [];
  currentIdx = 0;
  activeProviderName = '';
}
