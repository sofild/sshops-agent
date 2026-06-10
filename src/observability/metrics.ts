/**
 * Prometheus 指标
 */
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  registry,
  invocations: new Counter({
    name: 'agent_invocations_total',
    help: 'Total agent invocations',
    labelNames: ['status'] as const,
    registers: [registry],
  }),
  toolCalls: new Counter({
    name: 'agent_tool_calls_total',
    help: 'Total tool calls',
    labelNames: ['tool', 'status'] as const,
    registers: [registry],
  }),
  llmTokens: new Counter({
    name: 'agent_llm_tokens_total',
    help: 'Total LLM tokens used',
    labelNames: ['provider', 'model', 'type'] as const,
    registers: [registry],
  }),
  activeSessions: new Gauge({
    name: 'agent_active_sessions',
    help: 'Number of active sessions',
    registers: [registry],
  }),
  vaultAcquire: new Counter({
    name: 'agent_vault_acquire_total',
    help: 'Vault acquire attempts',
    labelNames: ['status'] as const,
    registers: [registry],
  }),
  vaultInject: new Counter({
    name: 'agent_vault_inject_total',
    help: 'Vault credential injection into tool args (Phase 2)',
    labelNames: ['status'] as const,
    registers: [registry],
  }),
  vaultRedirect: new Counter({
    name: 'agent_vault_redirect_total',
    help: 'Agent redirected user to sshops-vault set <alias>',
    registers: [registry],
  }),
  // === 新增指标（Phase 6） ===
  hallucinationAttempts: new Counter({
    name: 'agent_hallucination_attempts_total',
    help: 'Tool failure signals caught by hallucination guard',
    labelNames: ['tool', 'kind'] as const,
    registers: [registry],
  }),
  needInputEvents: new Counter({
    name: 'agent_need_input_total',
    help: 'need_input events emitted',
    labelNames: ['tool'] as const,
    registers: [registry],
  }),
  optionsMenuEvents: new Counter({
    name: 'agent_options_menu_total',
    help: 'options_menu events emitted',
    labelNames: ['field'] as const,
    registers: [registry],
  }),
  fallbackEvents: new Counter({
    name: 'agent_fallback_total',
    help: 'Model fallback transitions',
    labelNames: ['from', 'to'] as const,
    registers: [registry],
  }),
  stateTransitions: new Counter({
    name: 'agent_state_transitions_total',
    help: 'Agent state machine transitions',
    labelNames: ['from', 'to'] as const,
    registers: [registry],
  }),
  toolDedup: new Counter({
    name: 'agent_tool_dedup_total',
    help: 'Tool-use-id deduplication hits',
    labelNames: ['tool'] as const,
    registers: [registry],
  }),
};

export async function metricsHandler(): Promise<string> {
  return metrics.registry.metrics();
}

export async function startMetricsServer(port: number): Promise<void> {
  if (port <= 0) return;
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', metrics.registry.contentType);
      res.end(await metricsHandler());
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[metrics] listening on http://localhost:${port}/metrics`);
  });
}
