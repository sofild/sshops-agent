/**
 * 本地辅助工具：get_datetime
 */
import { z } from 'zod';
import type { Tool } from '../types.js';

const Schema = z.object({
  timezone: z.string().optional(),
  format: z.enum(['iso', 'unix', 'human']).default('iso'),
});

export const getDatetimeTool: Tool = {
  name: 'local_get_datetime',
  description: '获取当前日期时间。可指定时区（IANA name，如 Asia/Shanghai）与格式（iso/unix/human）。',
  inputSchema: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA 时区名' },
      format: { type: 'string', enum: ['iso', 'unix', 'human'] },
    },
  },
  zodSchema: Schema,
  async execute(args) {
    const { timezone, format } = Schema.parse(args);
    const now = new Date();
    let text: string;
    if (format === 'unix') {
      text = String(now.getTime());
    } else if (format === 'human') {
      text = now.toLocaleString('zh-CN', timezone ? { timeZone: timezone } : undefined);
    } else {
      text = timezone
        ? now.toLocaleString('en-US', { timeZone: timezone, hour12: false })
        : now.toISOString();
    }
    return { content: text, data: { timezone, format, value: text } };
  },
};
