/**
 * 配置层测试：环境变量占位符 + SSHOPS_* 运行参数覆盖
 *
 * 这些能力在 README 中已经承诺，但旧实现没有接线：
 *  - providers.yaml 的 `${...}` 被当成字面量 API key；
 *  - SSHOPS_MAX_STEPS / SSHOPS_MAX_DURATION_SECONDS / SSHOPS_TOOL_TIMEOUT_SECONDS
 *    从未生效。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  expandEnvPlaceholders,
  getConfig,
  resetConfigCache,
} from '../../src/config/loader.js';

const MANAGED_ENV = [
  'SSHOPS_MAX_STEPS',
  'SSHOPS_MAX_DURATION_SECONDS',
  'SSHOPS_TOOL_TIMEOUT_SECONDS',
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'TEST_PLACEHOLDER_A',
];

function clearEnv(): void {
  for (const key of MANAGED_ENV) delete process.env[key];
}

describe('expandEnvPlaceholders', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('expands ${VAR} when the variable is set', () => {
    process.env.TEST_PLACEHOLDER_A = 'hello';
    expect(expandEnvPlaceholders('prefix-${TEST_PLACEHOLDER_A}-suffix')).toBe(
      'prefix-hello-suffix'
    );
  });

  it('keeps unresolved placeholders visible instead of silently using the literal', () => {
    expect(expandEnvPlaceholders('${TEST_PLACEHOLDER_MISSING}')).toBe(
      '${TEST_PLACEHOLDER_MISSING}'
    );
  });

  it('supports ${VAR:-default}', () => {
    expect(expandEnvPlaceholders('${TEST_PLACEHOLDER_MISSING:-fallback}')).toBe(
      'fallback'
    );
    process.env.TEST_PLACEHOLDER_A = 'explicit';
    expect(expandEnvPlaceholders('${TEST_PLACEHOLDER_A:-fallback}')).toBe('explicit');
  });

  it('expands recursively in nested YAML structures', () => {
    process.env.TEST_PLACEHOLDER_A = 'x';
    expect(
      expandEnvPlaceholders({
        provider: { apiKey: '${TEST_PLACEHOLDER_A}', list: ['${TEST_PLACEHOLDER_A}'] },
      })
    ).toEqual({ provider: { apiKey: 'x', list: ['x'] } });
  });
});

describe('SSHOPS_* agent overrides', () => {
  beforeEach(() => {
    clearEnv();
    resetConfigCache();
  });
  afterEach(() => {
    clearEnv();
    resetConfigCache();
  });

  it('applies max steps / duration / tool timeout from env', () => {
    process.env.SSHOPS_MAX_STEPS = '7';
    process.env.SSHOPS_MAX_DURATION_SECONDS = '42';
    process.env.SSHOPS_TOOL_TIMEOUT_SECONDS = '9';
    resetConfigCache();

    const cfg = getConfig();
    expect(cfg.agent.maxSteps).toBe(7);
    expect(cfg.agent.maxDurationSeconds).toBe(42);
    expect(cfg.agent.toolTimeoutSeconds).toBe(9);
  });

  it('ignores invalid env values instead of producing NaN', () => {
    process.env.SSHOPS_MAX_STEPS = 'not-a-number';
    resetConfigCache();

    const cfg = getConfig();
    expect(Number.isFinite(cfg.agent.maxSteps)).toBe(true);
    expect(cfg.agent.maxSteps).toBeGreaterThan(0);
  });

  it('loads provider contextWindow from YAML (not output maxTokens)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    resetConfigCache();

    const cfg = getConfig();
    expect(cfg.providers.providers.anthropic?.contextWindow).toBe(200000);
    expect(cfg.providers.providers.openai?.contextWindow).toBe(128000);
  });
});
