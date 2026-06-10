/**
 * 集中 CLI UI 渲染
 *
 * - 启动 banner、彩色 prompt、box、spinner、log
 * - 检测 process.stdout.isTTY，非 TTY 退化纯文本
 * - 所有 print 走 process.stdout.write（不走 console.log，避免与 readline 冲突）
 *
 * 设计参考 Claude Code / aider / crush 终端 UX：
 *  - 日志（pino 拦截）→ 灰色 + 时间戳
 *  - agent 文本 → 左竖线 ▌ + cyan
 *  - tool_call → 蓝色 [tool] + 参数截断
 *  - tool_result → 绿/红方块 + 第一行
 *  - need_input → 黄底 box + 编号
 *  - final → 绿底 box
 *  - error → 红底 + ✗
 */
import chalk, { Chalk, type ChalkInstance } from 'chalk';

const isTTY = Boolean(process.stdout.isTTY);
const supportsColor = isTTY && (process.env.TERM !== 'dumb') && !process.env.NO_COLOR;

// 退化的无颜色版本（chalk v5：构造函数是 named export `Chalk`）
const c: ChalkInstance = supportsColor ? chalk : new Chalk({ level: 0 });

// 流状态：标记当前是否处于 agent 文本流中
let _agentTextStreamActive = false;

// ---------- box helpers ----------
function box(title: string | null, body: string[], opts: { color?: 'cyan' | 'yellow' | 'red' | 'green' | 'magenta' } = {}): string {
  const width = Math.max(60, ...body.map((l) => stripAnsi(l).length), title ? stripAnsi(title).length + 4 : 0);
  const top = '┌' + '─'.repeat(width) + '┐';
  const bottom = '└' + '─'.repeat(width) + '┘';
  const titleLine = title
    ? '│ ' + c[opts.color ?? 'cyan'](title) + ' '.repeat(width - stripAnsi(title).length - 1) + '│'
    : null;
  const bodyLines = body.map((line) => {
    const visible = stripAnsi(line).length;
    const pad = Math.max(0, width - visible - 1);
    return '│ ' + line + ' '.repeat(pad) + '│';
  });
  return [top, titleLine, ...bodyLines, bottom].filter(Boolean).join('\n');
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

// ---------- 公共 API ----------
export const ui = {
  isTTY,
  supportsColor,

  /** 启动 banner */
  banner(opts: {
    version: string;
    profile: 'dev' | 'prod';
    llmInfo: string;
    toolCount: number;
    toolsLocal: number;
    toolsSsh: number;
  }): void {
    const lines: string[] = [];
    lines.push(c.bold('  sshops-agent ') + c.dim(`v${opts.version}`));
    lines.push(c.dim('  智能化的服务器运维 Agent'));
    lines.push('');
    lines.push(`  ${c.dim('profile:')}  ${opts.profile === 'dev' ? c.yellow(opts.profile) : c.cyan(opts.profile)}`);
    lines.push(`  ${c.dim('llm:    ')}  ${c.cyan(opts.llmInfo)}`);
    lines.push(`  ${c.dim('tools:  ')}  ${opts.toolCount} (${opts.toolsLocal} local, ${opts.toolsSsh} ssh)`);
    process.stdout.write(lines.map((l) => '  ' + l).join('\n') + '\n\n');
  },

  /** 彩色 prompt：纯 ASCII 短串，避免 Windows Conhost / readline 字符宽度错位
   *  - 单一 chalk 调用包装整段文本，避免 readline 把多段 ANSI reset 序列
   *    算入行宽导致 prompt 绘制异常
   */
  prompt(): string {
    if (!isTTY) return '> ';
    return c.cyan('> ');
  },

  /** agent 流式文本：维护流状态，每个 turn 只画一次 │ 前缀
   *  - LLM 流式输出时按 chunk 调用 printAgentText；不维护流状态会导致
   *    每段都加 │ 前缀，输出成 `│ 好的│ ，│ 我先│ 尝试` 满屏竖线
   */
  printAgentText(text: string): void {
    if (!text) return;
    if (!isTTY) {
      process.stdout.write(text);
      return;
    }
    // 第一次进入流：画粗体 cyan 前缀
    if (!_agentTextStreamActive) {
      _agentTextStreamActive = true;
      process.stdout.write(c.bold(c.cyan('│ ')));
    }
    // 文本含 \n 时：换行后下一行也要补前缀
    let out = text;
    if (out.includes('\n')) {
      // 在每个 \n 后面补前缀（首行已画过）
      const prefix = c.bold(c.cyan('│ '));
      out = out.replace(/\n/g, '\n' + prefix);
    }
    process.stdout.write(out);
  },

  /** 显式结束 agent 文本流：用于 turn 边界（final / session_end / tool_call） */
  endAgentText(): void {
    if (_agentTextStreamActive) {
      _agentTextStreamActive = false;
      process.stdout.write('\n');
    }
  },

  /** tool_call 单行 — 用 box 边框视觉分离 */
  printToolCall(name: string, args: unknown): void {
    const argStr = truncate(JSON.stringify(args ?? {}), 160);
    const tag = c.bgBlue.white(' tool ');
    const out = `\n${c.blue('┌─')} ${tag} ${c.bold(c.blue(name))} ${c.dim(argStr)}\n`;
    process.stdout.write(out);
  },

  /** tool_result 单行 — 用 └─ 边框闭合 tool_call box */
  printToolResult(ok: boolean, content: string, durationMs?: number): void {
    const tag = ok
      ? c.bgGreen.black(' ok  ')
      : c.bgRed.white(' err  ');
    const dur = durationMs != null ? c.dim(`(${durationMs}ms)`) : '';
    const firstLine = content.split('\n')[0] ?? '';
    const out = `${c.blue('└─')} ${tag} ${truncate(firstLine, 200)} ${dur}\n`;
    process.stdout.write(out);
  },

  /** turn 分隔线 — dim 灰，视觉上分清每轮对话 */
  printTurnSeparator(): void {
    if (!isTTY) return;
    process.stdout.write(c.dim('  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─\n\n'));
  },

  /** thinking 提示 — 短暂显示，由 spinner.start 复用 */
  printThinking(): void {
    if (!isTTY) return;
    process.stdout.write(c.dim('  · 思考中...\n'));
  },

  /** need_input：提示用户回答 */
  printNeedInput(questions: Array<{ field: string; prompt: string; sensitive?: boolean }>): void {
    process.stdout.write('\n' + c.yellow('┌─ need input ─') + '\n');
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const sensMark = q.sensitive ? c.dim(' (sensitive)') : '';
      process.stdout.write(`${c.yellow('│')} ${c.bold(`${i + 1}.`)} ${q.prompt}${sensMark}\n`);
    }
    process.stdout.write(c.yellow('└─') + '\n');
  },

  /** options_menu：编号选项 */
  printOptionsMenu(prompt: string, options: Array<{ label: string; description?: string; value: string }>): void {
    process.stdout.write('\n' + c.yellow(`? ${prompt}`) + '\n');
    options.forEach((o, i) => {
      const num = c.bold(`${i + 1}.`);
      const desc = o.description ? c.dim(` — ${o.description}`) : '';
      process.stdout.write(`  ${num} ${o.label}${desc}\n`);
    });
  },

  /** 上下文压缩 */
  printCompression(level: string): void {
    process.stdout.write('\n' + c.magenta(`─ compression (level=${level}) `) + c.magenta('─'.repeat(20)) + '\n');
  },

  /** 错误 */
  printError(msg: string): void {
    process.stdout.write(`\n${c.bgRed.white(' ✗ ')} ${c.red(msg)}\n`);
  },

  /** 最终答案 */
  printFinal(answer: string): void {
    process.stdout.write('\n' + box('answer', [answer], { color: 'green' }) + '\n\n');
  },

  /** 拦截 pino 日志用
   *  - 走 stderr 而不是 stdout：避免与 readline（监听 stdout）抢通道，
   *    导致 readline 把日志当成用户输入的一部分而错位
   *  - 加日志级别标签 [log] / [warn] / [err] 让 stderr 上的日志与 stdout 的
   *    agent 文本 │ 视觉上能一眼区分
   */
  printLog(level: string, component: string, message: string): void {
    const colorByLevel: Record<string, typeof c.gray> = {
      trace: c.gray,
      debug: c.gray,
      info: c.cyan,
      warn: c.yellow,
      error: c.red,
      fatal: c.bgRed.white,
    };
    const tagByLevel: Record<string, string> = {
      trace: '[trace]',
      debug: '[debug]',
      info: '[log]  ',
      warn: '[warn] ',
      error: '[err]  ',
      fatal: '[FATAL]',
    };
    const col = colorByLevel[level] ?? c.gray;
    const tag = tagByLevel[level] ?? '[log]  ';
    const ts = c.dim(new Date().toISOString().slice(11, 19));
    const comp = c.dim(component);
    process.stderr.write(`${ts} ${c.dim(tag)} ${comp} ${col(message)}\n`);
  },

  /** 进度反馈 spinner */
  spinner: (() => {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let handle: NodeJS.Timeout | null = null;
    let i = 0;
    let currentMsg = '';

    function start(msg: string): void {
      if (!isTTY) {
        // 非 TTY 简单一行
        process.stdout.write(c.dim(`  · ${msg}...\n`));
        return;
      }
      if (handle) stop();
      currentMsg = msg;
      handle = setInterval(() => {
        const frame = frames[i++ % frames.length];
        process.stdout.write(`\r${c.cyan(frame)} ${currentMsg}`);
      }, 80);
    }

    function stop(finalMsg?: string): void {
      if (handle) {
        clearInterval(handle);
        handle = null;
        // 关键：clear 后加 \n 换行，避免后续 stdout 输出跟 spinner 同行
        process.stdout.write('\r' + ' '.repeat((currentMsg.length || 0) + 4) + '\r\n');
        if (finalMsg) process.stdout.write(c.dim(`  · ${finalMsg}\n`));
      } else if (finalMsg) {
        process.stdout.write(c.dim(`  · ${finalMsg}\n`));
      }
    }

    return { start, stop, isRunning: () => handle !== null };
  })(),

  /** 一些常用的 ANSI 控制码（供 readline 状态管理用） */
  ansi: {
    saveCursor: '\x1b7',
    restoreCursor: '\x1b8',
    eraseLine: '\x1b[2K',
    cursorLeft: '\r',
  },
};
