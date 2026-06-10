/**
 * sshops-vault CLI 入口
 *
 * 既可以独立运行（node dist/vault/cli.js），也可以被主 CLI 以子命令形式加载
 * （registerVaultCli），后者用于单二进制分发场景。
 *
 * 子命令：
 *   serve                启动 JSON-RPC daemon（agent 通过 stdio 调用）— 长期运行，不退出
 *   init                 检测 keychain 可用性、初始化 vault.json
 *   set <alias>          设置凭证（写入 keychain + vault.json）
 *   list                 列出所有已注册主机（不含密码）
 *   show <alias>         显示主机元数据
 *   rotate <alias>       旋转密码
 *   delete <alias>       从 keychain + vault.json 删除
 *   ping <alias>         测试连接（开一个 acquire 验证）
 *   status               列出活跃连接池（需要先有 daemon 在跑）
 *   audit [N]            tail 审计日志
 *
 * v1：CLI 不通过 daemon，直接读写 keychain + vault.json。
 *     （agent 才通过 daemon）
 *
 * 退出策略：除 `serve` 外的所有子命令在成功/失败时显式 `process.exit()`。
 * 原因：pino logger 文件流、stdin 处于 raw/resumed 状态、vault 内部 setInterval 计时器
 * 等都会让 Node.js 进程不自然退出。显式 exit 是一致且可预测的做法。
 */
import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { getKeychain, getSelectedBackendName } from './keychain.js';
import { VaultMetadataStore } from './store.js';
import { VaultAuditLog } from './audit.js';
import { getStderrOnlyLogger } from '../observability/logging.js';
import { getConfig } from '../config/loader.js';
import { startVaultDaemon } from './entry.js';

// CLI 不参与 stdio RPC，但保持 stderr-only 一致（也防止独立运行时 stdout
// 被 console.log 之外的 pino 日志污染）
const log = getStderrOnlyLogger('vault.cli');

/**
 * 包装 action handler：成功 → process.exit(0)，失败 → process.exit(1)
 * 用于一次性 CLI 子命令（serve 除外）。
 * 接受同步或异步 handler，统一用 Promise.resolve 包装。
 */
function oneShot<TArgs extends unknown[]>(
  handler: (...args: TArgs) => void | Promise<void>
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await Promise.resolve(handler(...args));
      process.exit(0);
    } catch (err) {
      // 错误通常已经在 handler 里 console.error 过了；这里兜底
      if (!(err instanceof Error) || !err.message) {
        // eslint-disable-next-line no-console
        console.error(err);
      }
      process.exit(1);
    }
  };
}

/**
 * 把 vault 子命令注册到一个 commander parent 上。
 * 既可被主 CLI 调用（program.command('vault').addCommand(...)），也可独立运行。
 */
export function registerVaultCli(parent: Command): void {
  const v = parent
    .command('vault')
    .description('凭证管理（keychain + metadata store）');

  v.command('serve')
    .description('start JSON-RPC daemon (used by agent over stdio) — long-running')
    .action(async () => {
      // serve 是长驻进程，不调用 process.exit —— daemon 内部控制 event loop
      try {
        await startVaultDaemon();
      } catch (err) {
        log.error({ err: String(err) }, 'vault daemon crashed');
        process.exit(1);
      }
    });

  v.command('init')
    .description('detect keychain backend and create empty vault.json')
    .action(
      oneShot(async () => {
        const kc = await getKeychain();
        // eslint-disable-next-line no-console
        console.log(`✓ keychain backend: ${kc.name}`);
        const store = new VaultMetadataStore();
        store.getAll(); // 触发 vault.json 创建
        // eslint-disable-next-line no-console
        console.log(
          `✓ metadata store: ${(store as unknown as { path: string }).path}`
        );
        // eslint-disable-next-line no-console
        console.log('Run `sshops-agent vault set <alias>` to register a host.');
      })
    );

  v.command('set <alias>')
    .description('register a host and store credential in keychain')
    .option('-u, --user <user>', 'SSH user (default: root)', 'root')
    .option('-p, --port <port>', 'SSH port (default: 22)', '22')
    .option('--password', 'use password auth (default)')
    .option('--private-key', 'use private key auth')
    .option('--host <host>', 'override host IP (default: same as alias)')
    .option('--tag <tag...>', 'attach tags to this host')
    .action(
      oneShot(async (alias: string, opts: {
        user: string;
        port: string;
        password?: boolean;
        privateKey?: boolean;
        host?: string;
        tag?: string[];
      }) => {
        const authType: 'password' | 'privateKey' = opts.privateKey ? 'privateKey' : 'password';
        const prompt =
          authType === 'password'
            ? `password for ${opts.user}@${opts.host ?? alias}: `
            : `private key content (paste, end with Ctrl+D): `;
        const secret = await readSecret(prompt, authType === 'password');
        if (!secret) {
          throw new Error('no secret provided');
        }
        const store = new VaultMetadataStore();
        const kc = await getKeychain();
        const keychainAccount = `host:${alias}:user:${opts.user}`;
        await kc.setPassword('sshops-vault', keychainAccount, secret);
        store.upsert({
          alias,
          host: opts.host ?? alias,
          user: opts.user,
          port: Number(opts.port),
          authType,
          keychainAccount,
          fingerprint: null,
          lastConnectedAt: null,
          lastSuccessAt: null,
          tags: opts.tag ?? [],
          options: { sudoPasswordRequired: false, preferredShell: '/bin/bash' },
        });
        // eslint-disable-next-line no-console
        console.log(
          `✓ registered ${alias} → ${opts.user}@${opts.host ?? alias}:${opts.port} (authType=${authType})`
        );
        // eslint-disable-next-line no-console
        console.log(`  keychain: ${keychainAccount} (${getSelectedBackendName() ?? 'auto'})`);
      })
    );

  v.command('list')
    .description('list all registered hosts')
    .action(
      oneShot(() => {
        const store = new VaultMetadataStore();
        const hosts = store.getAll();
        if (hosts.length === 0) {
          // eslint-disable-next-line no-console
          console.log('(no hosts registered)');
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `${'ALIAS'.padEnd(24)}${'HOST'.padEnd(20)}${'USER'.padEnd(12)}${'AUTH'.padEnd(8)}TAGS`
        );
        for (const h of hosts) {
          // eslint-disable-next-line no-console
          console.log(
            `${h.alias.padEnd(24)}${h.host.padEnd(20)}${h.user.padEnd(12)}${h.authType.padEnd(8)}${h.tags.join(',')}`
          );
        }
      })
    );

  v.command('show <alias>')
    .description('show metadata for a host (no secrets)')
    .action(
      oneShot((alias: string) => {
        const store = new VaultMetadataStore();
        const h = store.getByAliasOrHost(alias);
        if (!h) throw new Error(`host not found: ${alias}`);
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(h, null, 2));
      })
    );

  v.command('rotate <alias>')
    .description('rotate credential for a host')
    .action(
      oneShot(async (alias: string) => {
        const store = new VaultMetadataStore();
        const h = store.getByAliasOrHost(alias);
        if (!h) throw new Error(`host not found: ${alias}`);
        const secret = await readSecret(
          `new secret for ${h.user}@${h.host}: `,
          h.authType === 'password'
        );
        if (!secret) throw new Error('no secret provided');
        const kc = await getKeychain();
        await kc.setPassword('sshops-vault', h.keychainAccount, secret);
        store.updateLastSuccess(alias);
        // eslint-disable-next-line no-console
        console.log(`✓ rotated ${alias}`);
      })
    );

  v.command('delete <alias>')
    .description('remove host from keychain + vault.json')
    .action(
      oneShot(async (alias: string) => {
        const store = new VaultMetadataStore();
        const h = store.getByAliasOrHost(alias);
        if (!h) throw new Error(`host not found: ${alias}`);
        const kc = await getKeychain();
        await kc.deletePassword('sshops-vault', h.keychainAccount);
        store.remove(alias);
        // eslint-disable-next-line no-console
        console.log(`✓ deleted ${alias}`);
      })
    );

  v.command('ping <alias>')
    .description('test that credential is accessible (without actually connecting)')
    .action(
      oneShot(async (alias: string) => {
        const store = new VaultMetadataStore();
        const h = store.getByAliasOrHost(alias);
        if (!h) throw new Error(`host not found: ${alias}`);
        const kc = await getKeychain();
        const secret = await kc.getPassword('sshops-vault', h.keychainAccount);
        if (!secret) throw new Error(`no credential in keychain for ${alias}`);
        // eslint-disable-next-line no-console
        console.log(
          `✓ credential accessible (length=${secret.length}, authType=${h.authType})`
        );
        // eslint-disable-next-line no-console
        console.log(
          `  (real network test requires mcp-server-ssh; see Phase 2 of vault design)`
        );
      })
    );

  v.command('audit [N]')
    .description('tail last N audit log entries (default 20)')
    .action(
      oneShot((n: string | undefined) => {
        const audit = new VaultAuditLog();
        const p = (audit as unknown as { path: string }).path;
        if (!existsSync(p)) {
          // eslint-disable-next-line no-console
          console.log('(no audit log yet)');
          return;
        }
        const lines = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
        const take = Number(n ?? 20);
        const slice = lines.slice(-take);
        for (const line of slice) {
          try {
            const obj = JSON.parse(line);
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(obj));
          } catch {
            // eslint-disable-next-line no-console
            console.log(line);
          }
        }
      })
    );

  v.command('status')
    .description('show connection pool status (only meaningful when daemon is running)')
    .action(
      oneShot(() => {
        // eslint-disable-next-line no-console
        console.log(
          '(status requires agent-side pool query; agent will display this on demand)'
        );
      })
    );
}

// 独立运行入口：仅当被 node 直接执行时（`node dist/vault/cli.js`）才激活
if (
  process.argv[1] &&
  (process.argv[1].endsWith('vault/cli.js') ||
    process.argv[1].endsWith('vault\\cli.js') ||
    process.argv[1].endsWith('vault-cli.js'))
) {
  const standalone = new Command();
  standalone
    .name('sshops-vault')
    .description('sshops-agent credential vault (keychain + metadata store)')
    .version('0.1.0');
  registerVaultCli(standalone);
  standalone.parseAsync(process.argv).catch((err) => {
    log.error({ err: String(err) }, 'cli crashed');
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

// ---------- helpers ----------
async function readSecret(prompt: string, sensitive: boolean): Promise<string> {
  return new Promise((resolve) => {
    if (sensitive) {
      const stdin = process.stdin;
      const stdout = process.stdout;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      stdout.write(prompt);
      let buf = '';
      const onData = (ch: string) => {
        for (const c of ch) {
          if (c === '\n' || c === '\r' || c === '\x04') {
            stdin.removeListener('data', onData);
            if (stdin.isTTY) stdin.setRawMode?.(false);
            stdout.write('\n');
            // 退出 readSecret 时清干净 stdin 状态，避免 Node 进程不退出
            stdin.pause();
            stdin.unref?.();
            resolve(buf);
            return;
          }
          if (c === '\x03') {
            process.exit(130);
          }
          if (c === '\x7f' || c === '\b') {
            buf = buf.slice(0, -1);
            stdout.write('\b \b');
            continue;
          }
          buf += c;
          stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (ans) => {
        rl.close();
        // 关闭 readline 之后 pause+unref stdin，防止 process 不退出
        process.stdin.pause();
        process.stdin.unref?.();
        resolve(ans);
      });
    }
  });
}

// 仅 standalone 模式才会在文件末尾 auto-parse；上面的 if 块已经显式 parseAsync，
// 因此这里不再重复 export program.parseAsync。
