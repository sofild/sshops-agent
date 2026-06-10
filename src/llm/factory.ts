/**
 * LLM Factory
 *
 * - 读取 config/providers.yaml 的 active 字段
 * - 单例缓存
 * - 支持模型降级链：通过 fallback() 切换到 chain 中下一个 provider 实例
 */
import { getConfig } from '../config/loader.js';
import type { LLMClient } from './types.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { ConfigError } from '../utils/errors.js';

let cached: LLMClient | null = null;
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
  cached = buildProvider(active, provider.model, provider.apiKey, provider.maxTokens, provider.temperature, provider.baseURL ?? null, cfg.providers.maxRetries);
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
  temperature: number,
  baseURL: string | null,
  maxRetries: number
): LLMClient {
  if (type === 'anthropic') {
    return new AnthropicProvider({
      apiKey,
      model,
      maxTokens,
      temperature,
      baseURL,
      promptCache: true,
      maxRetries,
    });
  }
  return new OpenAICompatibleProvider({
    apiKey,
    model,
    maxTokens,
    temperature,
    baseURL: baseURL ?? 'https://api.openai.com/v1',
    promptCache: false,
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
          provider.maxTokens,
          provider.temperature,
          provider.baseURL ?? null,
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

export function resetLLMCache(): void {
  cached = null;
  fallbackChain = [];
  currentIdx = 0;
  activeProviderName = '';
}
