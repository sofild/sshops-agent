/**
 * 工具启动器：把自研 SSH provider 工具 + 本地工具注册到 ToolRegistry
 *
 * 设计变更 (2026-05)：
 *  - 移除 mcp-server-ssh 启动（被自研 SshProvider 取代，详见 src/ssh/）
 *  - mcpServers 段保留 key 兼容历史（enabled: false 时跳过启动）
 */
import { getToolRegistry } from './registry.js';
import { getSshProvider } from '../ssh/provider.js';
import { registerSshTools } from '../ssh/registry.js';
import { getDatetimeTool } from './local/datetime.js';
import { readLocalFileTool } from './local/fs.js';
import { fetchUrlTool } from './local/http.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'tools.bootstrap' });

let initialized = false;
let sshProviderHandle: ReturnType<typeof getSshProvider> | null = null;

export async function bootstrapTools(): Promise<void> {
  if (initialized) return;
  const cfg = getConfig();
  const registry = getToolRegistry();

  // 1) 本地工具
  const local = cfg.tools.localTools;
  if (local.includes('get_datetime')) registry.register(getDatetimeTool);
  if (local.includes('read_local_file')) registry.register(readLocalFileTool);
  if (local.includes('fetch_url')) registry.register(fetchUrlTool);

  // 2) 自研 SSH Provider 工具
  sshProviderHandle = getSshProvider(cfg.tools.sshProvider);
  registerSshTools(registry, sshProviderHandle);
  log.info('ssh tools registered via SshProvider');

  initialized = true;
}

export async function shutdownTools(): Promise<void> {
  if (sshProviderHandle) {
    try {
      await sshProviderHandle.closeAll();
    } catch (err) {
      log.warn({ err: String(err) }, 'error closing SshProvider');
    }
    sshProviderHandle = null;
  }
  getToolRegistry().clear();
  initialized = false;
}

export function listRegisteredTools() {
  return getToolRegistry().list();
}
