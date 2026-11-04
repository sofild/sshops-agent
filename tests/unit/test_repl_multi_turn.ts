/**
 * loadHistory 重建完整多模态 messages 列表的测试
 *
 * 关键：必须保留 assistant 消息中的 tool_use 块和 user 消息中的 tool_result 块
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadHistory (multi-turn message reconstruction)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sshops-history-'));
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, 'package.json'), '{}');
  });

  it('reconstructs full message sequence with tool_use and tool_result', async () => {
    const { Session } = await import('../../src/session/wal.js');
    const { loadHistory } = await import('../../src/agent/core.js');
    const sid = 'history-test-' + Date.now();
    const session = Session.open(sid);
    session.append({ type: 'user_message', data: { text: '帮我装 nginx' } });
    session.append({
      type: 'assistant_message',
      data: {
        text: '好的，我先连接',
        tool_uses: [{ id: 'tc1', name: 'ssh_ssh_connect', input: { host: '1.2.3.4' } }],
        stopReason: 'tool_use',
      },
    });
    session.append({
      type: 'tool_result',
      data: { id: 'tc1', content: 'connected', isError: false },
    });
    session.append({
      type: 'assistant_message',
      data: {
        text: '已连接，安装 nginx 中',
        tool_uses: [{ id: 'tc2', name: 'ssh_ssh_execute', input: { host: '1.2.3.4', command: 'apt install nginx -y' } }],
        stopReason: 'end_turn',
      },
    });
    session.close();

    const history = await loadHistory(sid);
    // 期待：user, assistant(tool_use tc1), user(tool_result tc1),
    //       assistant(tool_use tc2), user(synthetic tool_result tc2)
    // 最后一个 tool_use 没有真实结果（模拟中断），loadHistory 会补一条
    // synthetic tool_result，保证 provider 协议完整。
    expect(history.length).toBe(5);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
    const assistant1 = history[1].content as Array<Record<string, unknown>>;
    expect(assistant1.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 'tc1')).toBe(true);
    expect(history[2].role).toBe('user');
    const user2 = history[2].content as Array<Record<string, unknown>>;
    expect(user2.some((b) => b.type === 'tool_result' && (b as { toolUseId: string }).toolUseId === 'tc1')).toBe(true);
    expect(history[3].role).toBe('assistant');
    const assistant2 = history[3].content as Array<Record<string, unknown>>;
    expect(assistant2.some((b) => b.type === 'tool_use' && (b as { id: string }).id === 'tc2')).toBe(true);
    expect(history[4].role).toBe('user');
    const synthetic = history[4].content as Array<Record<string, unknown>>;
    expect(synthetic[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tc2',
      isError: true,
    });
  });

  it('groups parallel tool results into one user message despite interleaved tool_call events', async () => {
    const { Session } = await import('../../src/session/wal.js');
    const { loadHistory } = await import('../../src/agent/core.js');
    const sid = 'parallel-history-' + Date.now();
    const session = Session.open(sid);
    session.append({ type: 'user_message', data: { text: '探测两台机器' } });
    session.append({
      type: 'assistant_message',
      data: {
        text: '',
        tool_uses: [
          { id: 'p1', name: 'ssh_ssh_exec', input: { command: 'uptime' } },
          { id: 'p2', name: 'ssh_ssh_exec', input: { command: 'df -h' } },
        ],
        stopReason: 'tool_use',
      },
    });
    session.append({ type: 'tool_call', data: { id: 'p1', name: 'ssh_ssh_exec', args: {} } });
    session.append({ type: 'tool_result', data: { id: 'p1', content: 'up', isError: false } });
    session.append({ type: 'tool_call', data: { id: 'p2', name: 'ssh_ssh_exec', args: {} } });
    session.append({ type: 'tool_result', data: { id: 'p2', content: 'disk', isError: false } });
    session.close();

    const history = await loadHistory(sid);
    expect(history).toHaveLength(3);
    expect(history[2].role).toBe('user');
    const blocks = history[2].content as Array<Record<string, unknown>>;
    const results = blocks.filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results.map((b) => b.toolUseId)).toEqual(['p1', 'p2']);
  });

  it('synthesizes missing tool results for interrupted turns', async () => {
    const { Session } = await import('../../src/session/wal.js');
    const { loadHistory } = await import('../../src/agent/core.js');
    const sid = 'partial-history-' + Date.now();
    const session = Session.open(sid);
    session.append({ type: 'user_message', data: { text: '执行两个命令' } });
    session.append({
      type: 'assistant_message',
      data: {
        text: '',
        tool_uses: [
          { id: 'q1', name: 'ssh_ssh_exec', input: { command: 'a' } },
          { id: 'q2', name: 'ssh_ssh_exec', input: { command: 'b' } },
        ],
        stopReason: 'tool_use',
      },
    });
    session.append({ type: 'tool_call', data: { id: 'q1', name: 'ssh_ssh_exec', args: {} } });
    session.append({ type: 'tool_result', data: { id: 'q1', content: 'ok', isError: false } });
    // q2 的结果丢失（模拟中断）
    session.append({ type: 'assistant_message', data: { text: '继续', tool_uses: [], stopReason: 'end_turn' } });
    session.close();

    const history = await loadHistory(sid);
    expect(history).toHaveLength(4);
    const resultBlocks = history[2].content as Array<Record<string, unknown>>;
    const results = resultBlocks.filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ toolUseId: 'q2', isError: true });
    expect(String(results[1].content)).toContain('no tool result recorded');
  });

  it('cleanup', () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore on Windows
    }
  });
});

/**
 * Phase 5：REPL 退出命令文档化
 *  - /help 文本必须列出所有支持的退出命令（包括裸命令：exit、quit、q 等）
 *  - 这是 EXIT_COMMANDS Set 的 proxy test（避免导出 startRepl 内部状态）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../../src/config/loader.js';

describe('REPL HELP text (Phase 5 exit commands)', () => {
  it('documents all supported exit commands in /help', () => {
    const replPath = resolve(PROJECT_ROOT, 'src', 'cli', 'repl.ts');
    const content = readFileSync(replPath, 'utf-8');

    // HELP 文本必须出现在 repl.ts 内
    const helpMatch = content.match(/const HELP = `([\s\S]*?)`\.trim\(\);/);
    expect(helpMatch).not.toBeNull();
    const helpText = helpMatch![1];

    // 必出现的退出命令
    const requiredCommands = [
      '/exit', '/quit', 'exit', 'quit', 'q', ':q', '.exit', 'Ctrl+C', 'Ctrl+D',
    ];
    for (const cmd of requiredCommands) {
      expect(helpText, `HELP must mention "${cmd}"`).toContain(cmd);
    }
  });

  it('EXIT_COMMANDS Set in repl.ts contains all bare + slash commands', () => {
    const replPath = resolve(PROJECT_ROOT, 'src', 'cli', 'repl.ts');
    const content = readFileSync(replPath, 'utf-8');
    const setMatch = content.match(/const EXIT_COMMANDS = new Set\(\[([\s\S]*?)\]\)/);
    expect(setMatch).not.toBeNull();
    const items = setMatch![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(items).toEqual(
      expect.arrayContaining([
        '/exit', '/quit', 'exit', 'quit', 'q', ':q', ':quit', '.exit',
      ])
    );
  });
});
