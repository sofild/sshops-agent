/**
 * 通用 LLM_* 环境变量测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
}));

describe('LLM_* env override', () => {
  beforeEach(() => {
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

  it('overrides active provider via LLM_PROVIDER', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_BASE_URL = 'http://proxy.example.com/v1';
    process.env.LLM_MODEL = 'deepseek_70b';
    const { resetConfigCache, loadAndValidate } = await import('../../src/config/loader.js');
    resetConfigCache();
    const r = loadAndValidate();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.providers.active).toBe('openai');
      expect(r.config.providers.providers.openai?.apiKey).toBe('test-key');
      expect(r.config.providers.providers.openai?.baseURL).toBe('http://proxy.example.com/v1');
      expect(r.config.providers.providers.openai?.model).toBe('deepseek_70b');
    }
  });

  it('supports anthropic as LLM_PROVIDER', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.LLM_API_KEY = 'sk-ant-test';
    process.env.LLM_MODEL = 'claude-3-5-sonnet-20241022';
    const { resetConfigCache, loadAndValidate } = await import('../../src/config/loader.js');
    resetConfigCache();
    const r = loadAndValidate();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.providers.active).toBe('anthropic');
      expect(r.config.providers.providers.anthropic?.apiKey).toBe('sk-ant-test');
      expect(r.config.providers.providers.anthropic?.model).toBe('claude-3-5-sonnet-20241022');
    }
  });

  it('LLM_* takes precedence over legacy ANTHROPIC_API_KEY', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_API_KEY = 'new-key';
    process.env.ANTHROPIC_API_KEY = 'legacy-key';
    const { resetConfigCache, loadAndValidate } = await import('../../src/config/loader.js');
    resetConfigCache();
    const r = loadAndValidate();
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 通用变量只覆盖 active provider；inactive provider 自己的
      // `${ANTHROPIC_API_KEY}` 占位符仍会按 YAML 引用展开。
      // 关键是 active openai 没有被 legacy ANTHROPIC_API_KEY 覆盖。
      expect(r.config.providers.providers.openai?.apiKey).toBe('new-key');
      expect(r.config.providers.providers.anthropic?.apiKey).toBe('legacy-key');
    }
  });

  it('legacy ANTHROPIC_API_KEY still works when LLM_API_KEY not set', async () => {
    process.env.ANTHROPIC_API_KEY = 'legacy-key';
    const { resetConfigCache, loadAndValidate } = await import('../../src/config/loader.js');
    resetConfigCache();
    const r = loadAndValidate();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.providers.providers.anthropic?.apiKey).toBe('legacy-key');
    }
  });
});
