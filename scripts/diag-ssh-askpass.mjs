#!/usr/bin/env node
/**
 * SSH_ASKPASS 行为诊断 v2：用 .cmd 作为 askpass，看 OpenSSH 能否识别
 *
 * 关键修复：Windows OpenSSH 的 askpass 走 posix_spawnp，等价于
 * "在 PATH 找并 execve"。它对 .cjs 直接 ERROR_BAD_EXE_FORMAT(193)。
 * 改用 .cmd（cmd 脚本）。密码经 Base64 编码后由 PowerShell 解码后输出，
 * 避免 % ^ & | < > 等特殊字符被 cmd / PowerShell 解释。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

const PASSWORD = 'dummy_password_for_diagnostic';

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sshops-diag-'));
  const askpass = join(tmpDir, 'askpass.cmd');
  const askpassLog = join(tmpDir, 'askpass.log');

  // 把密码 Base64 编码后嵌入 .cmd —— 避开 cmd 的 % / ^ / & / | / < > / " 等陷阱。
  const b64 = Buffer.from(PASSWORD, 'utf8').toString('base64');

  const cmdContent = `@echo off
setlocal
echo %DATE% %TIME% called argv=%*>> "${askpassLog}"
powershell -NoProfile -NonInteractive -Command "Write-Output ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))); exit 0"
endlocal
`;
  writeFileSync(askpass, cmdContent, { mode: 0o600 });

  const args = [
    '-vvv',
    '-p', '22',
    '-o', 'BatchMode=no',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'PreferredAuthentications=password',
    '-o', 'PubkeyAuthentication=no',
    'root@192.0.2.1',
    'echo OK',
  ];

  const env = {
    ...process.env,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: ':0',
  };

  console.log('askpass path:', askpass);
  console.log('askpass log :', askpassLog);
  console.log('');

  let stdout = '', stderr = '';
  try {
    const r = await execFileP('ssh', args, { timeout: 25000, env, maxBuffer: 8 * 1024 * 1024 });
    stdout = r.stdout ?? '';
    stderr = r.stderr ?? '';
  } catch (e) {
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
  }

  console.log('=== askpass invocation log ===');
  try {
    const log = readFileSync(askpassLog, 'utf-8');
    console.log(log || '(askpass script was NEVER invoked)');
  } catch {
    console.log('(askpass script was NEVER invoked)');
  }
  console.log('');
  console.log('=== ssh stderr (filtered: askpass / auth) ===');
  for (const line of stderr.split('\n')) {
    if (/askpass|Authentication|Permission|password|methods|debug1: Authen|read_passphrase/i.test(line)) {
      console.log(line);
    }
  }
  console.log('');
  console.log('=== ssh stdout ===');
  console.log(stdout || '(empty)');

  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
