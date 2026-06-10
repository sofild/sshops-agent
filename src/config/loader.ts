/**
 * 配置加载器
 *
 * - 加载 `config/{providers,agent,permissions,tools}.yaml`
 * - 使用 zod 校验
 * - 合并 `.env` 与 `SSHOPS_*` 环境变量覆盖
 * - 暴露 `getConfig()` 单例
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import yaml from 'js-yaml';
import { z } from 'zod';

loadDotenv();

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..', '..');
export const CONFIG_DIR = resolve(PROJECT_ROOT, 'config');

/* -------------------- Schemas -------------------- */

const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai']),
  apiKey: z.string().min(1, 'apiKey is required'),
  model: z.string().min(1),
  maxTokens: z.number().int().positive().default(8192),
  temperature: z.number().min(0).max(2).default(0.2),
  baseURL: z.string().nullable().optional(),
  promptCache: z.boolean().default(false),
});

const ProvidersFileSchema = z.object({
  active: z.enum(['anthropic', 'openai']),
  providers: z.object({
    anthropic: ProviderConfigSchema.optional(),
    openai: ProviderConfigSchema.optional(),
  }),
  streaming: z.boolean().default(true),
  maxRetries: z.number().int().min(0).max(10).default(3),
});

const AgentFileSchema = z.object({
  maxSteps: z.number().int().positive().default(30),
  maxDurationSeconds: z.number().int().positive().default(600),
  toolTimeoutSeconds: z.number().int().positive().default(60),
  toolRetry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      initialDelayMs: z.number().int().positive().default(1000),
      backoffFactor: z.number().positive().default(2),
      maxDelayMs: z.number().int().positive().default(8000),
    })
    .default({}),
  compression: z
    .object({
      snipMaxBytes: z.number().int().positive().default(4096),
      microcompactMinRun: z.number().int().positive().default(3),
      contextCollapseThreshold: z.number().int().positive().default(20),
      autocompactRatio: z.number().min(0.1).max(1).default(0.85),
      summarizerModel: z.string().nullable().optional(),
    })
    .default({}),
  loopDetectionWindow: z.number().int().positive().default(3),
  hallucinationGuard: z
    .object({
      enabled: z.boolean().default(true),
      failureKeywords: z.array(z.string()).default([]),
    })
    .default({}),
  optionsMenu: z
    .object({
      enabled: z.boolean().default(true),
      preferMenuFor: z.array(z.string()).default([]),
      dataSources: z.array(z.string()).default([]),
    })
    .default({}),
  circuitBreaker: z
    .object({
      maxConsecutiveErrors: z.number().int().positive().default(3),
      cooldownSeconds: z.number().int().positive().default(30),
    })
    .default({}),
  fallback: z
    .record(
      z.array(
        z.object({
          model: z.string(),
          reason: z.string().default('primary unavailable'),
        })
      )
    )
    .default({}),
});

const VaultFileSchema = z.object({
  enabled: z.boolean().default(true),
  binary: z.string().default(''),
  autoStart: z.boolean().default(true),
  reconnect: z
    .object({
      maxRetries: z.number().int().min(0).default(3),
      initialDelayMs: z.number().int().positive().default(500),
      backoffFactor: z.number().positive().default(2),
    })
    .default({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().default('~/.sshops/vault-audit.jsonl'),
    })
    .default({}),
  hardening: z
    .object({
      seccomp: z.boolean().default(false),
      restrictedToken: z.boolean().default(false),
    })
    .default({}),
});

const PermissionsFileSchema = z.object({
  deny: z.array(z.string()).default([]),
  confirm: z.array(z.string()).default([]),
  allow: z.array(z.string()).default([]),
  hostWhitelist: z.array(z.string()).default([]),
  requiredFields: z
    .record(z.string(), z.array(z.string()))
    .default({}),
  optionsMenuTools: z.array(z.string()).default([]),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().default('logs/audit.jsonl'),
      fsync: z.boolean().default(true),
    })
    .default({}),
});

const McpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  toolCacheTtlMs: z.number().int().positive().default(600000),
  startupTimeoutMs: z.number().int().positive().default(30000),
  callTimeoutMs: z.number().int().positive().default(120000),
});

const SshProviderConfigSchema = z.object({
  maxConnectionsPerHost: z.number().int().positive().default(4),
  idleTimeoutMs: z.number().int().positive().default(30 * 60 * 1000),
  connectTimeoutMs: z.number().int().positive().default(15000),
  execTimeoutMs: z.number().int().positive().default(30000),
  strictHostCheck: z.boolean().default(false),
});

const ToolsFileSchema = z.object({
  localTools: z.array(z.string()).default([]),
  mcpServers: z.record(McpServerConfigSchema).default({}),
  sshProvider: SshProviderConfigSchema.default({}),
  concurrency: z
    .object({ maxInFlight: z.number().int().positive().default(5) })
    .default({}),
});

/* -------------------- Types -------------------- */

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;
export type AgentFile = z.infer<typeof AgentFileSchema>;
export type PermissionsFile = z.infer<typeof PermissionsFileSchema>;
export type VaultFile = z.infer<typeof VaultFileSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type SshProviderConfig = z.infer<typeof SshProviderConfigSchema>;
export type ToolsFile = z.infer<typeof ToolsFileSchema>;

export interface AppConfig {
  providers: ProvidersFile;
  agent: AgentFile;
  permissions: PermissionsFile;
  tools: ToolsFile;
  vault: VaultFile;
  env: {
    logLevel: string;
    metricsPort: number;
    profile: 'dev' | 'prod';
  };
}

/* -------------------- Loader -------------------- */

function loadYaml(schema: z.ZodTypeAny, filename: string, defaults?: unknown): unknown {
  const path = resolve(CONFIG_DIR, filename);
  if (!existsSync(path)) {
    if (defaults !== undefined) {
      // 文件不存在但有默认：返回默认值经 schema 校验
      return schema.parse(defaults);
    }
    throw new Error(`config file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`config ${filename} validation failed:\n${issues}`);
  }
  return result.data;
}

function applyEnvOverrides(providers: ProvidersFile): ProvidersFile {
  // 通用 LLM_* 环境变量（推荐：兼容 LiteLLM/OneAPI 等通用代理）
  const llmProvider = process.env.LLM_PROVIDER?.toLowerCase();
  const llmApiKey = process.env.LLM_API_KEY;
  const llmBaseUrl = process.env.LLM_BASE_URL;
  const llmModel = process.env.LLM_MODEL;

  // 旧版 provider-specific 变量（向后兼容）
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiBase = process.env.OPENAI_BASE_URL;

  // 1) 通用 LLM_* 优先：直接改写 active provider
  if (llmProvider && (llmProvider === 'anthropic' || llmProvider === 'openai')) {
    providers.active = llmProvider;
  }
  if (llmApiKey) {
    if (providers.active === 'anthropic' && providers.providers.anthropic) {
      providers.providers.anthropic.apiKey = llmApiKey;
    } else if (providers.active === 'openai' && providers.providers.openai) {
      providers.providers.openai.apiKey = llmApiKey;
    }
  }
  if (llmBaseUrl) {
    if (providers.active === 'anthropic' && providers.providers.anthropic) {
      providers.providers.anthropic.baseURL = llmBaseUrl;
    } else if (providers.active === 'openai' && providers.providers.openai) {
      providers.providers.openai.baseURL = llmBaseUrl;
    }
  }
  if (llmModel) {
    if (providers.active === 'anthropic' && providers.providers.anthropic) {
      providers.providers.anthropic.model = llmModel;
    } else if (providers.active === 'openai' && providers.providers.openai) {
      providers.providers.openai.model = llmModel;
    }
  }

  // 2) 旧版 provider-specific 变量（仅在通用变量未设置时生效）
  if (anthropicKey && !llmApiKey && providers.providers.anthropic) {
    providers.providers.anthropic.apiKey = anthropicKey;
  }
  if (openaiKey && !llmApiKey && providers.providers.openai) {
    providers.providers.openai.apiKey = openaiKey;
  }
  if (openaiBase && !llmBaseUrl && providers.providers.openai) {
    providers.providers.openai.baseURL = openaiBase;
  }
  return providers;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  let providers = loadYaml(ProvidersFileSchema, 'providers.yaml') as ProvidersFile;
  providers = applyEnvOverrides(providers);

  const agent = loadYaml(AgentFileSchema, 'agent.yaml') as AgentFile;
  const permissions = loadYaml(PermissionsFileSchema, 'permissions.yaml') as PermissionsFile;
  const tools = loadYaml(ToolsFileSchema, 'tools.yaml') as ToolsFile;
  const vault = loadYaml(VaultFileSchema, 'vault.yaml', { enabled: false }) as VaultFile;

  cached = {
    providers,
    agent,
    permissions,
    tools,
    vault,
    env: {
      logLevel: process.env.SSHOPS_LOG_LEVEL || 'info',
      metricsPort: Number(process.env.SSHOPS_METRICS_PORT || 0),
      profile:
        (process.env.SSHOPS_PROFILE as 'dev' | 'prod' | undefined) || 'dev',
    },
  };
  return cached;
}

/** 仅用于 config validate 子命令与单元测试 */
export function loadAndValidate(): { ok: true; config: AppConfig } | { ok: false; error: string } {
  try {
    return { ok: true, config: getConfig() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function resetConfigCache(): void {
  cached = null;
}
