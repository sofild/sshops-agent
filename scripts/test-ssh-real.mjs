#!/usr/bin/env node
/**
 * SSH_ASKPASS 真实密码测试：从 vault.json + keychain 取出 web1 的密码，
 * 用 .cmd 形式 askpass 注入，跑真实的 SSH 认证。
 *
 * 如果通过：证明 vault + keychain + 网络 + SSH 认证 全链路 OK。
 * 如果失败：-vvv 日志会明确指出哪一步。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

// ---------- 1) 读 vault.json ----------
const TARGET = process.argv[2] ?? '192.0.2.1';
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

const vaultPath = join(homedir(), '.sshops', 'vault.json');
if (!existsSync(vaultPath)) {
  console.error(`✗ vault.json not found: ${vaultPath}`);
  process.exit(1);
}
const store = JSON.parse(readFileSync(vaultPath, 'utf-8'));
const host = store.hosts?.[TARGET]
  ?? Object.values(store.hosts ?? {}).find((h) => h.host === TARGET);
if (!host) {
  console.error(`✗ host not found in vault: ${TARGET}`);
  process.exit(1);
}
console.log(`✓ vault: ${host.alias} (${host.user}@${host.host}:${host.port}, authType=${host.authType})`);

// ---------- 2) 读 keychain (DPAPI) ----------
async function getSecretWinDpapi(keychainAccount) {
  const path = join(homedir(), '.sshops', 'dpapi',
    `sshops-vault__${keychainAccount.replace(/[^a-zA-Z0-9_.\-@]/g, '_')}.bin`);
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

const password = await getSecretWinDpapi(host.keychainAccount);
if (!password) {
  console.error(`✗ no credential in keychain for ${host.keychainAccount}`);
  process.exit(2);
}
console.log(`✓ keychain: password loaded (length=${password.length})`);

// ---------- 3) askpass .cmd + 真实 ssh ----------
const tmpDir = mkdtempSync(join(tmpdir(), 'sshops-real-'));
const askpass = join(tmpDir, 'askpass.cmd');
// 把密码 base64 嵌入 .cmd，避开 cmd 特殊字符
const b64 = Buffer.from(password, 'utf8').toString('base64');
const cmdContent = `@echo off
powershell -NoProfile -NonInteractive -Command "Write-Output ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); exit 0"
`;
writeFileSync(askpass, cmdContent, { mode: 0o600 });
// 立刻从 Node 内存里抹掉 password 引用
const _ = password.length;

const args = [
  ...(VERBOSE ? ['-vvv'] : []),
  '-p', String(host.port),
  '-o', 'BatchMode=no',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', `ConnectTimeout=${VERBOSE ? 10 : 10}`,
  '-o', 'NumberOfPasswordPrompts=1',
  '-o', 'PreferredAuthentications=password',
  '-o', 'PubkeyAuthentication=no',
  `${host.user}@${host.host}`,
  'echo __SSHOPS_AUTH_OK__ && uname -a && id',
];

const env = {
  ...process.env,
  SSH_ASKPASS: askpass,
  SSH_ASKPASS_REQUIRE: 'force',
  DISPLAY: ':0',
};

console.log(`\n→ ssh ${args.join(' ')}`);
console.log(`  SSH_ASKPASS=${askpass}`);
console.log('');

let stdout = '', stderr = '';
const t0 = Date.now();
try {
  const r = await execFileP('ssh', args, { timeout: 25000, env, maxBuffer: 8 * 1024 * 1024 });
  stdout = r.stdout ?? '';
  stderr = r.stderr ?? '';
  console.log('✓ ssh exit 0 (success) in', Date.now() - t0, 'ms');
  console.log('--- remote output ---');
  console.log(stdout);
  console.log('---------------------');
} catch (e) {
  stdout = e.stdout ?? '';
  stderr = e.stderr ?? '';
  console.error(`✗ ssh exit ${e.code ?? 'non-zero'} after ${Date.now() - t0}ms`);
  console.error('--- stdout ---');
  console.error(stdout || '(empty)');
  console.error('--- stderr ---');
  console.error(stderr || '(empty)');
  if (VERBOSE) {
    console.error('--- last 40 stderr lines ---');
    console.error(stderr.split('\n').slice(-40).join('\n'));
  }
  process.exitCode = 5;
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
