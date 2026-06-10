/**
 * Memory 单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('memory', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sshops-mem-'));
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, 'package.json'), '{}');
  });

  it('remembers and recalls keys', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '10.222.10.21 | root@web-01\n10.222.10.22 | root@db-01');
    const r = mem.recall('hosts');
    expect(r).toContain('10.222.10.21');
  });

  it('returns null for non-existent keys', async () => {
    const mem = await import('../../src/agent/memory.js');
    expect(mem.recall('nope')).toBeNull();
  });

  it('respects TTL (lazy expiration)', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('last-errors:server1', 'crash', 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 50));
    expect(mem.recall('last-errors:server1')).toBeNull();
  });

  it('parses hosts.md as MenuOption[]', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '# comment\n10.222.10.21 | root@web-01 | nginx\n10.222.10.22 | root@db-01 | postgres');
    const opts = mem.loadHostsAsOptions();
    expect(opts.length).toBe(2);
    expect(opts[0].value).toBe('10.222.10.21');
    expect(opts[0].label).toBe('root@web-01');
    expect(opts[0].description).toContain('nginx');
  });

  it('loadMemoryDataSource returns null for unknown spec', async () => {
    const mem = await import('../../src/agent/memory.js');
    expect(mem.loadMemoryDataSource('not-a-spec')).toBeNull();
  });

  it('allMemoryAsContext renders all keys as section', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '10.222.10.21');
    mem.remember('preferences', 'always use bash');
    const out = mem.allMemoryAsContext();
    expect(out).toContain('hosts');
    expect(out).toContain('preferences');
    expect(out).toContain('10.222.10.21');
  });

  it('remember writes setBy meta and recallMeta returns it', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '10.222.10.21 | root@web-01', undefined, 'user');
    const meta = mem.recallMeta('hosts');
    expect(meta).not.toBeNull();
    expect(meta?.setBy).toBe('user');
    expect(meta?.setAt).toBeGreaterThan(0);
  });

  it('loadHostsAsOptions filters orphan lines by default', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '10.222.10.21\n10.222.10.22 | root@db-01 | postgres');
    const opts = mem.loadHostsAsOptions();
    // 孤儿行 10.222.10.21 被过滤；带 label 的 db-01 保留
    expect(opts.length).toBe(1);
    expect(opts[0].value).toBe('10.222.10.22');
  });

  it('loadHostsAsOptions keeps orphans with includeOrphans: true', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '10.222.10.21\n10.222.10.22 | root@db-01');
    const opts = mem.loadHostsAsOptions({ includeOrphans: true });
    expect(opts.length).toBe(2);
    expect(opts[0].label).toContain('orphan');
  });

  it('allMemoryAsContext softens hosts priority wording', async () => {
    const mem = await import('../../src/agent/memory.js');
    mem.remember('hosts', '10.222.10.21 | root@web-01');
    const out = mem.allMemoryAsContext();
    // 不再使用"优先"这种强约束
    expect(out).not.toContain('**优先**用 `hosts` 里的 IP');
    // 强调"用户口述优先"
    expect(out).toContain('用户口述');
  });

  // cleanup
  it('cleans up', () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore on Windows
    }
  });
});
