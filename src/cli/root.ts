#!/usr/bin/env node
/**
 * CLI 入口（commander）
 *
 * v2 升级（2026-05）：
 *  - one-shot 模式用 ui.ts 替代 console.log
 *  - 启动 banner
 *  - 切换 REPL/one-shot 模式的日志模式
 */
import { Command } from 'commander';
import { startMetricsServer, metrics } from '../observability/metrics.js';
import { getConfig } from '../config/loader.js';
import { bootstrapTools, shutdownTools, listRegisteredTools } from '../tools/bootstrap.js';
import { run as agentRun, loadHistory } from '../agent/core.js';
import { Session, listSessions } from '../session/wal.js';
import { runDoctor } from './doctor.js';
import { startRepl } from './repl.js';
import { registerVaultCli } from '../vault/cli.js';
import { setReplMode } from '../observability/logging.js';
import { ui } from './ui.js';
import * as memory from '../agent/memory.js';

const VERSION = '0.1.0';

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();
  program
    .name('sshops-agent')
    .description('智能化的线上服务器运维 Agent：使用自然语言一句话完成服务器环境搭建、应用部署、日常监控与运维')
    .version(VERSION)
    .option('-i, --interactive', '进入 REPL 模式')
    .option('-v, --verbose', '启用 debug 日志')
    .option('--log-level <level>', '设置日志级别', process.env.SSHOPS_LOG_LEVEL || 'info')
    .option('--metrics-port <port>', '启用 Prometheus 指标端口', (v) => Number(v), 0)
    .option('--no-audit', '禁用审计日志')
    .option('--resume <id>', '从指定 session 恢复')
    .option('--profile <name>', 'dev | prod', 'dev');
  // 注意：不要在这里用 .argument()。
  // commander 在定义了子命令后，第一个非选项参数必须匹配子命令，否则会抛 "unknown command" 并 exit(1)。
  // 自由形式的自然语言任务交给下面的 * 兜底子命令处理。

  program
    .command('config')
    .description('配置相关子命令')
    .addCommand(
      new Command('show')
        .description('显示当前生效配置（脱敏）')
        .action(async () => {
          await cmdShowConfig();
        })
    )
    .addCommand(
      new Command('validate')
        .description('校验配置合法性')
        .action(async () => {
          await cmdValidateConfig();
        })
    );

  program
    .command('session')
    .description('会话管理')
    .addCommand(
      new Command('list').description('列出历史会话').action(() => cmdSessionList())
    )
    .addCommand(
      new Command('show')
        .description('查看某次会话详情')
        .argument('<id>', 'session id')
        .action((id: string) => cmdSessionShow(id))
    );

  program
    .command('memory')
    .description('持久化记忆管理')
    .addCommand(
      new Command('list')
        .description('列出所有持久化记忆条目')
        .action(() => cmdMemoryList())
    )
    .addCommand(
      new Command('show')
        .description('查看指定记忆条目的内容 + 元信息（来源 / 过期 / 写入时间）')
        .argument('<key>', '记忆 key (例如 hosts / preferences / last-errors:server1)')
        .action((key: string) => cmdMemoryShow(key))
    )
    .addCommand(
      new Command('clear')
        .description('删除指定记忆条目（同时清掉 .meta.json）')
        .argument('<key>', '记忆 key')
        .action((key: string) => cmdMemoryClear(key))
    );

  program
    .command('doctor')
    .description('环境自检')
    .action(async () => {
      const code = await runDoctor();
      process.exit(code);
    });

  // 注册 vault 子命令（serve / init / set / list / ...）
  // agent spawn 的 vault daemon 走 `sshops-agent vault serve` 子命令
  registerVaultCli(program);

  // 兜底子命令：自由形式自然语言任务 / 交互模式 / 无参数
  // - `*` 是 commander 的通配子命令名，匹配任何未命中的第一个非选项参数
  // - `isDefault: true` 让它在不指定子命令时被自动执行
  // - `allowUnknownOption()` 允许出现 `--resume xxx` 等 program 级选项
  program
    .command('* [task...]', { isDefault: true })
    .allowUnknownOption()
    .description('自然语言运维任务（默认）')
    .action(async (task: string[]) => {
      const opts = program.opts();
      const taskStr = task.join(' ');

      // one-shot 模式：用 stderr 日志（不切 REPL 模式）
      setReplMode(false);

      // 初始化 metrics
      if (opts.metricsPort > 0) {
        await startMetricsServer(opts.metricsPort);
      }

      if (opts.interactive) {
        // REPL 模式：startRepl 自己 bootstrapTools + 切 REPL mode
        await startRepl(opts.resume);
        return;
      }

      // one-shot 模式：先 bootstrapTools
      try {
        await bootstrapTools();
      } catch (err) {
        ui.printError(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }

      // 启动关闭钩子
      const shutdown = async () => {
        await shutdownTools();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // one-shot banner
      const cfg = getConfig();
      printOneShotBanner(cfg, listRegisteredTools());

      if (taskStr) {
        await runOnce(taskStr, {
          resumeId: opts.resume,
          nonInteractive: !process.stdin.isTTY,
        });
      } else {
        program.help();
      }
    });

  // 解析
  program.parse(argv);
}

async function runOnce(task: string, options: { resumeId?: string; nonInteractive: boolean }): Promise<void> {
  let history;
  if (options.resumeId) {
    history = await loadHistory(options.resumeId);
  }
  // 启动 spinner 反馈
  ui.spinner.start('思考中...');
  for await (const ev of agentRun(task, { history, nonInteractive: options.nonInteractive })) {
    switch (ev.type) {
      case 'session_start':
        ui.printLog('info', 'agent', `session ${ev.sessionId} started`);
        break;
      case 'message_start':
        // noop
        break;
      case 'text':
        if (ui.spinner.isRunning()) ui.spinner.stop();
        ui.printAgentText(ev.text);
        break;
      case 'tool_call':
        if (ui.spinner.isRunning()) ui.spinner.stop();
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
      case 'compression':
        ui.printCompression(ev.level);
        break;
      case 'final':
        if (ui.spinner.isRunning()) ui.spinner.stop();
        ui.endAgentText();
        ui.printFinal(ev.answer);
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
        ui.printLog('info', 'agent', `session ended: ${ev.reason}`);
        break;
    }
  }
  if (ui.spinner.isRunning()) ui.spinner.stop();
}

async function cmdShowConfig(): Promise<void> {
  const cfg = getConfig();
  // 脱敏：apiKey 仅显示前 4 后 4
  const sanitize = (s: string) =>
    s.length > 8 ? `${s.slice(0, 4)}...${s.slice(-4)}` : '***';
  const out = {
    active_provider: cfg.providers.active,
    providers: {
      anthropic: cfg.providers.providers.anthropic
        ? { ...cfg.providers.providers.anthropic, apiKey: sanitize(cfg.providers.providers.anthropic.apiKey) }
        : null,
      openai: cfg.providers.providers.openai
        ? { ...cfg.providers.providers.openai, apiKey: sanitize(cfg.providers.providers.openai.apiKey) }
        : null,
    },
    agent: cfg.agent,
    permissions: { ...cfg.permissions, audit: { enabled: cfg.permissions.audit.enabled, path: cfg.permissions.audit.path, fsync: cfg.permissions.audit.fsync } },
    tools: { localTools: cfg.tools.localTools, mcpServers: Object.keys(cfg.tools.mcpServers) },
    env: cfg.env,
    registered_tools: listRegisteredTools().map((t) => t.name),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

async function cmdValidateConfig(): Promise<void> {
  const { loadAndValidate } = await import('../config/loader.js');
  const r = loadAndValidate();
  if (r.ok) {
    // eslint-disable-next-line no-console
    console.log('config OK');
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.error(`config invalid: ${r.error}`);
    process.exit(1);
  }
}

function cmdSessionList(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    // eslint-disable-next-line no-console
    console.log('(no sessions)');
    return;
  }
  for (const s of sessions) {
    // eslint-disable-next-line no-console
    console.log(`${s.id}\t${s.size}B\t${s.mtime.toISOString()}`);
  }
}

async function cmdSessionShow(id: string): Promise<void> {
  const session = Session.open(id);
  const events = session.load();
  for (const e of events) {
    const data = JSON.stringify(e.data);
    // eslint-disable-next-line no-console
    console.log(`[${e.ts}] ${e.type}: ${data.length > 200 ? data.slice(0, 200) + '...' : data}`);
  }
}

// ---- memory subcommands ----
function cmdMemoryList(): void {
  const items = memory.listMemory();
  if (items.length === 0) {
    // eslint-disable-next-line no-console
    console.log('(no memory entries)');
    return;
  }
  for (const k of items) {
    const v = memory.recall(k);
    const meta = memory.recallMeta(k);
    const setBy = meta?.setBy ?? 'unknown';
    const bytes = v ? v.length : 0;
    // eslint-disable-next-line no-console
    console.log(`${k}\t${bytes}B\tsetBy=${setBy}`);
  }
}

function cmdMemoryShow(key: string): void {
  const v = memory.recall(key);
  if (v === null) {
    // eslint-disable-next-line no-console
    console.error(`(no memory for key: ${key})`);
    process.exit(1);
  }
  const meta = memory.recallMeta(key);
  // eslint-disable-next-line no-console
  console.log(`--- memory:${key} ---`);
  if (meta) {
    // eslint-disable-next-line no-console
    console.log(`setBy:    ${meta.setBy}`);
    // eslint-disable-next-line no-console
    console.log(`setAt:    ${new Date(meta.setAt).toISOString()}`);
    if (meta.expiresAt) {
      // eslint-disable-next-line no-console
      console.log(`expires:  ${new Date(meta.expiresAt).toISOString()}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`expires:  never`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(`(no meta file — may have been manually edited)`);
  }
  // eslint-disable-next-line no-console
  console.log('--- content ---');
  // eslint-disable-next-line no-console
  console.log(v);
}

function cmdMemoryClear(key: string): void {
  const ok = memory.forget(key);
  if (!ok) {
    // eslint-disable-next-line no-console
    console.error(`(no memory for key: ${key})`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`cleared memory:${key}`);
}

function printOneShotBanner(cfg: ReturnType<typeof getConfig>, tools: ReturnType<typeof listRegisteredTools>): void {
  let toolsLocal = 0;
  let toolsSsh = 0;
  for (const t of tools) {
    if (t.name.startsWith('ssh_') || t.name.startsWith('sftp_')) toolsSsh++;
    else if (t.name.startsWith('local_')) toolsLocal++;
  }
  const provider = cfg.providers.active;
  const model = cfg.providers.providers[provider]?.model ?? '?';
  const llmInfo = `${provider} · ${model} · ${cfg.providers.streaming ? 'streaming' : 'blocking'}`;
  ui.banner({
    version: VERSION,
    profile: cfg.env.profile,
    llmInfo,
    toolCount: tools.length,
    toolsLocal,
    toolsSsh,
  });
}
