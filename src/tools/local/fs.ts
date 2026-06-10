/**
 * 本地辅助工具：read_local_file
 *
 * - 受工作目录限制（默认 cwd 之下）
 * - 不允许读取符号链接指向工作目录之外的文件
 */
import { z } from 'zod';
import { realpath, readFile } from 'node:fs/promises';
import { resolve, isAbsolute, relative } from 'node:path';
import type { Tool } from '../types.js';

const Schema = z.object({
  path: z.string().describe('相对工作目录的文件路径，或绝对路径（必须位于工作目录之下）'),
  maxBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1024 * 1024),
});

export const readLocalFileTool: Tool = {
  name: 'local_read_local_file',
  description:
    '读取本地文件。文件必须位于当前工作目录之内（防越权）。文件大小不能超过 maxBytes（默认 1MB）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      maxBytes: { type: 'number' },
    },
    required: ['path'],
  },
  zodSchema: Schema,
  async execute(args) {
    const { path: p, maxBytes } = Schema.parse(args);
    const workdir = process.cwd();
    const abs = isAbsolute(p) ? p : resolve(workdir, p);

    // 防越权：解析真实路径
    let realAbs: string;
    try {
      realAbs = await realpath(abs);
    } catch {
      return { content: `error: file not found: ${p}`, isError: true };
    }
    const rel = relative(workdir, realAbs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { content: `error: path is outside working directory: ${p}`, isError: true };
    }

    const content = await readFile(realAbs, 'utf-8');
    const truncated = content.length > maxBytes;
    const text = truncated ? content.slice(0, maxBytes) + '\n...[truncated]' : content;
    return {
      content: text,
      data: { path: realAbs, bytes: content.length, truncated },
    };
  },
};
