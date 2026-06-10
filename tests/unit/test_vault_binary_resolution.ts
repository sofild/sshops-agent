/**
 * VaultClient binary 解析路径测试
 *
 * 验证：
 *  - binary 为空 → 走子命令模式，spawn `node <main.js> vault serve`
 *  - binary 有值且存在 → 走独立二进制模式
 *  - binary 有值但不存在 → fallback 到子命令模式（不抛错）
 *  - 不会把目录误当二进制（回归测试）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
let originalArgv1: string | undefined;
let originalArgv2: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sshops-vault-bin-'));
  originalArgv1 = process.argv[1];
  originalArgv2 = process.argv[2];
});

afterEach(() => {
  process.argv[1] = originalArgv1;
  process.argv[2] = originalArgv2;
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // ignore
  }
});

async function loadClientWithBinary(binary: string) {
  const configMod = await import('../../src/config/loader.js');
  vi.spyOn(configMod, 'getConfig').mockReturnValue({
    ...configMod.getConfig(),
    vault: { ...configMod.getConfig().vault, binary, autoStart: true },
  });
  const mod = await import('../../src/vault/client.js');
  return new mod.VaultClient();
}

describe('VaultClient resolveSpawnCommand (binary path resolution)', () => {
  it('falls back to subcommand mode when binary is empty', async () => {
    const mainPath = join(tmpDir, 'main.js');
    writeFileSync(mainPath, '// stub');
    process.argv[1] = mainPath;
    const client = await loadClientWithBinary('');
    const result = (client as unknown as {
      resolveSpawnCommand(b: string): { command: string; args: string[] };
    }).resolveSpawnCommand('');
    expect(result.command).toBe(process.execPath);
    expect(result.args[0]).toBe(mainPath);
    expect(result.args).toContain('vault');
    expect(result.args).toContain('serve');
  });

  it('uses standalone binary when configured and exists', async () => {
    const bin = join(tmpDir, 'my-vault');
    writeFileSync(bin, '#!/bin/sh\necho vault');
    const client = await loadClientWithBinary(bin);
    const result = (client as unknown as {
      resolveSpawnCommand(b: string): { command: string; args: string[] };
    }).resolveSpawnCommand(bin);
    expect(result.command).toBe(bin);
    expect(result.args).toEqual(['serve']);
  });

  it('falls back to subcommand when configured binary is missing', async () => {
    const mainPath = join(tmpDir, 'main.js');
    writeFileSync(mainPath, '// stub');
    process.argv[1] = mainPath;
    const missing = join(tmpDir, 'does-not-exist');
    const client = await loadClientWithBinary(missing);
    const result = (client as unknown as {
      resolveSpawnCommand(b: string): { command: string; args: string[] };
    }).resolveSpawnCommand(missing);
    // fallback 应走到 subcommand
    expect(result.command).toBe(process.execPath);
    expect(result.args[0]).toBe(mainPath);
    expect(result.args).toContain('vault');
  });

  it('does NOT return a directory as the binary (regression: dist/ ENOENT bug)', async () => {
    const dirAsBinary = join(tmpDir, 'looks-like-a-binary');
    mkdirSync(dirAsBinary, { recursive: true });
    expect(existsSync(dirAsBinary)).toBe(true);
    expect(statSync(dirAsBinary).isDirectory()).toBe(true);

    // 当传入空 binary 时，即使 dist 目录存在，也不应被选为可执行
    const mainPath = join(tmpDir, 'main.js');
    writeFileSync(mainPath, '// stub');
    process.argv[1] = mainPath;
    const client = await loadClientWithBinary('');
    const result = (client as unknown as {
      resolveSpawnCommand(b: string): { command: string; args: string[] };
    }).resolveSpawnCommand('');
    expect(result.command).not.toBe(dirAsBinary);
    // 应使用 process.execPath（node）作为 command
    expect(result.command).toBe(process.execPath);
    // 子命令应包含 vault 和 serve
    expect(result.args).toEqual([mainPath, 'vault', 'serve']);
  });

  it('uses node executable as command (not argv[1] itself)', async () => {
    const mainPath = join(tmpDir, 'main.js');
    writeFileSync(mainPath, '// stub');
    process.argv[1] = mainPath;
    const client = await loadClientWithBinary('');
    const result = (client as unknown as {
      resolveSpawnCommand(b: string): { command: string; args: string[] };
    }).resolveSpawnCommand('');
    // spawn 命令必须是 node (process.execPath)，而 main.js 是 argv[0]
    expect(result.command).toBe(process.execPath);
    expect(result.args[0]).toBe(mainPath);
  });
});
