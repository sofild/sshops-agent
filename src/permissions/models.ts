/**
 * 权限模型定义
 */
import { z } from 'zod';

export const PolicySchema = z.object({
  deny: z.array(z.string()).default([]),
  confirm: z.array(z.string()).default([]),
  allow: z.array(z.string()).default([]),
  hostWhitelist: z.array(z.string()).default([]),
  /**
   * 工具必填字段模式：toolName pattern → 必填字段名集合
   * 例如：{ 'ssh_*_connect': ['host','password|privateKey|privateKeyPath'] }
   */
  requiredFields: z
    .record(z.string(), z.array(z.string()))
    .default({}),
  /**
   * 哪些工具/场景允许触发 options menu（仅白名单中的工具可触发追问）
   */
  optionsMenuTools: z.array(z.string()).default([]),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().default('logs/audit.jsonl'),
      fsync: z.boolean().default(true),
    })
    .default({}),
});

export type Policy = z.infer<typeof PolicySchema>;

/** 默认的必填字段映射（基于 mcp-server-ssh 工具列表） */
export const DEFAULT_REQUIRED_FIELDS: Record<string, string[]> = {
  'ssh_*_connect': ['host', 'password|privateKey|privateKeyPath'],
  'ssh_*_execute': ['host', 'command'],
  'ssh_*_upload': ['host', 'localPath', 'remotePath'],
  'ssh_*_download': ['host', 'remotePath', 'localPath'],
};

/** 默认允许触发 options menu 的工具 */
export const DEFAULT_OPTIONS_MENU_TOOLS = [
  'ssh_*_connect',
  'ssh_*_system_info',
  'ssh_*_list_files',
];

export const DEFAULT_DENY = [
  'rm -rf /',
  'rm -rf /*',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
  'mkfs',
  'dd if=',
  'fdisk',
  'format',
  ':(){ :|:& };:',
  '>/dev/sda',
  'chmod -R 777 /',
];

export const DEFAULT_CONFIRM = [
  'rm -rf',
  'rm -fr',
  'chmod -R',
  'chown -R',
  'iptables -F',
  'userdel',
  'kill -9 1',
  'systemctl stop',
  'systemctl disable',
  'service * stop',
  'DROP TABLE',
  'TRUNCATE',
  'DELETE FROM',
  'kubectl delete namespace',
  'docker system prune',
];

/** 合并默认与用户配置（用户在前，匹配时优先） */
export function buildDefaultPolicy(user?: Partial<Policy>): Policy {
  return PolicySchema.parse({
    deny: [...(user?.deny ?? []), ...DEFAULT_DENY],
    confirm: [...(user?.confirm ?? []), ...DEFAULT_CONFIRM],
    allow: user?.allow ?? [],
    hostWhitelist: user?.hostWhitelist ?? [],
    requiredFields: {
      ...DEFAULT_REQUIRED_FIELDS,
      ...(user?.requiredFields ?? {}),
    },
    optionsMenuTools: [
      ...(user?.optionsMenuTools ?? []),
      ...DEFAULT_OPTIONS_MENU_TOOLS,
    ],
    audit: user?.audit ?? {},
  });
}

/** 把 glob 模式 ('ssh_*_connect') 编译为正则 */
export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/** 检查 toolName 是否命中 pattern 列表中的任一项 */
export function matchAnyPattern(name: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (patternToRegex(p).test(name)) return p;
  }
  return null;
}
