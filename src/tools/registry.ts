/**
 * 工具注册表
 *
 * - register / get / list / validateArgs
 * - 命名空间：`mcp:<server>:<tool>` 或 `local:<name>`
 */
import type { Tool, ToolResult, ToolContext } from './types.js';
import { ToolNotFoundError, ToolExecutionError } from '../utils/errors.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'tools.registry' });

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      log.warn({ tool: tool.name }, 'overwriting existing tool');
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new ToolNotFoundError(name);
    return t;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  validateArgs(tool: Tool, args: Record<string, unknown>): void {
    if (tool.zodSchema) {
      const r = tool.zodSchema.safeParse(args);
      if (!r.success) {
        throw new Error(
          `invalid args for ${tool.name}: ${r.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`
        );
      }
    }
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const tool = this.get(name);
    try {
      this.validateArgs(tool, args);
      const result = await tool.execute(args, ctx);
      return result;
    } catch (err) {
      if (err instanceof ToolNotFoundError) throw err;
      if (err instanceof Error && err.message.startsWith('invalid args')) throw err;
      throw new ToolExecutionError(name, err);
    }
  }

  clear(): void {
    this.tools.clear();
  }
}

let registryInstance: ToolRegistry | null = null;
export function getToolRegistry(): ToolRegistry {
  if (!registryInstance) registryInstance = new ToolRegistry();
  return registryInstance;
}
