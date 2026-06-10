/**
 * 结构化日志（基于 pino）
 *
 * - dev 模式：pino-pretty → stderr
 * - prod 模式：原始 JSON → stderr
 * - REPL 模式：日志走 ui.printLog()，让日志和 agent 输出视觉分离
 *
 * **重要**：日志默认写到 stderr 而非 stdout，因为：
 *  - 在 stdio 子进程模式下（vault daemon），stdout 是协议通道（JSON-RPC），
 *    任何日志行都会污染协议
 *  - 即便父进程不用 stdio，stderr 是 Unix 惯例：诊断信息走 stderr，正常输出走 stdout
 *
 * REPL 模式开关：
 *  - setReplMode(true) → 后续 getLogger() 返回走 ui.printLog 的 wrapper
 *  - 进程启动时若 SSHOPS_REPL=1，自动开启
 */
import pino, { type Logger, type LoggerOptions } from 'pino';
import { getConfig } from '../config/loader.js';

let rootLogger: Logger | null = null;
let replMode = process.env.SSHOPS_REPL === '1';

/** 切换 REPL 模式：true=日志走 ui.printLog，false=走默认 stderr */
export function setReplMode(enabled: boolean): void {
  replMode = enabled;
  if (enabled) {
    // 关闭旧的 rootLogger，让下次 getLogger() 重建
    rootLogger = null;
  }
}

export function isReplMode(): boolean {
  return replMode;
}

/**
 * REPL 模式下的 logger wrapper：所有日志都转给 ui.printLog
 */
function createReplLogger(cfg: ReturnType<typeof getConfig>): Logger {
  // 动态 import 避免循环依赖（cli/ui.ts 不应反向依赖 logging）
  // 使用 sync import 也会工作（ui.ts 不依赖 logging.ts）
  const { ui } = require('../cli/ui.js') as typeof import('../cli/ui.js');

  const baseComponent = 'sshops';

  // 通用代理：拦截 level + msg 调用
  const make = (component: string, level: string): Logger => {
    const minLevel = pino.levels.values[cfg.env.logLevel] ?? pino.levels.values.info;
    const thisLevelVal = pino.levels.values[level] ?? pino.levels.values.info;
    const enabled = thisLevelVal >= minLevel;
    const proxy: any = {
      level,
      silent: !enabled,
      _isLogger: true,
      _component: component,
    };
    // 通用 log 方法
    const logMethod = (msg: unknown, ...args: unknown[]) => {
      if (!enabled) return;
      const formatted = formatLogMessage(msg, args);
      ui.printLog(level, component, formatted);
    };
    proxy.trace = logMethod;
    proxy.debug = logMethod;
    proxy.info = logMethod;
    proxy.warn = logMethod;
    proxy.error = logMethod;
    proxy.fatal = logMethod;
    proxy.child = (bindings: Record<string, unknown>) => {
      const childComp = bindings.component ? String(bindings.component) : component;
      return make(childComp, level);
    };
    return proxy as Logger;
  };

  return make(baseComponent, 'info');
}

function formatLogMessage(msg: unknown, args: unknown[]): string {
  if (typeof msg === 'string') {
    if (args.length === 0) return msg;
    // pino 风格：第一个 string 含 %s/%d/%o 等占位符
    return msg.replace(/%[sdjoO]/g, () => {
      const a = args.shift();
      if (a == null) return '';
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }) + (args.length > 0 ? ' ' + args.map(stringifyArg).join(' ') : '');
  }
  // msg 是 object：用 pino 风格 binding
  return stringifyArg(msg) + (args.length > 0 ? ' ' + args.map(stringifyArg).join(' ') : '');
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function getLogger(): Logger {
  if (rootLogger) return rootLogger;
  const cfg = getConfig();

  if (replMode) {
    rootLogger = createReplLogger(cfg);
    return rootLogger;
  }

  const isDev = cfg.env.profile === 'dev';
  const options: LoggerOptions = {
    level: cfg.env.logLevel,
    base: {
      app: 'sshops-agent',
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  // 显式写到 stderr（process.stderr），避免与 stdout 协议冲突
  if (isDev) {
    rootLogger = pino(
      options,
      pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,app',
          destination: 2, // stderr fd
        },
      })
    );
  } else {
    // 用 pino.destination 显式指定 fd 2（stderr）
    rootLogger = pino(options, pino.destination(2));
  }
  return rootLogger;
}

/**
 * 为 vault daemon 等需要"日志绝对不能写 stdout"的子进程，强制日志全走 stderr。
 * 不论 dev/prod 模式。
 */
export function getStderrOnlyLogger(component: string): Logger {
  const cfg = getConfig();
  const options: LoggerOptions = {
    level: cfg.env.logLevel,
    base: {
      app: 'sshops-agent',
      component,
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return pino(options, pino.destination(2));
}

/** 创建一个带上下文的子 logger */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}
