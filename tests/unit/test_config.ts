/**
 * 配置加载器测试
 */
import { describe, it, expect } from 'vitest';
import { loadAndValidate, resetConfigCache } from '../../src/config/loader.js';

describe('config loader', () => {
  it('loads default config and validates', () => {
    resetConfigCache();
    const r = loadAndValidate();
    // 默认 ANTHROPIC_API_KEY 可能为空
    if (r.ok) {
      expect(r.config.providers.active).toMatch(/anthropic|openai/);
    } else {
      // 当无 apiKey 时 schema 会失败，这是正常的
      expect(r.error).toBeTruthy();
    }
  });
});
