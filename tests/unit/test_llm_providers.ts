/**
 * LLM 客户端抽象测试（不依赖真实 Provider）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 在导入 loader 前阻止 dotenv 读取用户 .env，避免污染
vi.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
}));

describe('LLMFactory', () => {
  beforeEach(() => {
    // 清理所有相关变量
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  it('returns anthropic provider by default (yaml active)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    const { resetConfigCache } = await import('../../src/config/loader.js');
    const { resetLLMCache, getLLMClient } = await import('../../src/llm/factory.js');
    resetConfigCache();
    resetLLMCache();
    const c = getLLMClient();
    expect(c.providerName).toBe('anthropic');
    expect(c.defaultModel).toMatch(/claude|gpt/);
  });

  it('fails clearly when the active provider key is unresolved', async () => {
    // beforeEach already deletes keys; active provider is anthropic by default.
    const { resetConfigCache } = await import('../../src/config/loader.js');
    const { resetLLMCache, getLLMClient } = await import('../../src/llm/factory.js');
    resetConfigCache();
    resetLLMCache();
    expect(() => getLLMClient()).toThrow(/unresolved/);
  });

  it('restores the primary model after a fallback (new run)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    const { resetConfigCache } = await import('../../src/config/loader.js');
    const { resetLLMCache, getLLMClient, fallbackToNext, resetModelFallback } = await import(
      '../../src/llm/factory.js'
    );
    resetConfigCache();
    resetLLMCache();
    const primary = getLLMClient();
    const switched = fallbackToNext('test');
    expect(switched).not.toBeNull();
    expect(getLLMClient().defaultModel).not.toBe(primary.defaultModel);
    resetModelFallback();
    expect(getLLMClient().defaultModel).toBe(primary.defaultModel);
    resetLLMCache();
  });

  it('uses LLM_PROVIDER env override', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_API_KEY = 'sk-test';
    const { resetConfigCache } = await import('../../src/config/loader.js');
    const { resetLLMCache, getLLMClient } = await import('../../src/llm/factory.js');
    resetConfigCache();
    resetLLMCache();
    const c = getLLMClient();
    expect(c.providerName).toBe('openai');
  });
});
