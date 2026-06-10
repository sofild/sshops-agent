#!/usr/bin/env node
/**
 * 自研 SshProvider 端到端验证脚本
 *
 * 用法：npx tsx scripts/test-ssh-provider.mjs [host_or_alias] [-v]
 *  （用 tsx 才能 import ../src/ssh/provider.js 的 .ts 源码）
 *  也可以先 npm run build 再 node scripts/test-ssh-provider.mjs
 *
 * 不走 agent，直接 import src/ssh/provider.js，
 * 验证 SshProvider 能用 ssh2 库连上目标主机并执行命令。
 *
 * 流程：
 *   1. 从 ~/.sshops/vault.json 读主机元数据
 *   2. 从 keychain 读凭证（Windows DPAPI / macOS Keychain / Linux secret-tool）
 *   3. 调 getSshProvider().connect()
 *   4. 调 .exec('uname -a && id')
 *   5. 调 .disconnect()
 *
 * 退出码：
 *   0 = 全部通过
 *   非 0 = 失败（stdout 明确指出哪步、什么原因）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
        process.exit(2);
      }
      console.log(ok(`credential loaded (length=${secret.length})`));
    }
  } catch (e) {
    console.log(fail(`keychain read: ${e.message}`));
    process.exit(2);
  }

  let provider;
  try {
    head('3. 实例化 SshProvider');
    const mod = await import('../src/ssh/provider.js');
    provider = mod.getSshProvider({
      connectTimeoutMs: 15000,
      execTimeoutMs: 30000,
      strictHostCheck: false,
    });
    console.log(ok('provider initialized'));
  } catch (e) {
    console.log(fail(`provider init: ${e.message}`));
    process.exit(3);
  }

  let connectionId;
  try {
    head('4. provider.connect()');
    const connectOpts = {
      host: hostMeta.host,
      port: hostMeta.port,
      username: hostMeta.user,
    };
    if (hostMeta.authType === 'password') {
      connectOpts.password = secret;
    } else {
      connectOpts.privateKey = secret;
    }
    const info2 = await provider.connect(connectOpts);
    connectionId = info2.connectionId;
    secret = null; // 用完即丢
    console.log(ok(`connected: ${info2.username}@${info2.host}:${info2.port}`));
    console.log(info(`connectionId: ${connectionId}`));
    console.log(info(`fingerprint: ${info2.fingerprint ?? '(none)'}`));
  } catch (e) {
    console.log(fail(`connect failed: ${e?.message ?? e}`));
    if (e?.kind) console.log(info(`kind: ${e.kind}`));
    process.exit(4);
  }

  try {
    head('5. provider.exec("uname -a && id")');
    const r = await provider.exec(connectionId, 'uname -a && id', 15000);
    console.log(ok(`exitCode=${r.exitCode} durationMs=${r.durationMs}`));
    if (r.stdout) {
      console.log(info('stdout:'));
      for (const line of r.stdout.split('\n')) {
        console.log('    ' + c('dim', line));
      }
    }
    if (r.stderr) {
      console.log(warn('stderr:'));
      for (const line of r.stderr.split('\n')) {
        console.log('    ' + c('dim', line));
      }
    }
    if (r.exitCode !== 0) {
      console.log(fail('command exited non-zero'));
      process.exit(5);
    }
  } catch (e) {
    console.log(fail(`exec failed: ${e?.message ?? e}`));
    if (e?.kind) console.log(info(`kind: ${e.kind}`));
    process.exit(5);
  }

  try {
    head('6. provider.disconnect()');
    const closed = await provider.disconnect(connectionId);
    console.log(ok(`closed ${closed.length} connection(s)`));
  } catch (e) {
    console.log(warn(`disconnect error: ${e?.message ?? e}`));
  }

  console.log('');
  console.log(c('green', c('bold', '  ★ ALL CHECKS PASSED — SshProvider works end-to-end')));
  process.exit(0);
}

main().catch((e) => {
  console.error(c('red', `\nfatal: ${e?.stack ?? e?.message ?? e}`));
  process.exit(99);
});
