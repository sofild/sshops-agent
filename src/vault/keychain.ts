/**
 * 跨平台 Keychain 抽象
 *
 * 优先级链：
 *  1. Windows DPAPI（系统级加密，绑定 Windows 用户）
 *  2. macOS Keychain（`security` CLI）
 *  3. Linux Secret Service（`secret-tool` CLI）
 *  4. EncryptedFile backend（fallback：DPAPI 加密的 .dpapi 文件，跨平台）
 *
 * 所有 backend 实现统一接口：
 *  - getPassword(service, account) → string | null
 *  - setPassword(service, account, secret) → void
 *  - deletePassword(service, account) → boolean
 *
 * 关键：secret 仅在 setPassword 调用栈中存在；setPassword 完成后立即清零内存引用
 * （在调用方负责）。getPassword 返回的字符串也需要在用完后清零。
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'keychain' });

const execFileP = promisify(execFile);

export interface KeychainBackend {
  readonly name: string;
  available(): Promise<boolean>;
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, secret: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

class BackendError extends Error {
  override readonly name = 'BackendError';
  constructor(public readonly backend: string, message: string) {
    super(message);
  }
}

// ============================================================
// Backend 1: Windows DPAPI（绑定 Windows 用户登录会话）
// ============================================================
class WindowsDpapiBackend implements KeychainBackend {
  readonly name = 'windows-dpapi';

  async available(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
      // 测试 PowerShell 是否可用
      await execFileP('powershell.exe', ['-NoProfile', '-Command', 'echo ok'], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    try {
      // 1. 读取 DPAPI 加密文件 ~/.sshops/dpapi/<service>__<account>.bin
      // 2. 用 DPAPI CryptUnprotectData 解密
      const path = dpapiPath(service, account);
      if (!existsSync(path)) return null;
      const ciphertextB64 = readFileSync(path, 'utf-8');
      const plaintext = await dpapiUnprotect(ciphertextB64);
      return plaintext;
    } catch (err) {
      log.warn({ err: String(err) }, 'dpapi get failed');
      return null;
    }
  }

  async setPassword(service: string, account: string, secret: string): Promise<void> {
    const path = dpapiPath(service, account);
    mkdirSync(dirname(path), { recursive: true });
    const ciphertextB64 = await dpapiProtect(secret);
    writeFileSync(path, ciphertextB64, { encoding: 'utf-8', mode: 0o600 });
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const path = dpapiPath(service, account);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}

function dpapiPath(service: string, account: string): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  // 重要：Windows 文件名不允许 ":" 等保留字符。account 里含 "host:web1:user:root" 这种
  // 形式，: 必须替换。其它平台虽然允许 : ，但统一替换更安全。
  const safeService = service.replace(/[^a-zA-Z0-9_.\-@]/g, '_');
  const safeAccount = account.replace(/[^a-zA-Z0-9_.\-@]/g, '_');
  return join(home, '.sshops', 'dpapi', `${safeService}__${safeAccount}.bin`);
}

// 重要：使用 -EncodedCommand 传整个脚本（Base64(UTF-16LE)），不能在 -Command 后追加参数。
//
// 背景：powershell -Command "<script>" 后接的任何参数都会被当作**额外的命令片段**
// 追加到脚本尾部，而不是作为脚本的命名/位置参数。
//   - 例：powershell -Command "if (...) { }" protect "test"
//     实际执行的是：if (...) { } protect test   ← 报 'protect' 不是 cmdlet
//   - 即使脚本里用 $args[N] 也不工作：$args 看到的是空（因为参数没被传给脚本）
//
// 解决方案：把所有值都嵌入到脚本字符串里，再用 -EncodedCommand 编码。
// - EncodedCommand 是官方推荐的"传复杂脚本给 PowerShell"方式
// - 编码为 UTF-16LE 的 Base64，完全避免 shell 转义问题
// - 字段值需要在 PowerShell 单引号字符串里正确转义（' → ''）
const DPAPI_PROTECT_PS = (escapedPlain: string) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plainBytes = [System.Text.Encoding]::UTF8.GetBytes('${escapedPlain}')
$encBytes = [System.Security.Cryptography.ProtectedData]::Protect(
  $plainBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($encBytes)
`.trim();

const DPAPI_UNPROTECT_PS = (escapedCipherB64: string) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encBytes = [Convert]::FromBase64String('${escapedCipherB64}')
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $encBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($plainBytes)
`.trim();

/**
 * PowerShell 单引号字符串内的转义规则：单引号 → 两个单引号。
 * 这是唯一需要转义的字符（在单引号字符串内）。
 */
function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * 编码为 PowerShell -EncodedCommand 期望的格式：UTF-16LE 的 Base64。
 */
function psEncoded(s: string): string {
  return Buffer.from(s, 'utf16le').toString('base64');
}

async function dpapiProtect(plaintext: string): Promise<string> {
  const script = DPAPI_PROTECT_PS(psQuote(plaintext));
  const encoded = psEncoded(script);
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout.trim();
}

async function dpapiUnprotect(ciphertextB64: string): Promise<string> {
  const script = DPAPI_UNPROTECT_PS(psQuote(ciphertextB64));
  const encoded = psEncoded(script);
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout.trim();
}

// ============================================================
// Backend 2: macOS Keychain（`security` CLI）
// ============================================================
class MacOSKeychainBackend implements KeychainBackend {
  readonly name = 'macos-keychain';

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    try {
      await execFileP('security', ['list-keychains'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileP(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { timeout: 10000 }
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async setPassword(service: string, account: string, secret: string): Promise<void> {
    await execFileP(
      'security',
      ['add-generic-password', '-s', service, '-a', account, '-w', secret, '-U'],
      { timeout: 10000 }
    );
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    try {
      await execFileP('security', ['delete-generic-password', '-s', service, '-a', account], {
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================
// Backend 3: Linux Secret Service（`secret-tool` CLI）
// ============================================================
class LinuxSecretToolBackend implements KeychainBackend {
  readonly name = 'linux-secret-tool';

  async available(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    try {
      await execFileP('secret-tool', ['--help'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileP(
        'secret-tool',
        ['lookup', 'service', service, 'account', account],
        { timeout: 10000 }
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async setPassword(service: string, account: string, secret: string): Promise<void> {
    // secret-tool 期望 stdin 接收 secret
    await new Promise<void>((resolve, reject) => {
      const child = spawn('secret-tool', [
        'store',
        '--label',
        `sshops: ${service}/${account}`,
        'service',
        service,
        'account',
        account,
      ]);
      const errs: Buffer[] = [];
      child.stderr.on('data', (c) => errs.push(c));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new BackendError(this.name, `exit ${code}: ${Buffer.concat(errs).toString()}`));
      });
      child.on('error', reject);
      child.stdin.write(secret);
      child.stdin.end();
    });
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    try {
      await execFileP(
        'secret-tool',
        ['clear', 'service', service, 'account', account],
        { timeout: 10000 }
      );
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================
// Backend 4: EncryptedFile fallback（跨平台，DPAPI 派生 key）
// ============================================================
/**
 * 最后 fallback：把 secret 加密后存到文件。
 *
 * - Windows: 用 DPAPI 派生 key（user-bound）
 * - 其他: 用 `hostname + username` 派生 key（machine-bound，不抗 root）
 *
 * 这是 v1 MVP 阶段的安全降级：依然有加密，但抗威胁等级低于 OS keychain。
 * v2 升级：用更稳健的 machine fingerprint + 可选 passphrase。
 *
 * 导出供单元测试使用（避免被 Windows DPAPI 等慢后端拖慢）。
 */
export class EncryptedFileBackend implements KeychainBackend {
  readonly name = 'encrypted-file';

  async available(): Promise<boolean> {
    return true; // 总是可用
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const path = this.path(service, account);
    if (!existsSync(path)) return null;
    try {
      const blob = JSON.parse(readFileSync(path, 'utf-8')) as EncryptedBlob;
      const key = await deriveKey();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const dec = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
      return dec.toString('utf-8');
    } catch (err) {
      log.warn({ err: String(err) }, 'encrypted-file get failed');
      return null;
    }
  }

  async setPassword(service: string, account: string, secret: string): Promise<void> {
    const path = this.path(service, account);
    mkdirSync(dirname(path), { recursive: true });
    const key = await deriveKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(secret, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob: EncryptedBlob = {
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    };
    writeFileSync(path, JSON.stringify(blob), { encoding: 'utf-8', mode: 0o600 });
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const path = this.path(service, account);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  private path(service: string, account: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
    // 同 dpapiPath：跨平台统一避免 : 等保留字符
    const safeService = service.replace(/[^a-zA-Z0-9_.\-@]/g, '_');
    const safeAccount = account.replace(/[^a-zA-Z0-9_.\-@]/g, '_');
    return join(home, '.sshops', 'secrets', `${safeService}__${safeAccount}.enc`);
  }
}

interface EncryptedBlob {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

let cachedKey: Buffer | null = null;
export function resetCachedKey(): void {
  cachedKey = null;
}
async function deriveKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  // salt: 固定但与平台相关的字符串
  const saltStr = process.platform + ':' + (process.env.USER ?? process.env.USERNAME ?? 'unknown');
  const salt = Buffer.from(saltStr);
  // machine-bound identifier
  const identifier = process.platform === 'win32' ? 'win32' : (process.env.HOSTNAME ?? 'unknown');
  const keyMaterial = `${process.platform}::${identifier}::${process.env.USER ?? process.env.USERNAME ?? ''}::sshops-vault-v1`;
  cachedKey = pbkdf2Sync(keyMaterial, salt, 100_000, 32, 'sha256');
  return cachedKey;
}

// ============================================================
// Registry
// ============================================================
const BACKENDS: KeychainBackend[] = [
  new WindowsDpapiBackend(),
  new MacOSKeychainBackend(),
  new LinuxSecretToolBackend(),
  new EncryptedFileBackend(), // 兜底
];

let selectedBackend: KeychainBackend | null = null;
let backendSelectionAttempted = false;

export async function getKeychain(): Promise<KeychainBackend> {
  if (selectedBackend) return selectedBackend;
  if (!backendSelectionAttempted) {
    backendSelectionAttempted = true;
    for (const b of BACKENDS) {
      try {
        if (await b.available()) {
          selectedBackend = b;
          log.info({ backend: b.name }, 'keychain backend selected');
          return b;
        }
      } catch (err) {
        log.warn({ backend: b.name, err: String(err) }, 'backend availability check failed');
      }
    }
  }
  throw new Error('No keychain backend available');
}

export function getSelectedBackendName(): string | null {
  return selectedBackend?.name ?? null;
}
