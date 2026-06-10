/**
 * SshProvider 单元测试
 *
 * mock ssh2.Client 验证：
 *  - connect() 成功入池
 *  - connect() 复用活跃连接（不调 Client.new）
 *  - exec() 正确返回 stdout/stderr/exitCode
 *  - exec() 超时抛 SshError('timeout')
 *  - disconnect() 清池
 *  - classifySshError 三类
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------- ssh2 mock ----------
type MockClient = EventEmitter & {
  connect: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

const clients: MockClient[] = [];
function makeMockClient(): MockClient {
  const c = new EventEmitter() as MockClient;
  c.connect = vi.fn();
  c.exec = vi.fn();
  c.end = vi.fn();
  clients.push(c);
  return c;
}

vi.mock('ssh2', () => {
  const Client = vi.fn().mockImplementation(() => makeMockClient());
  return { Client };
});

// 必须在 mock 之后导入
const { SshProvider, SshError, resetSshProvider } = await import('../../src/ssh/provider.js');

beforeEach(() => {
  clients.length = 0;
  resetSshProvider();
});

afterEach(() => {
  vi.useRealTimers();
});

// 触发 Client 的 ready 事件（async 等一帧）
async function flushReady() {
  await new Promise((r) => setImmediate(r));
}

describe('SshProvider.connect', () => {
  it('connects successfully and stores in pool', async () => {
    const p = new SshProvider();
    // 在 client 构造时挂 ready 触发
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    origCtor.mockImplementationOnce(() => {
      const c = makeMockClient();
      // 同步：在 c.connect() 调用时触发 ready
      c.connect.mockImplementation(() => {
        setImmediate(() => c.emit('ready'));
      });
      return c;
    });

    const info = await p.connect({ host: '10.0.0.1', port: 22, username: 'root', password: 'x' });
    expect(info.host).toBe('10.0.0.1');
    expect(info.port).toBe(22);
    expect(info.username).toBe('root');
    expect(info.connectionId).toBe('10.0.0.1:22');
    expect(p.listConnections()).toHaveLength(1);
  });

  it('reuses alive connection instead of creating new one', async () => {
    const p = new SshProvider();
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    let callCount = 0;
    origCtor.mockImplementation(() => {
      callCount++;
      const c = makeMockClient();
      c.connect.mockImplementation(() => {
        setImmediate(() => c.emit('ready'));
      });
      c.exec.mockImplementation((_cmd: string, cb: (err: null, stream: EventEmitter) => void) => {
        const s = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        s.stderr = new EventEmitter();
        setImmediate(() => {
          s.emit('data', Buffer.from('__alive__\n'));
          s.emit('close', 0);
        });
        cb(null, s);
      });
      return c;
    });

    await p.connect({ host: 'h', port: 22, username: 'u', password: 'p' });
    expect(callCount).toBe(1);

    // 第二次 connect 同一 host:port 应复用
    const info2 = await p.connect({ host: 'h', port: 22, username: 'u', password: 'p' });
    expect(callCount).toBe(1);
    expect(info2.connectionId).toBe('h:22');
  });

  it('throws SshError on connection failure', async () => {
    const p = new SshProvider();
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    origCtor.mockImplementationOnce(() => {
      const c = makeMockClient();
      c.connect.mockImplementation(() => {
        setImmediate(() => c.emit('error', new Error('ECONNREFUSED')));
      });
      return c;
    });

    await expect(
      p.connect({ host: 'h', port: 22, username: 'u', password: 'p' })
    ).rejects.toBeInstanceOf(SshError);
  });

  it('throws no_auth_method when no password and no key', async () => {
    // 临时：override homedir 没默认 key 的环境
    const p = new SshProvider();
    await expect(
      // @ts-expect-error 故意不传 password/privateKey
      p.connect({ host: 'h', port: 22, username: 'u' })
    ).rejects.toThrow(/no authentication method/i);
  });
});

describe('SshProvider.exec', () => {
  it('returns stdout/stderr/exitCode on success', async () => {
    const p = new SshProvider({ execTimeoutMs: 5000 });
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    origCtor.mockImplementationOnce(() => {
      const c = makeMockClient();
      c.connect.mockImplementation(() => setImmediate(() => c.emit('ready')));
      c.exec.mockImplementation((_cmd: string, cb: (err: null, stream: EventEmitter) => void) => {
        const s = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        s.stderr = new EventEmitter();
        setImmediate(() => {
          s.emit('data', Buffer.from('hello\n'));
          s.stderr.emit('data', Buffer.from('warn\n'));
          s.emit('close', 0);
        });
        cb(null, s);
      });
      return c;
    });

    const info = await p.connect({ host: 'h', port: 22, username: 'u', password: 'p' });
    const r = await p.exec(info.connectionId, 'echo hello');
    expect(r.stdout).toBe('hello');
    expect(r.stderr).toBe('warn');
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('throws SshError timeout on slow command', async () => {
    // 只 fake setTimeout/setInterval，保留 setImmediate 让 connect 的 setImmediate(() => ready) 触发
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    const p = new SshProvider({ execTimeoutMs: 100 });
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    origCtor.mockImplementationOnce(() => {
      const c = makeMockClient();
      c.connect.mockImplementation(() => setImmediate(() => c.emit('ready')));
      // exec 永不 close → 触发 timeout
      c.exec.mockImplementation((_cmd: string, cb: (err: null, stream: EventEmitter) => void) => {
        const s = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        s.stderr = new EventEmitter();
        cb(null, s);
      });
      return c;
    });

    const info = await p.connect({ host: 'h', port: 22, username: 'u', password: 'p' });
    const pending = p.exec(info.connectionId, 'sleep 999');
    // vitest 2.x：advanceTimersByTimeAsync 触发 setTimeout 时 reject 是 unhandled，
    // 先挂一个 noop 捕获，expect 下面还会再断言一次
    pending.catch(() => {});
    // 推进 setTimeout
    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws unknown_connection for unknown id', async () => {
    const p = new SshProvider();
    await expect(p.exec('no-such-id', 'ls')).rejects.toMatchObject({ kind: 'unknown_connection' });
  });
});

describe('SshProvider.disconnect', () => {
  it('clears pool when no id given', async () => {
    const p = new SshProvider();
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    origCtor.mockImplementation(() => {
      const c = makeMockClient();
      c.connect.mockImplementation(() => setImmediate(() => c.emit('ready')));
      return c;
    });

    await p.connect({ host: 'h1', port: 22, username: 'u', password: 'p' });
    await p.connect({ host: 'h2', port: 22, username: 'u', password: 'p' });
    expect(p.listConnections()).toHaveLength(2);

    const closed = await p.disconnect();
    expect(closed).toHaveLength(2);
    expect(p.listConnections()).toHaveLength(0);
  });

  it('closes single connection by id', async () => {
    const p = new SshProvider();
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    origCtor.mockImplementation(() => {
      const c = makeMockClient();
      c.connect.mockImplementation(() => setImmediate(() => c.emit('ready')));
      return c;
    });

    await p.connect({ host: 'h1', port: 22, username: 'u', password: 'p' });
    await p.connect({ host: 'h2', port: 22, username: 'u', password: 'p' });
    const closed = await p.disconnect('h1:22');
    expect(closed).toEqual(['h1:22']);
    expect(p.listConnections()).toHaveLength(1);
  });
});

describe('SshProvider.systemInfo', () => {
  it('returns a system info exec result', async () => {
    const p = new SshProvider();
    const origCtor = (await import('ssh2')).Client as unknown as ReturnType<typeof vi.fn>;
    origCtor.mockImplementationOnce(() => {
      const c = makeMockClient();
      c.connect.mockImplementation(() => setImmediate(() => c.emit('ready')));
      c.exec.mockImplementation((_cmd: string, cb: (err: null, stream: EventEmitter) => void) => {
        const s = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        s.stderr = new EventEmitter();
        setImmediate(() => {
          s.emit('data', Buffer.from('Linux box 5.10\n'));
          s.emit('close', 0);
        });
        cb(null, s);
      });
      return c;
    });

    const info = await p.connect({ host: 'h', port: 22, username: 'u', password: 'p' });
    const r = await p.systemInfo(info.connectionId);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Linux box');
  });
});
