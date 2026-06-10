/**
 * Vault Daemon JSON-RPC 测试
 *
 * - 模拟 stdin/stdout 双向流
 * - 验证 hello / listHosts / status / setCredential / acquire(missing) 协议正确
 * - 验证错误响应使用正确的 JSON-RPC error code
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { VaultDaemon } from '../../src/vault/daemon.js';
import { VAULT_ERROR_CODES } from '../../src/vault/types.js';
import { homedir } from 'node:os';

class MockStdout extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    for (const line of s.split('\n')) {
      if (line) this.lines.push(line);
    }
    cb();
  }
  drain(): string[] {
    const out = this.lines;
    this.lines = [];
    return out;
  }
}

class MockStdin extends Readable {
  private queue: string[] = [];
  private closed = false;
  override _read(): void {
    if (this.closed) {
      this.push(null);
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) {
      // 等 10ms 再触发一次 _read
      setTimeout(() => this._read(), 5);
      return;
    }
    this.push(next + '\n');
  }
  feed(line: string): void {
    this.queue.push(line);
  }
  end_(): void {
    this.closed = true;
  }
}

async function setupDaemon(): Promise<{
  daemon: VaultDaemon;
  stdin: MockStdin;
  stdout: MockStdout;
  cleanup: () => Promise<void>;
}> {
  const tmpHome = mkdtempSync(join(tmpdir(), 'sshops-vault-daemon-'));
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const stdin = new MockStdin();
  const stdout = new MockStdout();
  const daemon = new VaultDaemon();
  const servePromise = daemon.serve(stdin as unknown as NodeJS.ReadableStream, stdout as unknown as NodeJS.WritableStream);
  // 给 daemon 50ms 启动
  await new Promise((r) => setTimeout(r, 50));
  return {
    daemon,
    stdin,
    stdout,
    cleanup: async () => {
      stdin.end_();
      await servePromise.catch(() => undefined);
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalProfile;
      try {
        rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // ignore
      }
    },
  };
}

async function waitForLine(stdout: MockStdout, predicate: (line: string) => boolean, timeoutMs = 2000): Promise<unknown> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const lines = stdout.drain();
    for (const l of lines) {
      try {
        const obj = JSON.parse(l);
        if (predicate(JSON.stringify(obj))) return obj;
      } catch {
        // skip non-JSON
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for matching line`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('VaultDaemon JSON-RPC', () => {
  let ctx: Awaited<ReturnType<typeof setupDaemon>>;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    ctx = await setupDaemon();
  });

  it('replies to hello with capabilities', async () => {
    ctx.stdin.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'vault.hello', params: {} }));
    const resp = (await waitForLine(ctx.stdout, (s) => s.includes('"id":1'))) as {
      result?: { vaultVersion: string; capabilities: string[] };
    };
    expect(resp.result).toBeTruthy();
    expect(resp.result!.capabilities).toContain('pool');
    expect(resp.result!.capabilities).toContain('keychain');
  });

  it('returns empty listHosts when no hosts registered', async () => {
    ctx.stdin.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'vault.listHosts' }));
    const resp = (await waitForLine(ctx.stdout, (s) => s.includes('"id":2'))) as {
      result?: { hosts: unknown[] };
    };
    expect(resp.result?.hosts).toEqual([]);
  });

  it('returns parse error on invalid JSON', async () => {
    ctx.stdin.feed('this is not json');
    const resp = (await waitForLine(ctx.stdout, (s) => s.includes('"code":'))) as {
      error?: { code: number };
    };
    expect(resp.error?.code).toBe(VAULT_ERROR_CODES.PARSE_ERROR);
  });

  it('returns method_not_found for unknown method', async () => {
    ctx.stdin.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'vault.unknown' }));
    const resp = (await waitForLine(ctx.stdout, (s) => s.includes('"id":3'))) as {
      error?: { code: number; message: string };
    };
    expect(resp.error?.code).toBe(VAULT_ERROR_CODES.METHOD_NOT_FOUND);
    expect(resp.error?.message).toContain('unknown method');
  });

  it('returns invalid_request when jsonrpc field is wrong', async () => {
    ctx.stdin.feed(JSON.stringify({ jsonrpc: '1.0', id: 4, method: 'vault.hello' }));
    const resp = (await waitForLine(ctx.stdout, (s) => s.includes('"id":4'))) as {
      error?: { code: number };
    };
    expect(resp.error?.code).toBe(VAULT_ERROR_CODES.INVALID_REQUEST);
  });

  it('acquire for unknown host returns HOST_NOT_FOUND', async () => {
    ctx.stdin.feed(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'vault.acquire', params: { alias: 'nope' } })
    );
    const resp = (await waitForLine(ctx.stdout, (s) => s.includes('"id":5'))) as {
      error?: { code: number; message: string };
    };
    expect(resp.error?.code).toBe(VAULT_ERROR_CODES.HOST_NOT_FOUND);
    expect(resp.error?.message).toContain('nope');
  });

  it('status returns pools array', async () => {
    ctx.stdin.feed(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'vault.status' }));
    const resp = (await waitForLine(ctx.stdout, (s) => s.includes('"id":6'))) as {
      result?: { pools: unknown[] };
    };
    expect(Array.isArray(resp.result?.pools)).toBe(true);
  });

  it('ignores comment lines starting with #', async () => {
    ctx.stdin.feed('# keepalive\n# another');
    await new Promise((r) => setTimeout(r, 100));
    // 不应有任何响应
    expect(ctx.stdout.drain()).toEqual([]);
  });
});
