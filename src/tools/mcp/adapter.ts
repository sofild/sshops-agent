/**
 * MCP Tool Adapter
 *
 * - 把 MCP listTools 返回的工具包装为内部 Tool
 * - 注册到 ToolRegistry
 */
import type { Tool, ToolContext, ToolResult } from '../types.js';
import type { MCPClient, McpToolDescriptor } from './client.js';
import { getLogger } from '../../observability/logging.js';

const log = getLogger().child({ component: 'mcp.adapter' });

export function adaptMcpTools(
  client: MCPClient,
  descriptors: McpToolDescriptor[]
): Tool[] {
  return descriptors.map((d) => {
    // OpenAI 兼容 API 要求 function name 必须是 [a-zA-Z0-9_-] 且 ≤64 字符，
    // 因此把 ':' 替换为 '_'，并截断超长部分
    const rawNamespaced = `${client.serverName}:${d.name}`;
    const namespacedName = sanitizeToolName(rawNamespaced);
    const inputSchema: Tool['inputSchema'] = {
      type: 'object',
      properties: (d.inputSchema.properties ?? {}) as Record<string, unknown>,
      required: d.inputSchema.required,
    };
    return {
      name: namespacedName,
      description: d.description ?? `mcp tool from ${client.serverName}`,
      inputSchema,
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const start = Date.now();
        try {
          const result = await client.callTool(d.name, args);
          const isError = Boolean((result as { isError?: boolean })?.isError);
          return {
            content: stringifyResult(result),
            data: result,
            isError,
          };
        } catch (err) {
          log.error(
            { tool: namespacedName, err: String(err), ms: Date.now() - start },
            'mcp tool execution failed'
          );
          return {
            content: `error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    } satisfies Tool;
  });
}

/** 把任意字符串转换为 LLM function name 兼容的形式：仅 [a-zA-Z0-9_-]，最长 64 */
function sanitizeToolName(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (s.length > 64) {
    // 用 hash 截断
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    s = s.slice(0, 56) + '_' + (h >>> 0).toString(36);
  }
  return s;
}

function stringifyResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray((result as { content?: unknown }).content)) {
    const c = (result as { content: unknown[] }).content;
    return c
      .map((b) => {
        if (typeof b === 'string') return b;
        if (typeof b === 'object' && b && (b as { type?: string }).type === 'text') {
          return (b as { text: string }).text;
        }
        return JSON.stringify(b);
      })
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}
