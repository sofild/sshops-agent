/**
 * 权限执行器
 *
 * - 对工具调用参数中的 shell 命令进行 token 级匹配
 * - 主机白名单（若 args 含 host 字段）
 */
import type { Policy } from './models.js';
import { buildDefaultPolicy, matchAnyPattern } from './models.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'permissions' });

export type Decision = 'allow' | 'deny' | 'confirm';

export interface PermissionDecision {
  decision: Decision;
  reason: string;
  matchedRule?: string;
  /** 是否需要 user 二次确认（仅 decision === 'confirm' 时为 true） */
  requiresUserConfirm?: boolean;
  /** 缺失的字段名（仅当 decision === 'confirm' 且因必填字段缺失时填充） */
  missingFields?: string[];
}

let cachedPolicy: Policy | null = null;
function getPolicy(): Policy {
  if (cachedPolicy) return cachedPolicy;
  cachedPolicy = buildDefaultPolicy(getConfig().permissions);
  return cachedPolicy;
}

export function resetPolicyCache(): void {
  cachedPolicy = null;
}

/** 把 shell 命令切成 tokens（支持 `;`, `&&`, `||`, `|`, `$()` 等） */
export function tokenize(cmd: string): string[] {
  // 用 shell 关键字切分，然后按空白分词
  const split = cmd
    .replace(/(\|\||&&|\||;|\$\(|\)|\s+)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return split;
}

/** 检查某个 token/pattern 是否在命令中出现（substring 或 token） */
export function matchRule(cmd: string, rule: string): boolean {
  // rule 中可包含通配符 *，用 RegExp 转换
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  // 边界字符：空白、shell 操作符、引号、或字符串首尾
  // 用 lookahead 风格的边界，避免匹配失败
  const leftBoundary = '(^|[\\s;|&><`\'"()$])';
  const rightBoundary = '(?=$|[\\s;|&><`\'"()])';
  const re = new RegExp(`${leftBoundary}${escaped}${rightBoundary}`);
  return re.test(cmd);
}

/** 主机是否在白名单内（支持精确匹配与简单 CIDR） */
export function hostAllowed(host: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return true;
  for (const w of whitelist) {
    if (w === host) return true;
    if (w.includes('/')) {
      if (cidrMatch(host, w)) return true;
    }
    if (w.includes('*')) {
      const re = new RegExp('^' + w.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (re.test(host)) return true;
    }
  }
  return false;
}

function cidrMatch(host: string, cidr: string): boolean {
  const [ip, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - Number(bits)) - 1) >>> 0;
  if (!ipToInt(ip) || !ipToInt(host)) return false;
  return (ipToInt(ip)! & mask) === (ipToInt(host)! & mask);
}

function ipToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
}

export function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown>
): PermissionDecision {
  const policy = getPolicy();

  // 1) 主机白名单
  const host = (args.host ?? args.hostname) as string | undefined;
  if (host && !hostAllowed(host, policy.hostWhitelist)) {
    return {
      decision: 'deny',
      reason: `host ${host} not in whitelist`,
      matchedRule: 'hostWhitelist',
    };
  }

  // 2) 必填字段检查（反幻觉前置：阻止缺关键参数的工具调用）
  const missing = evaluateRequiredFields(toolName, args, policy);
  if (missing.length > 0) {
    return {
      decision: 'confirm',
      reason: `missing required field(s): ${missing.join(', ')}`,
      matchedRule: 'requiredFields',
      requiresUserConfirm: true,
      missingFields: missing,
    };
  }

  // 3) 仅对包含命令字段的工具做命令级匹配
  const cmd = pickCommandField(args);
  if (!cmd) {
    return { decision: 'allow', reason: 'no command field to check' };
  }

  // 4) allow 优先
  for (const rule of policy.allow) {
    if (matchRule(cmd, rule)) {
      return {
        decision: 'allow',
        reason: `matched allow rule: ${rule}`,
        matchedRule: rule,
      };
    }
  }

  // 5) deny
  for (const rule of policy.deny) {
    if (matchRule(cmd, rule)) {
      return {
        decision: 'deny',
        reason: `matched deny rule: ${rule}`,
        matchedRule: rule,
      };
    }
  }

  // 6) confirm
  for (const rule of policy.confirm) {
    if (matchRule(cmd, rule)) {
      return {
        decision: 'confirm',
        reason: `matched confirm rule: ${rule}`,
        matchedRule: rule,
        requiresUserConfirm: true,
      };
    }
  }

  return { decision: 'allow', reason: 'no rule matched' };
}

/**
 * 必填字段检查。
 * - field 形如 'host'：args[field] 必须是非空字符串
 * - field 形如 'a|b|c'：args[a] / args[b] / args[c] 至少一个必须是非空字符串（OR 语义）
 * 返回缺失的"逻辑字段名"列表。
 */
export function evaluateRequiredFields(
  toolName: string,
  args: Record<string, unknown>,
  policy: Policy
): string[] {
  const patterns = Object.keys(policy.requiredFields);
  const matchedPattern = matchAnyPattern(toolName, patterns);
  if (!matchedPattern) return [];
  const requirements = policy.requiredFields[matchedPattern] ?? [];
  const missing: string[] = [];
  for (const req of requirements) {
    if (req.includes('|')) {
      // OR 语义：任一非空即满足
      const any = req.split('|').some((f) => hasNonEmpty(args, f));
      if (!any) missing.push(req);
    } else {
      if (!hasNonEmpty(args, req)) missing.push(req);
    }
  }
  return missing;
}

function hasNonEmpty(args: Record<string, unknown>, field: string): boolean {
  const v = args[field];
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.length > 0;
  return v != null;
}

function pickCommandField(args: Record<string, unknown>): string | null {
  for (const k of ['command', 'cmd', 'shell_cmd', 'script']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

/** 调试用：暴露 tokenize 和 matchRule */
export const _debug = { tokenize, matchRule, evaluateToolCall };
