/**
 * WAL fsync-before-yield 行为测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Session WAL fsync', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sshops-fsync-'));
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, 'package.json'), '{}');
  });

  it('appends event with fsync (file is fully on disk immediately)', async () => {
    const { Session } = await import('../../src/session/wal.js');
    const s = Session.open('fsync-test-' + Date.now());
    s.append({ type: 'system', data: { hello: 'world' } });
    s.close();

    // 立即读取应当能看到刚才 append 的事件（fsync 强保证）
    const content = readFileSync(s.path ?? join('sessions', s.id + '.jsonl'), 'utf-8');
    expect(content).toContain('hello');
    expect(content).toContain('system');
  });

  it('listSessions returns sessions sorted by mtime desc', async () => {
    const { Session, listSessions } = await import('../../src/session/wal.js');
    const older = Session.open('older-' + Date.now());
    older.append({ type: 'system', data: { v: 1 } });
    older.close();
    await new Promise((r) => setTimeout(r, 50));
    const newer = Session.open('newer-' + Date.now());
    newer.append({ type: 'system', data: { v: 2 } });
    newer.close();
    const all = listSessions();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].mtime.getTime()).toBeGreaterThanOrEqual(all[1].mtime.getTime());
  });

  it('cleanup', () => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore on Windows
    }
  });
});
