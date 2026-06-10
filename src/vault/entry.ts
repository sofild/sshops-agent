/**
 * sshops-vault 进程入口（serve 子命令）
 *
 * 由 CLI 子命令 `sshops-agent vault serve` 显式调用：
 *   await startVaultDaemon();
 *
 * 不同于之前的 `vault.js` 自动启动逻辑（已被移除）：
 * - 单二进制分发场景下，vault 走 `sshops-agent vault serve` 子命令
 * - 独立运行场景下，vault 走 `node dist/vault/cli.js` 入口
 */
import { VaultDaemon } from './daemon.js';
import { getStderrOnlyLogger } from '../observability/logging.js';

// stderr-only：stdout 留给 JSON-RPC
const log = getStderrOnlyLogger('vault.entry');

export async function startVaultDaemon(): Promise<void> {
  const daemon = new VaultDaemon();
  await daemon.serve(process.stdin, process.stdout);
}

// 显式导出 startVaultDaemon 以便 CLI 注入（vault/cli.ts）
export default startVaultDaemon;

// 仅作模块副作用占位：避免在 esbuild/tsc 下被 tree-shake 掉
export const _entryMarker = 'vault-entry' as const;
