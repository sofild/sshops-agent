/**
 * 二次确认（CLI）
 *
 * - 交互模式：读 stdin
 * - 非交互（pipe/CI）：默认 deny
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function confirmAction(
  prompt: string,
  options: { nonInteractive?: boolean } = {}
): Promise<boolean> {
  const isTTY = stdin.isTTY === true;
  if (options.nonInteractive || !isTTY) {
    // 非交互模式默认拒绝
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function isInteractive(): boolean {
  return stdin.isTTY === true;
}
