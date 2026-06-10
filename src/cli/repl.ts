/**
 * 交互式 REPL
 *
 * - 真实多轮：每轮从 final_history 事件获取完整 messages，下一轮复用
 * - need_input: 渲染 Question[] 提示用户补齐
 * - options_menu: 渲染 1-N 选项菜单
 * - /exit 持久化 lastSessionId；启动时按 mtime 自动恢复
 *
 * v2 升级（2026-05）：
 *  - 用 ui.ts 集中渲染（banner / box / spinner / log）
 *  - 用 readline 自管状态修复提示符 `>` 在 agentRun 期间消失的问题
 *  - 用 ui.spinner.start/stop 替代之前的 [wait] 等裸输出
 */
import { createInterface, type Interface as RLInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../config/loader.js';
import { run as agentRun, type AgentEvent } from '../agent/core.js';
import { loadHistory } from '../agent/core.js';
import { listSessions, Session } from '../session/wal.js';
import { metrics } from '../observability/metrics.js';
import { getLogger, setReplMode } from '../observability/logging.js';
import { getConfig } from '../config/loader.js';
import type { Message } from '../llm/types.js';
import type { Question, MenuOption } from '../agent/types.js';
import { loadMemoryDataSource } from '../agent/memory.js';
import { InvalidOptionError } from '../utils/errors.js';
import { ui } from './ui.js';
import { bootstrapTools, shutdownTools } from '../tools/bootstrap.js';
import chalk from 'chalk';

const log = getLogger().child({ component: 'repl' });
const c = chalk; // 简化引用
const LAST_SESSION_FILE = resolve(PROJECT_ROOT, 'sessions', '.last-session-id');

const HELP = `
sshops-agent 交互式 REPL

退出（任一即可）：
  /exit    exit    quit    :q     Ctrl+C
  /quit    .exit   q       Ctrl+D (EOF)

其他命令:
  /help       显示此帮助
  /clear      清空当前消息历史
  /resume [id]  恢复指定会话（不指定则取最近）
  /sessions   列出所有历史会话
  /memory list  列出所有持久化记忆条目

直接输入自然语言任务，例如：
  连接 10.222.10.48 查系统信息
  在 web-01 装 nginx
  帮我把 db-backup 主机名查一下
`.trim();

export async function startRepl(initialSessionId?: string): Promise<void> {
  // 切换到 REPL 模式：让所有 pino 日志走 ui.printLog
  setReplMode(true);

  let history: Message[] = [];
  let sessionId: string | undefined = initialSessionId;
  const nonInteractive = !!process.env.SSHOPS_NONINTERACTIVE;

  // Phase 4: REPL 级 connectionId 缓存。跨多轮对话复用 alias/host → realCid 映射。
  const replConnectionIdCache = new Map<string, string>();

  // 自动恢复最近的会话
  if (!sessionId) {
    const last = readLastSessionId();
    if (last) {
      try {
        history = await loadHistory(last);
        sessionId = last;
        ui.printLog('info', 'repl', `resumed last session ${last.slice(0, 16)}... (${history.length} messages)`);
      } catch (err) {
        log.warn({ err: String(err) }, 'failed to resume last session');
      }
    }
  } else {
    try {
      history = await loadHistory(sessionId);
      ui.printLog('info', 'repl', `resumed session ${sessionId.slice(0, 16)}... (${history.length} messages)`);
    } catch (err) {
      log.warn({ err: String(err) }, 'failed to resume given sessionId');
      sessionId = undefined;
    }
  }

  // 启动工具（自研 SshProvider）
  try {
    await bootstrapTools();
  } catch (err) {
    ui.printError(`工具启动失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  // 启动 banner
  printBanner();

  // 等 banner 的 stdout.write 全部 flush 到 fd，避免与 readline 的 prompt 抢顺序
  // 修复：banner 写入 vs rl.prompt() 写入若被 batch，会出现"按回车才看到 prompt"的现象
  await new Promise<void>((r) => setImmediate(r));

  // 品牌锚点行（独立显示，提示符用纯 ASCII > 避免字符宽度错位）
  process.stdout.write(c.dim('  ── sshops-agent interactive shell ──\n\n'));

  // 准备 readline —— 关键：terminal:true 让 readline 自己画 prompt 与处理方向键
  const rl: RLInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  rl.setPrompt(ui.prompt());

  // Phase 5: askLine 可被 reject（stdin 关闭 / Ctrl+D / rl.close 时）
  let pendingAskReject: ((reason: Error) => void) | null = null;
  const askLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      pendingAskReject = reject;
      rl.once('line', (line) => {
        pendingAskReject = null;
        resolve(line);
      });
    });

  // Phase 5: rl 关闭时（如 Ctrl+D）立刻 reject pendingAskReject，
  // 让外层 try/catch 命中并 break。否则 promise 永远 pending。
  rl.on('close', () => {
    if (pendingAskReject) {
      pendingAskReject(new Error('readline closed (Ctrl+D / EOF)'));
      pendingAskReject = null;
    }
  });

  // Phase 5: stdin end 事件（EOF）友好提示
  process.stdin.on('end', () => {
    process.stdout.write(`\n${c.dim('  (Ctrl+D detected, exiting...)')}\n`);
  });

  const passwordMode = (): Promise<string> =>
    new Promise((resolve) => {
      const stdin = process.stdin;
      const stdout = process.stdout;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      let buf = '';
      const onData = (ch: string) => {
        for (const c of ch) {
          if (c === '\n' || c === '\r' || c === '\x04') {
            stdin.removeListener('data', onData);
            if (stdin.isTTY) stdin.setRawMode?.(false);
            stdout.write('\n');
            resolve(buf);
            return;
          }
          if (c === '\x03') {
            process.exit(130);
          }
          if (c === '\x7f' || c === '\b') {
            buf = buf.slice(0, -1);
            stdout.write('\b \b');
            continue;
          }
          buf += c;
          stdout.write('*');
        }
      };
      stdin.on('data', onData);
    });

  // 立即画一次 prompt
  rl.prompt();

  // Phase 5: SIGINT 双击退出 + 中断 in-flight run
  // 行为对齐 Claude Code / ipython：
  //   - in-flight 时：第一次 Ctrl+C 中断当前 turn（保留 session），
  //     第二次 Ctrl+C（在 1.5s 窗口内）退出整个 REPL
  //   - 无 in-flight 时：第一次 Ctrl+C 直接退出
  let sigintCount = 0;
  let inFlightAbort: AbortController | null = null;
  let lastSigintAt = 0;
  const SIGINT_WINDOW_MS = 1500;

  process.on('SIGINT', () => {
    const now = Date.now();
    if (now - lastSigintAt > SIGINT_WINDOW_MS) sigintCount = 0;
    lastSigintAt = now;
    sigintCount++;

    if (ui.spinner.isRunning()) ui.spinner.stop();

    if (inFlightAbort) {
      if (sigintCount === 1) {
        inFlightAbort.abort();
        ui.printLog('warn', 'repl', 'interrupted by Ctrl+C (press again to exit)');
        return;
      }
      // 第二次：直接退出
      void gracefulShutdown('sigint', sessionId);
      return;
    }

    // 没 in-flight run：第一次也退出
    void gracefulShutdown('sigint', sessionId);
  });

  while (true) {
    let input: string;
    try {
      input = await askLine();
    } catch {
      // EOF (Ctrl+D)
      break;
    }
    let trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }
    // Phase 5: 退出命令集（含裸命令 / shell 习惯：q、:q、.exit 等）
    const EXIT_COMMANDS = new Set([
      '/exit', '/quit',
      'exit', 'quit', 'q',
      ':q', ':quit', '.exit',
    ]);
    if (EXIT_COMMANDS.has(trimmed.toLowerCase())) break;
    if (trimmed === '/help') {
      process.stdout.write(HELP + '\n');
      rl.prompt();
      continue;
    }
    if (trimmed === '/clear') {
      history = [];
      sessionId = undefined;
      ui.printLog('warn', 'repl', 'history cleared');
      rl.prompt();
      continue;
    }
    if (trimmed === '/sessions') {
      const all = listSessions();
      if (all.length === 0) process.stdout.write('(no sessions)\n');
      else {
        for (const s of all.slice(0, 10)) {
          process.stdout.write(`  ${s.id}  ${s.size}B  ${s.mtime.toISOString()}\n`);
        }
      }
      rl.prompt();
      continue;
    }
    if (trimmed.startsWith('/resume')) {
      const id = trimmed.slice('/resume'.length).trim();
      const target = id || listSessions()[0]?.id;
      if (!target) {
        ui.printError('no session to resume');
        rl.prompt();
        continue;
      }
      try {
        history = await loadHistory(target);
        sessionId = target;
        ui.printLog('info', 'repl', `resumed ${target} (${history.length} messages)`);
      } catch (err) {
        ui.printError(`resume failed: ${err}`);
      }
      rl.prompt();
      continue;
    }
    if (trimmed.startsWith('/memory')) {
      const arg = trimmed.slice('/memory'.length).trim();
      if (arg === 'list') {
        const { listMemory } = await import('../agent/memory.js');
        const items = listMemory();
        process.stdout.write(items.length === 0 ? '(empty)\n' : items.join('\n') + '\n');
      } else {
        process.stdout.write('usage: /memory list\n');
      }
      rl.prompt();
      continue;
    }

    // 正常对话：保存光标 + 擦行（让 agentRun 期间的 stdout 不被 readline 重画覆盖）
    process.stdout.write(ui.ansi.saveCursor);
    process.stdout.write(ui.ansi.eraseLine);
    process.stdout.write(ui.ansi.cursorLeft);

    let turnDone = false;
    let continueRun = true;
    while (continueRun) {
      continueRun = false;
      let pendingQuestion: Question[] | null = null;
      let pendingOptions: { toolUseId: string; prompt: string; field: string; options: MenuOption[] } | null =
        null;

      try {
        // agentRun 开始：启动 thinking spinner
        ui.spinner.start('思考中...');
        // Phase 5: 创建 per-turn abort controller，传给 agentRun
        inFlightAbort = new AbortController();
        try {
          for await (const ev of agentRun(trimmed, {
            history,
            sessionId,
            nonInteractive,
            // Phase 4: 透传 REPL 级缓存
            connectionIdCache: replConnectionIdCache,
            // Phase 5: 透传 abort signal（Ctrl+C 中断当前 turn）
            abortSignal: inFlightAbort.signal,
          })) {
          switch (ev.type) {
            case 'session_start':
              sessionId = ev.sessionId;
              break;
            case 'text':
              // 收到第一个 text chunk 时停止 spinner
              if (ui.spinner.isRunning()) ui.spinner.stop();
              ui.printAgentText(ev.text);
              break;
            case 'tool_call':
              if (ui.spinner.isRunning()) ui.spinner.stop();
              // 结束 agent 文本流（tool_call 另起一行）
              ui.endAgentText();
              ui.printToolCall(ev.name, ev.args);
              break;
            case 'tool_result':
              ui.printToolResult(
                !ev.result.isError,
                ev.result.content,
                (ev.result.data as { durationMs?: number } | undefined)?.durationMs
              );
              break;
            case 'tool_denied':
              ui.printError(`denied: ${ev.name}: ${ev.reason}`);
              break;
            case 'tool_confirm_required':
              ui.printLog('warn', 'repl', `confirm required: ${ev.name}: ${ev.reason}`);
              break;
            case 'need_input':
              if (ui.spinner.isRunning()) ui.spinner.stop();
              ui.endAgentText();
              pendingQuestion = ev.questions;
              ui.printNeedInput(ev.questions);
              break;
            case 'options_menu':
              if (ui.spinner.isRunning()) ui.spinner.stop();
              ui.endAgentText();
              pendingOptions = {
                toolUseId: ev.toolUseId,
                prompt: ev.prompt,
                field: ev.field,
                options: ev.options,
              };
              ui.printOptionsMenu(ev.prompt, ev.options);
              break;
            case 'compression':
              ui.printCompression(ev.level);
              break;
            case 'state_change':
              // 静默记录到 metrics
              metrics.stateTransitions.inc({ from: ev.from, to: ev.to });
              break;
            case 'fallback':
              ui.printLog(
                'warn',
                'repl',
                `fallback ${ev.fromModel} → ${ev.toModel} (${ev.reason})`
              );
              metrics.fallbackEvents.inc({ from: ev.fromModel, to: ev.toModel });
              break;
            case 'final':
              if (ui.spinner.isRunning()) ui.spinner.stop();
              ui.endAgentText();
              ui.printFinal(ev.answer);
              break;
            case 'final_history':
              history = ev.messages; // 关键：完整覆盖 history
              break;
            case 'error':
              if (ui.spinner.isRunning()) ui.spinner.stop();
              ui.endAgentText();
              ui.printError(ev.error.message);
              break;
            case 'session_end':
              if (ui.spinner.isRunning()) ui.spinner.stop();
              ui.endAgentText();
              ui.printTurnSeparator();
              turnDone = true;
              break;
          }
        }
        } finally {
          // Phase 5: turn 结束，重置 abort + sigint 计数
          inFlightAbort = null;
          sigintCount = 0;
        }
      } catch (err) {
        if (ui.spinner.isRunning()) ui.spinner.stop();
        ui.endAgentText();
        // Phase 5: 区分 abort 触发的退出与真实错误
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('aborted') || msg.includes('abort')) {
          ui.printLog('warn', 'repl', 'turn interrupted');
        } else {
          ui.printError(`repl error: ${msg}`);
        }
        turnDone = true;
      }

      // 处理 need_input：提问
      if (pendingQuestion && pendingQuestion.length > 0) {
        const answers: string[] = [];
        for (const q of pendingQuestion) {
          process.stdout.write(`  ${q.prompt}: `);
          let ans: string;
          if (q.sensitive) {
            ans = await passwordMode();
          } else {
            ans = await askLine();
          }
          answers.push(`${q.field}=${ans}`);
        }
        // 把答案作为 user 消息追加到 history
        history.push({ role: 'user', content: answers.join('\n') });
        // 重新启动新一轮
        continueRun = true;
        trimmed = answers.join('\n');
        pendingQuestion = null;
        continue;
      }

      // 处理 options_menu
      if (pendingOptions) {
        if (pendingOptions.options.length === 0) {
          const cfg = getConfig().agent.optionsMenu;
          for (const ds of cfg.dataSources ?? []) {
            const opts = loadMemoryDataSource(ds);
            if (opts && opts.length > 0) {
              pendingOptions.options = opts;
              pendingOptions.prompt = `${pendingOptions.prompt} (${opts.length} known)`;
              break;
            }
          }
        }

        // 重新打印选项（第一次打印已被 agentRun 期间的输出擦掉）
        ui.printOptionsMenu(pendingOptions.prompt, pendingOptions.options);
        process.stdout.write(ui.prompt());
        const ans = await askLine();
        const idx = Number(ans) - 1;
        if (Number.isNaN(idx) || idx < 0 || idx >= pendingOptions.options.length) {
          ui.printError(`invalid choice: ${ans}; stopping`);
          throw new InvalidOptionError(ans, ans);
        }
        const picked = pendingOptions.options[idx];
        history.push({
          role: 'user',
          content: `selected: ${pendingOptions.field}=${picked.value}`,
        });
        continueRun = true;
        trimmed = `selected: ${pendingOptions.field}=${picked.value}`;
        pendingOptions = null;
        continue;
      }

      if (turnDone) break;
    }

    // 恢复光标 + 重画 prompt
    process.stdout.write(ui.ansi.restoreCursor);
    rl.prompt(true);
  }

  // 退出：保存 lastSessionId + 关闭工具
  await gracefulShutdown('eof', sessionId);
}

/**
 * Phase 5: 优雅退出统一入口
 *  - 打印活跃连接（让用户知道哪些 SSH 连接会被释放）
 *  - 保存 lastSessionId（与 SIGINT 退出路径保持一致）
 *  - 关闭工具（释放 SshProvider 等句柄）
 *  - 退出码：sigint → 130（128+2），其他 → 0
 */
async function gracefulShutdown(reason: 'sigint' | 'eof', sid: string | undefined): Promise<void> {
  // 打印活跃连接
  try {
    const { getSshProvider } = await import('../ssh/provider.js');
    const conns = getSshProvider().listConnections();
    if (conns.length > 0) {
      process.stdout.write(`\n${c.dim('  active connections at exit:')}\n`);
      for (const conn of conns) {
        process.stdout.write(
          `    ${c.cyan('•')} ${conn.host}:${conn.port} ${c.dim(`(${conn.username})`)}\n`
        );
      }
    }
  } catch {
    // SshProvider 未初始化等场景——忽略
  }

  // 保存 lastSessionId
  if (sid) {
    try {
      writeFileSync(LAST_SESSION_FILE, sid, 'utf-8');
      ui.printLog('info', 'repl', `saved last session: ${sid}`);
    } catch (err) {
      log.warn({ err: String(err) }, 'failed to write last-session-id');
    }
  }
  try {
    await shutdownTools();
  } catch (err) {
    log.warn({ err: String(err) }, 'shutdown tools error');
  }
  process.stdout.write(`\nbye (${reason})\n`);
  process.exit(reason === 'sigint' ? 130 : 0);
}

function readLastSessionId(): string | null {
  try {
    if (!existsSync(LAST_SESSION_FILE)) return null;
    return readFileSync(LAST_SESSION_FILE, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function printBanner(): Promise<void> {
  const cfg = getConfig();
  // 注册的 tool 数量
  let toolCount = 0;
  let toolsLocal = 0;
  let toolsSsh = 0;
  try {
    // dynamic import 避免循环
    const { listRegisteredTools } = require('../tools/bootstrap.js') as typeof import('../tools/bootstrap.js');
    const tools = listRegisteredTools();
    toolCount = tools.length;
    for (const t of tools) {
      if (t.name.startsWith('ssh_') || t.name.startsWith('sftp_')) toolsSsh++;
      else if (t.name.startsWith('local_')) toolsLocal++;
    }
  } catch {
    // ignore
  }
  const provider = cfg.providers.active;
  const model = cfg.providers.providers[provider]?.model ?? '?';
  const llmInfo = `${provider} · ${model} · ${cfg.providers.streaming ? 'streaming' : 'blocking'}`;
  ui.banner({
    version: '0.1.0',
    profile: cfg.env.profile,
    llmInfo,
    toolCount,
    toolsLocal,
    toolsSsh,
  });

  // Phase 4: 显示当前活跃 SSH 连接，让用户一眼看到 SshProvider 持有的连接
  try {
    const { getSshProvider } = await import('../ssh/provider.js');
    const conns = getSshProvider().listConnections();
    if (conns.length > 0) {
      process.stdout.write(`\n${c.dim('  active connections:')}\n`);
      for (const conn of conns) {
        const age = Math.round((Date.now() - new Date(conn.lastUsedAt).getTime()) / 1000);
        const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}min ago`;
        process.stdout.write(
          `    ${c.cyan('•')} ${conn.host}:${conn.port} ${c.dim(`(${conn.username}, ${ageStr})`)}\n`
        );
      }
    } else {
      process.stdout.write(`\n${c.dim('  active connections: (none)')}\n`);
    }
  } catch {
    // SshProvider 还没初始化或失败——忽略
  }
}
