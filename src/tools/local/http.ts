/**
 * 本地辅助工具：fetch_url（GET，带超时）
 */
import { z } from 'zod';
import { request } from 'undici';
import type { Tool } from '../types.js';

const Schema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60000).default(10000),
  maxBytes: z.number().int().positive().max(5 * 1024 * 1024).default(1024 * 1024),
});

export const fetchUrlTool: Tool = {
  name: 'local_fetch_url',
  description: 'HTTP GET 一个 URL。返回文本内容。带超时与大小限制。',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整的 https/http URL' },
      timeoutMs: { type: 'number' },
      maxBytes: { type: 'number' },
    },
    required: ['url'],
  },
  zodSchema: Schema,
  async execute(args) {
    const { url, timeoutMs, maxBytes } = Schema.parse(args);
    const res = await request(url, { method: 'GET', headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    if (res.statusCode >= 400) {
      return {
        content: `error: HTTP ${res.statusCode}`,
        isError: true,
        data: { status: res.statusCode },
      };
    }
    const buf = Buffer.from(await res.body.arrayBuffer());
    const truncated = buf.length > maxBytes;
    const text = truncated
      ? buf.slice(0, maxBytes).toString('utf-8') + '\n...[truncated]'
      : buf.toString('utf-8');
    return {
      content: text,
      data: {
        status: res.statusCode,
        headers: res.headers,
        bytes: buf.length,
        truncated,
      },
    };
  },
};
