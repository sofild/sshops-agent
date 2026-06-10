/**
 * Session WAL 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

describe('Session WAL', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sshops-test-'));
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, 'package.json'), '{}');
  });

  it('appends and loads events', async () => {
    // 通过动态导入 + 重置路径避免污染真实 session
    const { Session } = await import('../../src/session/wal.js');
    const id = 'test-' + Date.now();
    const s = Session.open(id);
    s.append({ type: 'system', data: { hello: 'world' } });
    s.append({ type: 'user_message', data: { text: 'hi' } });
    const events = s.load();
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('system');
    expect(events[1].type).toBe('user_message');

    // Windows 上 rmSync 可能因文件句柄未释放而 EPERM，跳过清理
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // ignore on Windows
    }
  });
});
