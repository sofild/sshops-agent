/**
 * 上下文预算测试
 *
 * 旧实现把 provider.maxTokens（输出上限，默认 8192）当上下文窗口，
 * 导致 200k 窗口模型被过早压缩。这里锁定正确口径。
 */
import { describe, it, expect } from 'vitest';
import {
  ContextBudget,
  estimateCharsToTokens,
  estimateRequestTokens,
  estimateToolsTokens,
  estimateSystemTokens,
  normalizeWindow,
} from '../../src/agent/context-budget.js';
import type { Message, ToolDefinition } from '../../src/llm/types.js';

const fakeLLM = {
  countTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + Math.ceil(text.length / 4);
    }, 0);
  },
};

describe('token estimation', () => {
  it('estimates chars to tokens with a conservative 4:1 ratio', () => {
    expect(estimateCharsToTokens(0)).toBe(0);
    expect(estimateCharsToTokens(1)).toBe(1);
    expect(estimateCharsToTokens(8)).toBe(2);
  });

  it('includes system prompt and tool schemas in request size', () => {
    const messages: Message[] = [{ role: 'user', content: 'x'.repeat(40) }];
    const tools: ToolDefinition[] = [
      {
        name: 'ssh_ssh_exec',
        description: 'execute',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ];
    const system = 'y'.repeat(40);

    const base = fakeLLM.countTokens(messages);
    expect(estimateSystemTokens(system)).toBe(10);
    expect(estimateToolsTokens(tools)).toBeGreaterThan(0);
    expect(estimateRequestTokens(fakeLLM, messages, system, tools)).toBe(
      base + 10 + estimateToolsTokens(tools)
    );
  });

  it('normalizes invalid context windows to the default', () => {
    expect(normalizeWindow(undefined)).toBe(128000);
    expect(normalizeWindow(0)).toBe(128000);
    expect(normalizeWindow(Number.NaN)).toBe(128000);
    expect(normalizeWindow(200000)).toBe(200000);
  });
});

describe('ContextBudget', () => {
  it('reserves output tokens inside the context window', () => {
    const budget = new ContextBudget({
      contextWindow: 1000,
      maxOutputTokens: 200,
      compactionRatio: 0.8,
    });
    // floor(1000*0.8) - 200 = 600
    expect(budget.promptBudgetTokens).toBe(600);
    expect(budget.shouldCompact(599)).toBe(false);
    expect(budget.shouldCompact(600)).toBe(true);
  });

  it('does not compact a 200k model at 8k tokens', () => {
    const budget = new ContextBudget({
      contextWindow: 200000,
      maxOutputTokens: 8192,
      compactionRatio: 0.85,
    });
    expect(budget.promptBudgetTokens).toBeGreaterThan(160000);
    expect(budget.shouldCompact(8000)).toBe(false);
  });

  it('clamps an oversized output reserve so compaction does not fire every step', () => {
    const budget = new ContextBudget({
      contextWindow: 1000,
      maxOutputTokens: 950,
      compactionRatio: 0.8,
    });
    // floor(1000*0.8) - floor(1000/2) = 300
    expect(budget.promptBudgetTokens).toBe(300);
    expect(budget.shouldCompact(200)).toBe(false);
    expect(budget.shouldCompact(300)).toBe(true);
  });

  it('clamps nonsensical ratios to a safe default', () => {
    const budget = new ContextBudget({
      contextWindow: 10000,
      maxOutputTokens: 1000,
      compactionRatio: 2,
    });
    expect(budget.compactionRatio).toBe(0.85);
  });
});
