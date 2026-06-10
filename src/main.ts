/**
 * sshops-agent 入口
 *
 * 启动 Agent 主循环或 CLI 子命令
 */
import { main } from './cli/root.js';

main().catch((err) => {
  // 兜底：未捕获错误
  // eslint-disable-next-line no-console
  console.error('[fatal]', err);
  process.exit(1);
});
