/**
 * CLI UI 单元测试
 *
 * 覆盖：
 *  - prompt() 在 TTY / 非 TTY 下行为稳定
 *  - prompt() 字符串无 ▌ 字符（避免 Windows Conhost 字符宽度错位）
 *  - printLog() 输出含 [log] / [warn] / [err] 级别标签
 *  - printTurnSeparator() 在 TTY 下走 stdout，在非 TTY 下 noop
 *  - endAgentText() 幂等（多次调用不会重复输出换行）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ui.prompt()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('non-TTY: returns plain "> "', async () => {
    // 强制 isTTY = false
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      const { ui } = await import('../../src/cli/ui.js');
      // stripAnsi 不暴露给外部，但 prompt() 本身不会带 ANSI
      const p = ui.prompt();
      expect(p).toBe('> ');
      expect(p).not.toContain('▌');
    } finally {
      if (orig) Object.defineProperty(process.stdout, 'isTTY', orig);
    }
  });

  it('TTY: prompt does NOT contain ▌ (Windows Conhost 字符宽度错位)', async () => {
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const { ui } = await import('../../src/cli/ui.js');
      const p = ui.prompt();
      // strip ANSI 后必须含 >，且不含 ▌
      const stripped = p.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toContain('>');
      expect(p).not.toContain('▌');
    } finally {
      if (orig) Object.defineProperty(process.stdout, 'isTTY', orig);
    }
  });
});

describe('ui.printLog()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('writes to stderr with level tag prefix', async () => {
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const stderrWrites: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error mock overload
    process.stderr.write = vi.fn((s: string) => {
      stderrWrites.push(s);
      return true;
    });
    try {
      const { ui } = await import('../../src/cli/ui.js');
      ui.printLog('info', 'test.comp', 'hello world');
      ui.printLog('warn', 'test.comp', 'something looks off');
      ui.printLog('error', 'test.comp', 'something broke');
      const combined = stderrWrites.join('');
      expect(combined).toContain('[log]  ');
      expect(combined).toContain('[warn] ');
      expect(combined).toContain('[err]  ');
      expect(combined).toContain('test.comp');
      expect(combined).toContain('hello world');
    } finally {
      if (orig) Object.defineProperty(process.stdout, 'isTTY', orig);
      process.stderr.write = origStderrWrite;
    }
  });
});

describe('ui.printTurnSeparator()', () => {
  it('non-TTY: writes nothing', async () => {
    vi.resetModules();
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const stdoutWrites: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-expect-error mock overload
    process.stdout.write = vi.fn((s: string) => {
      stdoutWrites.push(s);
      return true;
    });
    try {
      const { ui } = await import('../../src/cli/ui.js');
      ui.printTurnSeparator();
      expect(stdoutWrites.length).toBe(0);
    } finally {
      if (orig) Object.defineProperty(process.stdout, 'isTTY', orig);
      process.stdout.write = origWrite;
    }
  });
});

describe('ui.endAgentText()', () => {
  it('is idempotent (no duplicate newlines)', async () => {
    vi.resetModules();
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const stdoutWrites: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // @ts-expect-error mock overload
    process.stdout.write = vi.fn((s: string) => {
      stdoutWrites.push(s);
      return true;
    });
    try {
      const { ui } = await import('../../src/cli/ui.js');
      // 第一次进入流
      ui.printAgentText('hello');
      // 显式结束
      ui.endAgentText();
      // 再次结束（应当 noop）
      ui.endAgentText();
      // 第三次结束（应当 noop）
      ui.endAgentText();
      const allWrites = stdoutWrites.join('');
      // 只应该出现 1 个结尾换行（在 printAgentText 后的 endAgentText 写入）
      // 总写入了：prefix + 'hello' + '\n' = 3 段
      const textWrites = stdoutWrites.filter((s) => s === '\n' || s === '\r\n');
      // 仅 endAgentText 第一次调用会写 \n，后续 noop
      expect(textWrites.length).toBe(1);
      expect(allWrites).toContain('hello');
    } finally {
      if (orig) Object.defineProperty(process.stdout, 'isTTY', orig);
      process.stdout.write = origWrite;
    }
  });
});
