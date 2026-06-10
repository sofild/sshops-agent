/**
 * 主机元数据存储（不含 secret）
 *
 * - ~/.sshops/vault.json
 * - chmod 600
 * - 与 keychain 配合：keychain 存 secret，vault.json 存元数据
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { getLogger } from '../observability/logging.js';

const log = getLogger().child({ component: 'vault.store' });

const HostSchema = z.object({
  alias: z.string(),
  host: z.string(),
  user: z.string(),
  port: z.number().int().positive().default(22),
  authType: z.enum(['password', 'privateKey']),
  keychainAccount: z.string(),
  fingerprint: z.string().nullable().default(null),
  lastConnectedAt: z.string().nullable().default(null),
  lastSuccessAt: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  options: z
    .object({
      sudoPasswordRequired: z.boolean().default(false),
      preferredShell: z.string().default('/bin/bash'),
    })
    .default({}),
});

const StoreSchema = z.object({
  version: z.literal(1),
  hosts: z.record(z.string(), HostSchema),
  pool: z
    .object({
      maxConnectionsPerHost: z.number().int().positive().default(4),
      idleTimeoutMs: z.number().int().positive().default(60000),
      keepaliveIntervalMs: z.number().int().positive().default(30000),
      connectTimeoutMs: z.number().int().positive().default(15000),
    })
    .default({}),
  policy: z
    .object({
      denyHosts: z.array(z.string()).default([]),
      requireConfirmationFor: z.array(z.string()).default([]),
    })
    .default({}),
});

export type VaultStore = z.infer<typeof StoreSchema>;
export type VaultHost = z.infer<typeof HostSchema>;

/**
 * 动态计算默认 store 路径：每次构造时重新读取 homedir()，避免在测试或重置 HOME
 * 后读到过期的硬编码值。
 */
function defaultStorePath(): string {
  return join(homedir(), '.sshops', 'vault.json');
}

export class VaultMetadataStore {
  private path: string;
  private cache: VaultStore | null = null;

  constructor(opts?: { path?: string }) {
    this.path = opts?.path ?? defaultStorePath();
  }

  private load(): VaultStore {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = StoreSchema.parse({
        version: 1,
        hosts: {},
        pool: {},
        policy: {},
      });
      return this.cache;
    }
    try {
      const raw = readFileSync(this.path, 'utf-8');
      this.cache = StoreSchema.parse(JSON.parse(raw));
    } catch (err) {
      log.warn({ err: String(err) }, 'vault.json corrupt, recreating empty store');
      this.cache = StoreSchema.parse({
        version: 1,
        hosts: {},
        pool: {},
        policy: {},
      });
    }
    return this.cache;
  }

  private save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.load(), null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  getAll(): VaultHost[] {
    return Object.values(this.load().hosts);
  }

  getByAliasOrHost(aliasOrHost: string): VaultHost | null {
    const store = this.load();
    if (store.hosts[aliasOrHost]) return store.hosts[aliasOrHost];
    // 按 host IP 匹配
    for (const h of Object.values(store.hosts)) {
      if (h.host === aliasOrHost) return h;
    }
    return null;
  }

  upsert(host: VaultHost): void {
    const store = this.load();
    store.hosts[host.alias] = host;
    this.save();
  }

  remove(alias: string): boolean {
    const store = this.load();
    if (!store.hosts[alias]) return false;
    delete store.hosts[alias];
    this.save();
    return true;
  }

  updateLastSuccess(alias: string): void {
    const store = this.load();
    const h = store.hosts[alias];
    if (!h) return;
    h.lastConnectedAt = new Date().toISOString();
    h.lastSuccessAt = new Date().toISOString();
    this.save();
  }

  updateFingerprint(alias: string, fp: string): void {
    const store = this.load();
    const h = store.hosts[alias];
    if (!h) return;
    h.fingerprint = fp;
    this.save();
  }

  get poolConfig() {
    return this.load().pool;
  }
  get policyConfig() {
    return this.load().policy;
  }
}
