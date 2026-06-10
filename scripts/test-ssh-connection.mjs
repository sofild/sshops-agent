#!/usr/bin/env node
/**
 * 独立 SSH 连接测试脚本（端到端：vault + keychain + TCP + SSH 协议 + 真实认证）
 *
 * 用法：node scripts/test-ssh-connection.mjs [host_or_alias] [-v]
 *
 * 流程：
 *   1. 从 ~/.sshops/vault.json 读取主机元数据
 *   2. 从 keychain（Windows DPAPI / macOS Keychain / Linux secret-tool）
 *      取凭证
 *   3. TCP 探测 (host:port) 是否可达
 *   4. SSH 协议握手（BatchMode=yes）—— 验证 SSH 服务在线 + 主机指纹可读
 *   5. 用 SSH_ASKPASS=.cmd 注入密码做真实认证（执行 `uname -a && id` 验证可登录）
 *
 * 退出码：
 *   0 = 全流程通过
 *   非 0 = 任意一步失败（stdout 会清晰指出哪一步、什么原因）
 *
 * Windows 注意事项（导致原始 .cjs askpass 失败的根因）：
 *   OpenSSH 调 askpass 时用 posix_spawnp，对 .cjs / .ps1 直接返回
 *   ERROR_BAD_EXE_FORMAT(193)。必须用 .cmd（cmd.exe 解释器），
 *   并把密码 Base64 编码后嵌入（避免 cmd 解析 % ^ & | < > "）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

const execFileP = promisify(execFile);

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const c = (color, s) => `${C[color]}${s}${C.reset}`;
const ok = (s) => c('green', `  ✓ ${s}`);
const fail = (s) => c('red', `  ✗ ${s}`);
const warn = (s) => c('yellow', `  ! ${s}`);
const info = (s) => c('cyan', `  · ${s}`);
const head = (s) => c('bold', c('magenta', `\n=== ${s} ===`));

function printErr(e) {
  if (e?.code) info(`code: ${e.code}`);
  if (e?.stderr) info(`stderr: ${String(e.stderr).trim().split('\n').slice(0, 5).join(' | ')}`);
  if (e?.stdout) info(`stdout: ${String(e.stdout).trim().split('\n').slice(0, 5).join(' | ')}`);
  info(`msg: ${e?.message ?? String(e)}`);
}

// ---------- 步骤 1：读 vault.json ----------
function loadVaultStore() {
  const path = join(homedir(), '.sshops', 'vault.json');
  if (!existsSync(path)) {
    throw new Error(`vault.json not found at ${path}; run \`sshops-agent vault set <alias>\` first`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return { path, store: raw };
}

function resolveHost(store, target) {
  if (!target) {
    const hosts = Object.values(store.hosts ?? {});
    if (hosts.length === 0) throw new Error('vault has no registered hosts');
    if (hosts.length > 1) {
      const list = hosts.map((h) => `  - ${h.alias} (${h.host})`).join('\n');
      throw new Error(`vault has multiple hosts; pass one as argument:\n${list}`);
    }
    return hosts[0];
  }
  if (store.hosts?.[target]) return store.hosts[target];
  const match = Object.values(store.hosts ?? {}).find((h) => h.host === target);
  if (match) return match;
  throw new Error(`host not found in vault: ${target}`);
}

// ---------- 步骤 2：keychain 读凭证 ----------
const SERVICE = 'sshops-vault';

function dpapiPath(service, account) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  const safeService = service.replace(/[^a-zA-Z0-9_.\-@]/g, '_');
  const safeAccount = account.replace(/[^a-zA-Z0-9_.\-@]/g, '_');
  return join(home, '.sshops', 'dpapi', `${safeService}__${safeAccount}.bin`);
}

async function getSecretWindowsDpapi(keychainAccount) {
  const path = dpapiPath(SERVICE, keychainAccount);
  if (!existsSync(path)) return null;
  const ciphertextB64 = readFileSync(path, 'utf-8').trim();
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encBytes = [Convert]::FromBase64String('${ciphertextB64.replace(/'/g, "''")}')
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $encBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($plainBytes)
`.trim();
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout.trim() || null;
}

async function getSecretMacOS(keychainAccount) {
  try {
    const { stdout } = await execFileP(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', keychainAccount, '-w'],
      { timeout: 10000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getSecretLinux(keychainAccount) {
  try {
    const { stdout } = await execFileP(
      'secret-tool',
      ['lookup', 'service', SERVICE, 'account', keychainAccount],
      { timeout: 10000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getCredential(keychainAccount) {
  if (process.platform === 'win32') return getSecretWindowsDpapi(keychainAccount);
  if (process.platform === 'darwin') return getSecretMacOS(keychainAccount);
  return getSecretLinux(keychainAccount);
}

// ---------- 步骤 3：TCP 探测 ----------
function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = createConnection({ host, port });
    let settled = false;
    const done = (ok2, err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok: ok2, latencyMs: Date.now() - start, err });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, new Error(`timeout after ${timeoutMs}ms`)));
    sock.once('error', (e) => done(false, e));
  });
}

// ---------- 步骤 4：SSH 握手 ----------
async function sshHandshake(host, port, user) {
  const args = [
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=5`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'NumberOfPasswordPrompts=0',
    `${user}@${host}`,
    'echo __SSHOPS_HANDSHAKE_OK__',
  ];
  try {
    await execFileP('ssh', args, { timeout: 15000 });
    return { ok: true, note: 'ssh handshake + publickey succeeded (unexpected with password-only host)' };
  } catch (e) {
    const combined = `${e.message}\n${e.stderr ?? ''}\n${e.stdout ?? ''}`;
    if (/Permission denied/i.test(combined)) {
      return { ok: true, note: 'ssh service reachable, protocol OK, publickey denied (expected for password-only host)' };
    }
    if (/Connection refused|kex_exchange|Connection timed out|No route/i.test(combined)) {
      return { ok: false, note: 'ssh service unreachable', err: e };
    }
    return { ok: true, note: 'ssh handshake completed (auth failure as expected)', raw: combined.slice(0, 400) };
  }
}

// ---------- 步骤 5：SSH_ASKPASS 真实认证 ----------
//
// Windows OpenSSH 调 askpass 时用 posix_spawnp，.cjs / .ps1 直接
// ERROR_BAD_EXE_FORMAT(193)。必须用 .cmd（cmd.exe 解释器），
// 并把密码 Base64 编码后嵌入（避免 cmd 解析 % ^ & | < > "）。
async function sshWithAskpass({ host, port, user, password }) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sshops-test-'));
  const askpassCmd = join(tmpDir, 'askpass.cmd');
  const b64 = Buffer.from(password, 'utf8').toString('base64');
  const cmdContent = `@echo off
powershell -NoProfile -NonInteractive -Command "Write-Output ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); exit 0"
`;
  writeFileSync(askpassCmd, cmdContent, { mode: 0o600 });

  const args = [
    '-p', String(port),
    '-o', 'BatchMode=no',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=10`,
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'PreferredAuthentications=password',
    '-o', 'PubkeyAuthentication=no',
    `${user}@${host}`,
    'echo __SSHOPS_AUTH_OK__ && uname -a && id',
  ];

  const env = {
    ...process.env,
    SSH_ASKPASS: askpassCmd,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY ?? ':0',
  };

  try {
    const { stdout, stderr } = await execFileP('ssh', args, {
      timeout: 25000,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, err: e, stdout: e.stdout, stderr: e.stderr };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }
}

// ---------- 主流程 ----------
async function main() {
  const target = process.argv[2] ?? '192.0.2.1';
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

  let hostMeta;
  let secret = null;

  try {
    head('1. 读取 vault.json');
    const { path, store } = loadVaultStore();
    info(`store: ${path}`);
    hostMeta = resolveHost(store, target);
    console.log(ok(`matched host: ${c('bold', hostMeta.alias)}`));
    console.log(info(`  host:           ${hostMeta.host}`));
    console.log(info(`  user:           ${hostMeta.user}`));
    console.log(info(`  port:           ${hostMeta.port}`));
    console.log(info(`  authType:       ${hostMeta.authType}`));
    console.log(info(`  keychainAccount: ${hostMeta.keychainAccount}`));
    console.log(info(`  tags:           [${hostMeta.tags?.join(', ') ?? ''}]`));
    console.log(info(`  lastConnectedAt: ${hostMeta.lastConnectedAt ?? '(never)'}`));
    console.log(info(`  lastSuccessAt:   ${hostMeta.lastSuccessAt ?? '(never)'}`));
  } catch (e) {
    console.log(fail(`vault config: ${e.message}`));
    process.exit(1);
  }

  try {
    head('2. 从 keychain 读取凭证');
    if (hostMeta.authType === 'privateKey') {
      info('authType=privateKey, skipping keychain (would read private key blob)');
    } else {
      secret = await getCredential(hostMeta.keychainAccount);
      if (!secret) {
        console.log(fail(`no credential in keychain for ${hostMeta.keychainAccount}`));
        console.log(warn('re-run `sshops-agent vault rotate ' + hostMeta.alias + '` to set'));
        process.exit(2);
      }
      console.log(ok(`credential loaded (length=${secret.length}, preview=${c('dim', '*'.repeat(Math.min(secret.length, 8)))})`));
    }
  } catch (e) {
    console.log(fail(`keychain read: ${e.message}`));
    printErr(e);
    process.exit(2);
  }

  try {
    head('3. TCP 探测 (host:port)');
    const t = await tcpProbe(hostMeta.host, hostMeta.port, 5000);
    if (t.ok) {
      console.log(ok(`TCP open: ${hostMeta.host}:${hostMeta.port} (latency=${t.latencyMs}ms)`));
    } else {
      console.log(fail(`TCP closed/unreachable: ${hostMeta.host}:${hostMeta.port}`));
      printErr(t.err);
      process.exit(3);
    }
  } catch (e) {
    console.log(fail(`TCP probe crashed: ${e.message}`));
    process.exit(3);
  }

  try {
    head('4. SSH 协议握手 (BatchMode=yes)');
    const h = await sshHandshake(hostMeta.host, hostMeta.port, hostMeta.user);
    if (h.ok) {
      console.log(ok(h.note));
      if (h.raw && verbose) console.log(info(`detail: ${h.raw}`));
    } else {
      console.log(fail(h.note));
      printErr(h.err);
      process.exit(4);
    }
  } catch (e) {
    console.log(fail(`ssh handshake crashed: ${e.message}`));
    process.exit(4);
  }

  if (hostMeta.authType === 'password' && secret) {
    head('5. 真实 SSH 认证 (SSH_ASKPASS=.cmd + password)');
    const r = await sshWithAskpass({
      host: hostMeta.host,
      port: hostMeta.port,
      user: hostMeta.user,
      password: secret,
    });
    secret = null;
    if (r.ok) {
      console.log(ok('authentication succeeded'));
      console.log(info('remote output:'));
      for (const line of String(r.stdout ?? '').trim().split('\n')) {
        console.log('    ' + c('dim', line));
      }
      console.log('');
      console.log(c('green', c('bold', '  ★ ALL CHECKS PASSED — ssh connection works end-to-end')));
      process.exit(0);
    } else {
      console.log(fail('authentication failed'));
      printErr(r.err);
      if (r.stdout) console.log(info(`stdout: ${String(r.stdout).trim()}`));
      if (r.stderr) {
        console.log(info(`stderr: ${String(r.stderr).trim().split('\n').slice(0, 8).join(' | ')}`));
      }
      process.exit(5);
    }
  } else if (hostMeta.authType === 'privateKey') {
    console.log(warn('privateKey authType: skipped real auth test (need to add private key blob read + ssh -i)'));
    console.log(c('green', c('bold', '\n  ★ Steps 1-4 PASSED — config + TCP + SSH protocol all OK')));
  } else {
    console.log(warn('no auth material; only steps 1-4 verified'));
  }
}

main().catch((e) => {
  console.error(c('red', `\nfatal: ${e?.stack ?? e?.message ?? e}`));
  process.exit(99);
});
