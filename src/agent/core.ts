/**
 * Agent 核心循环
 *
 * - AsyncGenerator 流式事件
 * - 7 个 continue 站点
 * - 工具调用必经权限层
 * - 整体超时 + 单步超时
 * - 指数退避重试
 * - 上下文压缩判定
 * - 循环检测
 * - 反幻觉硬约束 + need_input / options_menu 追问回路
 * - 消息去重 + 熔断器 + 伪不可变 state
 */
import type { Message, ContentBlock, ToolDefinition } from '../llm/types.js';
import type { Tool, ToolResult } from '../tools/types.js';
import { getLLMClient } from '../llm/factory.js';
import { getToolRegistry } from '../tools/registry.js';
import { evaluateToolCall } from '../permissions/enforcer.js';
import { auditWrite, summarize } from '../permissions/audit.js';
import { confirmAction } from '../permissions/prompt.js';
import { Session } from '../session/wal.js';
import { compress, countToolCalls } from './compressor.js';
import { allMemoryAsContext } from './memory.js';
import { newTraceId } from '../observability/tracer.js';
import { metrics } from '../observability/metrics.js';
import { getLogger } from '../observability/logging.js';
import { getConfig } from '../config/loader.js';
import { PermissionDeniedError, ToolTimeoutError, TurnTimeoutError, CircuitOpenError } from '../utils/errors.js';
import {
  type AgentRunState,
  type AgentState,
  type Question,
  type MenuOption,
  HALLUCINATION_GUARD_HINT,
  parseNeedInputMarker,
  parseOptionsMenuMarker,
  stripStructuredMarkers,
  isFailureSignal,
} from './types.js';
import { getVaultClient } from '../vault/client.js';
import { VAULT_ERROR_CODES } from '../vault/types.js';
import { loadMemoryDataSource } from './memory.js';
import { getSshProvider } from '../ssh/provider.js';

const log = getLogger().child({ component: 'agent.core' });

export type AgentEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'message_start'; role: 'user' | 'assistant' }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string; result: ToolResult }
  | { type: 'tool_denied'; toolUseId: string; name: string; reason: string }
  | { type: 'tool_confirm_required'; toolUseId: string; name: string; reason: string }
  | { type: 'need_input'; toolUseId: string; questions: Question[] }
  | { type: 'options_menu'; toolUseId: string; prompt: string; field: string; options: MenuOption[] }
  | { type: 'compression'; level: string; summary?: string }
  | { type: 'state_change'; from: AgentState; to: AgentState; reason?: string }
  | { type: 'fallback'; fromModel: string; toModel: string; reason: string }
  | { type: 'final'; answer: string }
  | { type: 'final_history'; messages: Message[] }
  | { type: 'error'; error: Error }
  | { type: 'session_end'; reason: string };

export interface AgentRunOptions {
  sessionId?: string;
  /** 不询问确认（非交互模式） */
  nonInteractive?: boolean;
  /** 已有 system prompt 增量 */
  extraSystem?: string;
  /** 历史消息（用于 resume） */
  history?: Message[];
  /**
   * Phase 4: REPL 透传的 connectionId 缓存。跨 turn 复用，
   * 让 LLM 上一轮用过的 host:port / alias 能直接命中，无需 auto-connect。
   */
  connectionIdCache?: Map<string, string>;
  /**
   * Phase 5: REPL 注入的 abort controller（Ctrl+C 中断当前 turn）。
   * - 调 LLM 前后检查 `signal.aborted`，命中后抛错退出 generator
   * - 透传到 llm.chat() 的 options.signal（stream 循环内部 break）
   * - 透传到工具调用的 ctx.signal（让 ssh_ssh_exec 等可中断）
   */
  abortSignal?: AbortSignal;
}

const SYSTEM_PROMPT = `你是 sshops-agent，一个智能化的服务器运维助手。
你的目标是用自然语言一句话完成服务器环境搭建、应用部署、日常监控与故障排查。
你有多种工具可用：
- ssh_* 工具用于远程操作 Linux 服务器（执行命令、上传/下载文件等）
- local:* 工具用于本地辅助操作（读文件、获取时间、HTTP GET 等）

工作原则：
1. 先思考再行动：把任务拆解为多个小步骤，每步对应一次工具调用
2. 工具结果作为下一步的输入；不要凭空假设命令的输出
3. 如果一次工具调用失败，尝试重试或换一种方法
4. 危险操作（rm -rf、systemctl stop、iptables -F 等）会被权限层拦截，改为更安全的做法
5. 完成后给用户一个简明的总结（做了什么、结果如何、下一步建议）

如果记忆中存在相关上下文，请优先使用。

【SSH 连接流程 — 严格遵守，禁止伪造】
1. \`ssh_ssh_connect\` 是建立 SSH 连接的**唯一入口**。必填 host、username；
   password / privateKey / privateKeyPath 至少一个（可由 vault 自动注入）。
   推荐只传 host，让 vault 注入完整参数（host/port/username/auth）——避免密码进入 LLM 上下文。
2. ssh_ssh_connect 返回的 \`id\` 字段是 host:port 形式（如 "10.222.10.48:22"），
   由自研 SshProvider 直接生成。是后续所有 \`ssh_ssh_exec\` / \`ssh_ssh_system_info\` /
   \`sftp_*\` 调用的**唯一合法 connectionId 来源**。
3. **绝对禁止**：
   - 在 ssh_ssh_connect 还没成功返回前，先调 ssh_ssh_exec / system_info / sftp_*
   - 把 alias、host、username 等任何字符串当作 connectionId 传入后续工具
   - 凭空写"连接成功" / "已连接"等字样而没有 ssh_ssh_connect 的 isError:false 工具结果佐证
   - 猜一个 connectionId：必须等 ssh_ssh_connect 的真实返回
4. 如果 ssh_ssh_connect 报错（auth failed、host unreachable、host key verification 等），
   立即停止，向用户报告错误并询问下一步。
5. 如果 LLM 误把 alias / host / host:port 当 connectionId 传入 ssh_ssh_exec / ssh_ssh_system_info，
   agent 会自动尝试 vault 解析并 auto-connect 拿到真实 id；不需要 LLM 自行补全。
6. **重要**：
   - 用户给的具体 IP（如 "连接 10.222.10.48 查系统信息"），**必须**先调 ssh_ssh_connect
     （即使你认为密码不在 LLM 上下文里——vault 会自动注入完整参数）。
   - 不要写"已知主机 10.222.10.48"这种确认后仍不调 ssh_ssh_connect 的回答；
     这种回答会被反幻觉守卫标记为错误。
   - 在 ssh_ssh_connect 工具结果**真的出现**前，不要在文本里写"已连接" / "登录成功"等结论。
7. **关键反馈回路**：
   - 仔细读 tool_result 块：如果 isError=false 且 content 包含 id 字段（如 10.222.10.48:22），
     说明连接**真的**成功。**不要**再调一次 ssh_ssh_connect，而是用返回的 id 接着调 ssh_ssh_exec。
   - 不要重复调同一个工具：连了一次失败后才允许重试，连成功了就直接进入下一步。

【反幻觉硬约束 — 违反将直接导致运维事故】
1. 工具返回的 tool_result 若带 isError=true，或 content 中含 "No authentication method"、
   "No connection with id"、"Not connected"、"permission denied"、"command not found"、
   "Host key verification failed" 等明确失败关键词，必须在你的文本响应末尾追加
   \`[NEED_INPUT:<field1>|<field2>...]\` 标记向用户追问。**绝对禁止**以任何形式捏造命令成功后的输出。
2. 当工具参数不完整时（例如 ssh_ssh_connect 缺 password / privateKey / privateKeyPath），
   禁止调用后续工具——必须先让 vault 注入（如果已配置）或者向用户追问。
3. 当用户问"那台机器/这个服务器/上次那台"等模糊指代时，禁止随意猜一个 host。
   改用 \`[OPTIONS:field|value1=label1,value2=label2,...]\` 标记向用户列出 1-N 个已知选项。
4. 不得把"工具返回的错误信息"解释为"成功但内容较少"。
5. 在一次完整工具调用链（connect → execute → ...）结束前，禁止给出"已连接"、"操作完成"等结论文本。`;

export async function* run(
  input: string,
  options: AgentRunOptions = {}
): AsyncIterable<AgentEvent> {
  const appCfg = getConfig();
  const cfg = appCfg.agent;
  const activeProvider = appCfg.providers.providers[appCfg.providers.active];
  const sessionId = options.sessionId ?? Session.newId();
  const session = Session.open(sessionId);
  const traceId = newTraceId();
  // let：模型降级链切换后需要指向新的 client（旧代码从未调用 fallbackToNext）
  let llm = getLLMClient();
  const registry = getToolRegistry();
  metrics.activeSessions.inc({});

  // 五状态机
  const runState: AgentRunState = {
    status: 'idle',
    messages: [],
    turnNumber: 0,
    maxTurns: cfg.maxSteps,
    sessionStartedAt: Date.now(),
    sessionTimeoutSeconds: cfg.maxDurationSeconds,
    turnTimeoutSeconds: cfg.toolTimeoutSeconds,
    hasAttemptedReactiveCompact: false,
    pauseRequested: false,
    consecutiveErrors: 0,
    maxConsecutiveErrors: cfg.circuitBreaker?.maxConsecutiveErrors ?? 3,
    seenToolUseIds: new Set(),
    fallbackIndex: 0,
    // Phase 4: REPL 透传缓存时复用同一引用；否则每轮创建新 Map（仅当轮内有效）
    connectionIdCache: options.connectionIdCache ?? new Map<string, string>(),
  };

  const startTime = Date.now();
  const overallTimer = setTimeout(() => {
    /* 整体超时通过 Date.now() 比较 */
  }, runState.sessionTimeoutSeconds * 1000);

  // 挂载 SIGUSR1/SIGUSR2 用于 PAUSED 状态
  const sigUsr1 = () => {
    runState.pauseRequested = true;
  };
  const sigUsr2 = () => {
    if (runState.status === 'paused') runState.pauseRequested = false;
  };
  process.once('SIGUSR1', sigUsr1);
  process.once('SIGUSR2', sigUsr2);

  const transitionTo = (to: AgentState, reason?: string) => {
    const from = runState.status;
    if (from === to) return;
    runState.status = to;
  };

  let finalAnswer = '';
  let stepCount = 0;
  const recentActions: string[] = []; // 循环检测

  try {
    transitionTo('running');
    yield { type: 'state_change', from: 'idle', to: 'running' };
    yield { type: 'session_start', sessionId };
    session.append({ type: 'system', data: { msg: 'agent run start', traceId } });

    // 构造消息历史
    if (options.history) {
      runState.messages = [...options.history];
    }
    runState.messages = [...runState.messages, { role: 'user', content: input }];
    session.append({ type: 'user_message', data: { text: input } });

    // 主循环
    while (true) {
      // ---------- continue 站点 A: 暂停信号 ----------
      if (runState.pauseRequested) {
        transitionTo('paused', 'user_requested');
        yield { type: 'state_change', from: 'running', to: 'paused', reason: 'user_requested' };
        // 等待 SIGUSR2 恢复
        while (runState.pauseRequested) {
          await sleep(100);
        }
        transitionTo('running', 'resumed');
        yield { type: 'state_change', from: 'paused', to: 'running', reason: 'resumed' };
      }

      // ---------- continue 站点 B: 整体超时 ----------
      if (Date.now() - startTime > runState.sessionTimeoutSeconds * 1000) {
        transitionTo('expired', 'session_timeout');
        yield { type: 'state_change', from: 'running', to: 'expired', reason: 'session_timeout' };
        yield { type: 'error', error: new Error(`max duration ${runState.sessionTimeoutSeconds}s exceeded`) };
        yield { type: 'final_history', messages: [...runState.messages] };
        yield { type: 'session_end', reason: 'timeout' };
        return;
      }

      // ---------- continue 站点 C: 步数限制 ----------
      if (stepCount >= cfg.maxSteps) {
        transitionTo('expired', 'max_steps');
        yield { type: 'state_change', from: 'running', to: 'expired', reason: 'max_steps' };
        yield { type: 'error', error: new Error(`max steps ${cfg.maxSteps} reached`) };
        yield { type: 'final_history', messages: [...runState.messages] };
        yield { type: 'session_end', reason: 'max_steps' };
        return;
      }
      stepCount++;

      // ---------- 准备工具定义（稳定前缀） ----------
      const tools: ToolDefinition[] = registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      tools.sort((a, b) => a.name.localeCompare(b.name));
      const systemPrompt = [SYSTEM_PROMPT, options.extraSystem ?? '', allMemoryAsContext()]
        .filter(Boolean)
        .join('\n\n');

      // ---------- continue 站点 D: 上下文压缩判定 ----------
      // 预算必须包含 system prompt 与工具 schema，窗口来自当前 LLM client
      // （降级后 model 可能不同），而不是 provider.maxTokens。
      const comp = await compress(runState.messages, {
        system: systemPrompt,
        tools,
        contextWindow: llm.contextWindow,
        maxOutputTokens: activeProvider?.maxTokens,
      });
      if (comp.level) {
        runState.messages = [...comp.messages];
        yield { type: 'compression', level: comp.level, summary: comp.summary };
        session.append({ type: 'compression', data: { level: comp.level } });
      }

      // ---------- continue 站点 E: 调 LLM ----------
      yield { type: 'message_start', role: 'assistant' };
      let assistantText = '';
      const pendingTools: { id: string; name: string; input: Record<string, unknown> }[] = [];
      let stopReason = '';
      let usage: { input: number; output: number } | null = null;
      const toolNameById = new Map<string, string>();

      try {
        // Phase 5: 调 LLM 前检查 abort
        if (options.abortSignal?.aborted) {
          throw new Error('agentRun aborted before LLM call');
        }
        for await (const ev of llm.chat(runState.messages, {
          tools,
          system: systemPrompt,
          signal: options.abortSignal, // 透传（ChatOptions.signal 字段已存在）
        })) {
          // Phase 5: stream 期间实时检查 abort（防御 provider 漏抛的情况）
          if (options.abortSignal?.aborted) {
            throw new Error('agentRun aborted during LLM stream');
          }
          if (ev.type === 'text_delta') {
            assistantText += ev.text;
            yield { type: 'text', text: ev.text };
          } else if (ev.type === 'tool_use_start') {
            toolNameById.set(ev.id, ev.name);
          } else if (ev.type === 'tool_use_end') {
            pendingTools.push({
              id: ev.id,
              name: ev.name ?? toolNameById.get(ev.id) ?? '',
              input: ev.input,
            });
          } else if (ev.type === 'message_end') {
            stopReason = ev.stopReason;
          } else if (ev.type === 'usage') {
            usage = { input: ev.inputTokens, output: ev.outputTokens };
            metrics.llmTokens.inc(
              { provider: llm.providerName, model: llm.defaultModel, type: 'input' },
              ev.inputTokens
            );
            metrics.llmTokens.inc(
              { provider: llm.providerName, model: llm.defaultModel, type: 'output' },
              ev.outputTokens
            );
          } else if (ev.type === 'error') {
            throw ev.error;
          }
        }
        // 成功后清零连续错误
        runState.consecutiveErrors = 0;
      } catch (err) {
        // Phase 5: abort 触发的错误立刻向上抛，停止整个 agentRun。
        // 不计入 consecutiveErrors，不重试，不走 circuit breaker 路径。
        // 让 REPL 的 SIGINT handler 能直接捕获并清理 in-flightAbort。
        if (options.abortSignal?.aborted) {
          // 重新抛出 abort 错误，让外层 for-await 接收（REPL 区分 abort vs 真实错误）
          throw err instanceof Error ? err : new Error(String(err));
        }

        // 模型降级链：provider 内部重试已耗尽后才走到这里。
        // factory.fallbackToNext() 在旧代码中从未被调用（配置是死配置）。
        try {
          const factory = await import('../llm/factory.js');
          if (typeof factory.fallbackToNext === 'function') {
            const next = factory.fallbackToNext('llm_error');
            if (next) {
              llm = factory.getLLMClient();
              runState.consecutiveErrors = 0;
              runState.fallbackIndex += 1;
              const reason = err instanceof Error ? err.message : String(err);
              log.warn(
                { from: next.from, to: next.to, reason },
                'llm fallback switched model'
              );
              metrics.fallbackEvents.inc({ from: next.from, to: next.to });
              yield {
                type: 'fallback',
                fromModel: next.from,
                toModel: next.to,
                reason: reason.slice(0, 200),
              };
              continue;
            }
          }
        } catch (fallbackErr) {
          log.warn({ err: String(fallbackErr) }, 'llm fallback attempt failed');
        }

        runState.consecutiveErrors += 1;
        if (runState.consecutiveErrors >= runState.maxConsecutiveErrors) {
          transitionTo('error', 'circuit_open');
          yield {
            type: 'state_change',
            from: 'running',
            to: 'error',
            reason: `circuit_open after ${runState.consecutiveErrors} consecutive errors`,
          };
          yield {
            type: 'error',
            error: new CircuitOpenError(
              `circuit open after ${runState.consecutiveErrors} errors: ${String(err)}`,
              runState.consecutiveErrors
            ),
          };
          yield { type: 'final_history', messages: [...runState.messages] };
          yield { type: 'session_end', reason: 'circuit_open' };
          return;
        }
        // 记录错误并继续
        log.warn(
          { err: String(err), consecutive: runState.consecutiveErrors },
          'llm call failed, will retry'
        );
        yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
        continue;
      }

      // ---------- 解析 LLM 响应中的 need_input / options_menu 结构化标记 ----------
      // 尊重配置开关：旧实现解析后无条件触发，config 里的 enabled 是死开关。
      const needInputQuestions =
        cfg.hallucinationGuard?.enabled !== false ? parseNeedInputMarker(assistantText) : null;
      const optionsMenu =
        cfg.optionsMenu?.enabled !== false ? parseOptionsMenuMarker(assistantText) : null;
      let guardHintNeeded = false;

      // 把 assistant 消息加入历史（保留结构化标记以便审计）
      const assistantBlocks: ContentBlock[] = [];
      if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText });
      for (const t of pendingTools) {
        assistantBlocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
      }
      runState.messages = [...runState.messages, { role: 'assistant', content: assistantBlocks }];
      session.append({
        type: 'assistant_message',
        data: { text: assistantText, tool_uses: pendingTools, stopReason, usage },
      });

      // 如果 LLM 触发了 need_input，先 yield 事件
      if (needInputQuestions && needInputQuestions.length > 0) {
        const lastToolId = pendingTools[pendingTools.length - 1]?.id ?? `ask_${Date.now()}`;
        yield { type: 'need_input', toolUseId: lastToolId, questions: needInputQuestions };
        metrics.needInputEvents.inc({ tool: pendingTools[pendingTools.length - 1]?.name ?? 'unknown' });
        // 反幻觉提示不能插在 assistant.tool_use 与 tool_result 之间：
        // Anthropic 要求 tool_result 紧跟上一条 assistant 的 tool_use，
        // OpenAI 要求 tool 消息紧跟 assistant.tool_calls。旧实现把提示
        // 作为独立 user 消息提前插入，会直接制造非法历史。
        guardHintNeeded = true;
      }

      // 如果 LLM 触发了 options_menu，yield 事件
      if (optionsMenu) {
        const lastToolId = pendingTools[pendingTools.length - 1]?.id ?? `menu_${Date.now()}`;
        yield {
          type: 'options_menu',
          toolUseId: lastToolId,
          prompt: optionsMenu.prompt,
          field: optionsMenu.field,
          options: optionsMenu.options,
        };
        metrics.optionsMenuEvents.inc({ field: optionsMenu.field });
      }

      // ---------- continue 站点 F: 终止判断 ----------
      if (
        stopReason === 'end_turn' ||
        (pendingTools.length === 0 && assistantText && !needInputQuestions && !optionsMenu)
      ) {
        finalAnswer = stripStructuredMarkers(assistantText);
        transitionTo('idle', 'end_turn');
        yield { type: 'state_change', from: 'running', to: 'idle', reason: 'end_turn' };
        yield { type: 'final', answer: finalAnswer };
        metrics.invocations.inc({ status: 'success' });
        yield { type: 'final_history', messages: [...runState.messages] };
        yield { type: 'session_end', reason: 'end_turn' };
        return;
      }

      if (pendingTools.length === 0) {
        // LLM 给了空响应：可能中断
        transitionTo('idle', 'empty');
        yield { type: 'state_change', from: 'running', to: 'idle', reason: 'empty' };
        yield { type: 'final_history', messages: [...runState.messages] };
        yield { type: 'session_end', reason: 'empty' };
        return;
      }

      // ---------- continue 站点 G: 工具派发（带权限/超时/重试/去重/反幻觉守卫） ----------
      const toolResults: { toolUseId: string; content: string; isError?: boolean }[] = [];
      const failureKeywords = getConfig().agent.hallucinationGuard?.failureKeywords ?? [
        'No authentication method',
        'No connection with id',
        'No default SSH key found',
        'Authentication failed',
        'Host key verification failed',
        'Host key changed',
        'permission denied',
        'command not found',
        'No such file',
        'no such file or directory',  // Phase 3: 新增
        'cannot access',              // Phase 3: 新增
        'syntax error',               // Phase 3: 新增
        'Connection lost',            // Phase 3: 新增
        'Not connected',              // Phase 3: 新增
        'sftp_read failed',
        'sftp_write failed',
      ];
      let encounteredFailure = false;
      let firstFailureToolId: string | null = null;

      for (const tc of pendingTools) {
        // 消息去重：跳过已执行过的 tool_use_id
        if (runState.seenToolUseIds.has(tc.id)) {
          log.info({ toolUseId: tc.id, tool: tc.name }, 'tool call deduped');
          metrics.toolCalls.inc({ tool: tc.name, status: 'deduped' });
          toolResults.push({
            toolUseId: tc.id,
            content: '[deduped: this tool_use_id was already executed]',
            isError: false,
          });
          metrics.toolDedup.inc({ tool: tc.name });
          continue;
        }

        // 循环检测：只在工具调用成功后记录，避免误判重试失败的操作
        const actionKey = `${tc.name}:${JSON.stringify(tc.input)}`;
        
        // 权限评估
        const decision = evaluateToolCall(tc.name, tc.input);
        auditWrite({
          session_id: sessionId,
          trace_id: traceId,
          tool: tc.name,
          command: typeof tc.input.command === 'string' ? tc.input.command : undefined,
          host: typeof tc.input.host === 'string' ? tc.input.host : undefined,
          decision: decision.decision,
          reason: decision.reason,
        });

        if (decision.decision === 'deny') {
          yield {
            type: 'tool_denied',
            toolUseId: tc.id,
            name: tc.name,
            reason: decision.reason,
          };
          toolResults.push({
            toolUseId: tc.id,
            content: `[denied by policy] ${decision.reason}`,
            isError: true,
          });
          metrics.toolCalls.inc({ tool: tc.name, status: 'denied' });
          continue;
        }

        if (decision.decision === 'confirm') {
          // 必填字段缺失时先尝试 vault 自动注入；即使 non-interactive 也要
          // 先给 vault 一次机会，否则 CI / pipe 模式下 vault 永远无法工作。
          if (decision.missingFields && decision.missingFields.length > 0) {
            // Phase 1 vault 集成：缺凭证时先尝试 vault 拿 connectionId
            const vaultResult = await evaluateVaultCredentials(
              tc.name,
              tc.input,
              decision.missingFields
            );
            if (vaultResult.ok) {
              // 注入密码到 ssh_ssh_connect args
              tc.input = { ...tc.input, ...vaultResult.credentialPatch };
              log.info(
                {
                  tool: tc.name,
                  host: vaultResult.host,
                  username: vaultResult.username,
                  authType: vaultResult.authType,
                },
                'vault injected credential into ssh_ssh_connect args'
              );
              // 调试钩子：SSHOPS_DEBUG_SSH=1 时打印注入后的完整 args，
              // 便于定位"vault 注入了什么 → 工具收到什么"差异
              if (process.env.SSHOPS_DEBUG_SSH === '1') {
                log.warn(
                  { patchedArgs: tc.input, missingFieldsAfter: decision.missingFields },
                  'SSHOPS_DEBUG_SSH: ssh_ssh_connect args after vault injection'
                );
              }
              // Phase 2: 给 LLM 显式确认日志，方便用户从 REPL 看到 vault 在工作
              console.error(
                `[vault] injected credential for ${vaultResult.alias ?? vaultResult.host} ` +
                  `(host=${vaultResult.host}, user=${vaultResult.username}, authType=${vaultResult.authType})`
              );
              metrics.vaultInject.inc({ status: 'success' });
              // 跳到执行：清空 missingFields，并把 decision 改为 allow
              decision.missingFields = [];
              decision.decision = 'allow';
              // 不走 confirmAction，落到执行
            } else if (options.nonInteractive) {
              // 非交互模式无法追问：明确拒绝并给出可操作原因，
              // 而不是静默跳过 vault 直接 deny。
              yield {
                type: 'tool_denied',
                toolUseId: tc.id,
                name: tc.name,
                reason: `missing credentials and vault unavailable (${vaultResult.reason})`,
              };
              toolResults.push({
                toolUseId: tc.id,
                content: `[denied in non-interactive mode] missing ${decision.missingFields.join(', ')}; vault: ${vaultResult.reason}`,
                isError: true,
              });
              metrics.toolCalls.inc({ tool: tc.name, status: 'denied' });
              continue;
            } else {
              // vault 走不通：根据 reason 给出不同提示
              let prompt = `请提供 ${decision.missingFields.join(', ')}`;
              if (vaultResult.reason === 'credential_missing') {
                prompt = `缺少 ${vaultResult.alias} 的凭证。\n请运行：\n  sshops-vault set ${vaultResult.alias} --user root\n（密码将存储到系统 keychain，永不进 LLM context）\n配置完成后输入 done 继续`;
              } else if (vaultResult.reason === 'auth_failed') {
                prompt = `凭证错误（${vaultResult.alias}）。\n请运行：\n  sshops-vault rotate ${vaultResult.alias}\n修复后输入 done 继续`;
              } else if (vaultResult.reason === 'host_not_found') {
                prompt = `主机 ${vaultResult.alias} 未在 vault.json 中注册。\n请运行：\n  sshops-vault set ${vaultResult.alias}\n配置后输入 done 继续`;
              } else if (vaultResult.reason === 'connection_denied') {
                prompt = `vault 策略拒绝连接 ${vaultResult.alias}：${vaultResult.error ?? ''}`;
              } else if (vaultResult.reason === 'vault_error') {
                prompt = `vault 调用失败：${vaultResult.error ?? 'unknown'}。可临时设置 SSHOPS_VAULT_DISABLED=1 绕过`;
              }
              const questions: Question[] = [
                {
                  field: 'vault_configured',
                  prompt,
                  sensitive: false,
                },
              ];
              yield { type: 'need_input', toolUseId: tc.id, questions };
              toolResults.push({
                toolUseId: tc.id,
                content: `[vault ${vaultResult.reason}] ${vaultResult.alias ?? ''} — ${vaultResult.error ?? ''} — waiting for vault config`,
                isError: true,
              });
              metrics.toolCalls.inc({ tool: tc.name, status: 'need_input' });
              continue;
            }
          }
          // 命令级 confirm（rm -rf / systemctl stop 等）在非交互模式仍拒绝
          if (decision.decision === 'confirm' && options.nonInteractive) {
            yield {
              type: 'tool_denied',
              toolUseId: tc.id,
              name: tc.name,
              reason: 'confirm required but non-interactive mode',
            };
            toolResults.push({
              toolUseId: tc.id,
              content: `[denied in non-interactive mode] ${decision.reason}`,
              isError: true,
            });
            metrics.toolCalls.inc({ tool: tc.name, status: 'denied' });
            continue;
          }
          if (decision.decision === 'confirm') {
            const ok = await confirmAction(
              `确认在 ${tc.input.host ?? 'local'} 执行 ${tc.name} (${decision.reason})?`
            );
            if (!ok) {
              yield {
                type: 'tool_denied',
                toolUseId: tc.id,
                name: tc.name,
                reason: 'user denied confirmation',
              };
              toolResults.push({
                toolUseId: tc.id,
                content: '[denied by user]',
                isError: true,
              });
              metrics.toolCalls.inc({ tool: tc.name, status: 'denied' });
              continue;
            }
          }
        }

        // 执行（带超时 + 重试）
        // v1 auto-connect：在执行前，解析 LLM 传的 connectionId。
        // 如果是 alias / host:port / IP，自动调 ssh_ssh_connect 拿真实 id 并 patch。
        const resolved = await resolveConnectionId(
          tc.name,
          tc.input,
          runState.connectionIdCache
        );
        const effectiveInput = resolved.args;
        if (resolved.autoConnected) {
          log.info(
            { tool: tc.name, originalArgs: tc.input, patchedArgs: effectiveInput },
            'auto-connect: connectionId patched before tool execution'
          );
        }
        const tool = registry.get(tc.name);
        runState.seenToolUseIds.add(tc.id);
        yield { type: 'tool_call', name: tc.name, args: effectiveInput, toolUseId: tc.id };
        session.append({ type: 'tool_call', data: { id: tc.id, name: tc.name, args: effectiveInput } });

        const ctxDecision =
          decision.decision === 'allow'
            ? { decision: 'allow' as const, reason: decision.reason }
            : { decision: 'confirm' as const, reason: decision.reason, requiresUserConfirm: true };

        // Phase 5: 工具调用前检查 abort
        if (options.abortSignal?.aborted) {
          throw new Error('agentRun aborted before tool call');
        }
        const result = await executeWithRetryAndTimeout(
          tool,
          effectiveInput,
          {
            sessionId,
            traceId,
            signal: options.abortSignal ?? new AbortController().signal,
            decision: ctxDecision,
          },
          cfg.toolRetry,
          cfg.toolTimeoutSeconds * 1000
        );

        toolResults.push({
          toolUseId: tc.id,
          content: summarize(result.content, 4096),  // Phase 3: 512→4096，避免长 ls / cat 被截断导致 LLM 脑补
          isError: result.isError,
        });
        yield { type: 'tool_result', toolUseId: tc.id, result };
        session.append({
          type: 'tool_result',
          data: { id: tc.id, content: result.content.slice(0, 1024), isError: !!result.isError },
        });
        metrics.toolCalls.inc({ tool: tc.name, status: result.isError ? 'error' : 'success' });

        // 循环检测：只在工具调用成功后记录，避免误判重试失败的操作
        if (!result.isError) {
          recentActions.push(actionKey);
          if (recentActions.length > cfg.loopDetectionWindow) recentActions.shift();
          if (
            recentActions.length === cfg.loopDetectionWindow &&
            recentActions.every((a) => a === recentActions[0])
          ) {
            yield { type: 'error', error: new Error(`loop detected: ${tc.name}`) };
            transitionTo('error', 'loop_detected');
            yield { type: 'state_change', from: 'running', to: 'error', reason: 'loop_detected' };
            yield { type: 'final_history', messages: [...runState.messages] };
            yield { type: 'session_end', reason: 'loop' };
            return;
          }
        }

        // 反幻觉守卫：检测失败信号（config 开关此前被忽略）
        const guardEnabled = cfg.hallucinationGuard?.enabled !== false;
        const failure = guardEnabled
          ? isFailureSignal(tc.name, tc.id, !!result.isError, result.content, failureKeywords)
          : { isError: false, toolName: tc.name, toolUseId: tc.id };
        if (failure.isError && !encounteredFailure) {
          encounteredFailure = true;
          firstFailureToolId = tc.id;
          log.warn(
            { tool: tc.name, toolUseId: tc.id, keyword: failure.matchedKeyword },
            'hallucination guard: tool failure detected'
          );
          metrics.toolCalls.inc({ tool: tc.name, status: 'hallucination_guarded' });
          metrics.hallucinationAttempts.inc({
            tool: tc.name,
            kind: failure.matchedKeyword ?? 'isError',
          });
        }

        // 二次填充审计日志（真实 exit_code / 真实结果摘要）
        const resultData = result.data as { exitCode?: unknown } | undefined;
        const exitCode =
          typeof resultData?.exitCode === 'number' ? resultData.exitCode : undefined;
        auditWrite({
          session_id: sessionId,
          trace_id: traceId,
          tool: tc.name,
          command: typeof tc.input.command === 'string' ? tc.input.command : undefined,
          host: typeof tc.input.host === 'string' ? tc.input.host : undefined,
          decision: 'allow',
          reason: result.isError ? 'tool_error' : 'executed',
          exit_code: exitCode,
          stdout_summary: result.content.slice(0, 256),
        });
      }

      // 把 tool_result 拼成 user 消息
      const resultBlocks: ContentBlock[] = toolResults.map((r) => ({
        type: 'tool_result',
        toolUseId: r.toolUseId,
        content: r.content,
        isError: r.isError,
      }));
      // 反幻觉提示必须放在 tool_result 之后（同一 user 消息），
      // 不能插在 tool_use / tool_result 之间破坏协议顺序。
      if ((encounteredFailure && firstFailureToolId) || guardHintNeeded) {
        resultBlocks.push({
          type: 'text',
          text: HALLUCINATION_GUARD_HINT,
        });
      }
      runState.messages = [...runState.messages, { role: 'user', content: resultBlocks }];
    }
  } catch (err) {
    // Phase 5: abort 触发的错误不吞掉，直接向上抛让 REPL 区分 abort vs 真实错误
    if (options.abortSignal?.aborted) {
      clearTimeout(overallTimer);
      process.removeListener('SIGUSR1', sigUsr1);
      process.removeListener('SIGUSR2', sigUsr2);
      metrics.activeSessions.dec({});
      throw err instanceof Error ? err : new Error(String(err));
    }
    const finalErr = err instanceof Error ? err : new Error(String(err));
    log.error({ err: String(err) }, 'agent run failed');
    transitionTo('error', 'unhandled');
    yield { type: 'state_change', from: runState.status, to: 'error', reason: 'unhandled' };
    yield { type: 'error', error: finalErr };
    metrics.invocations.inc({ status: 'error' });
    yield { type: 'final_history', messages: [...runState.messages] };
    yield { type: 'session_end', reason: 'error' };
  } finally {
    clearTimeout(overallTimer);
    process.removeListener('SIGUSR1', sigUsr1);
    process.removeListener('SIGUSR2', sigUsr2);
    metrics.activeSessions.dec({});
  }
}

async function executeWithRetryAndTimeout(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: Parameters<Tool['execute']>[1],
  retry: { maxAttempts: number; initialDelayMs: number; backoffFactor: number; maxDelayMs: number },
  timeoutMs: number
): Promise<ToolResult> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const mergedCtx = { ...ctx, signal: ac.signal };
      const result = await Promise.race([
        tool.execute(args, mergedCtx),
        new Promise<ToolResult>((_, reject) =>
          ac.signal.addEventListener('abort', () => reject(new ToolTimeoutError(tool.name, timeoutMs)))
        ),
      ]);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt === retry.maxAttempts) break;
      if (!isRetryable(err)) break;
      const delay = Math.min(
        retry.maxDelayMs,
        retry.initialDelayMs * Math.pow(retry.backoffFactor, attempt - 1)
      );
      log.warn({ tool: tool.name, attempt, delay, err: String(err) }, 'tool retry');
      await sleep(delay);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return { content: `error: ${msg}`, isError: true };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ToolTimeoutError) return true;
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('broken pipe')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resume 模式：从 WAL 恢复 history */
export async function loadHistory(sessionId: string): Promise<Message[]> {
  const session = Session.open(sessionId);
  const events = session.load();
  const messages: Message[] = [];
  // 同一轮的多个 tool_result 必须合并到一条 user 消息里；拆成多条
  // 连续 user 消息会破坏 provider 的 tool_use/tool_result 配对语义。
  let pendingResults: ContentBlock[] = [];
  const flushResults = () => {
    if (pendingResults.length === 0) return;
    messages.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };

  for (const e of events) {
    if (e.type === 'tool_result') {
      const d = e.data as { id: string; content: string; isError: boolean };
      pendingResults.push({
        type: 'tool_result',
        toolUseId: d.id,
        content: d.content,
        isError: d.isError,
      });
      continue;
    }

    flushResults();
    if (e.type === 'user_message') {
      const d = e.data as { text: string };
      messages.push({ role: 'user', content: d.text });
    } else if (e.type === 'assistant_message') {
      const d = e.data as {
        text: string;
        tool_uses: { id: string; name: string; input: Record<string, unknown> }[];
        stopReason: string;
      };
      const blocks: ContentBlock[] = [];
      if (d.text) blocks.push({ type: 'text', text: d.text });
      for (const tu of d.tool_uses ?? []) {
        blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
      }
      messages.push({ role: 'assistant', content: blocks });
    }
  }
  flushResults();
  return messages;
}

/** 把工具数暴露给 metrics */
export function trackToolCount(): number {
  return countToolCalls([]);
}

/**
 * Vault 集成：评估缺失字段时，尝试用 vault 注入凭证。
 *
 * 重要设计 v2：
 *  - vault 仅接管 ssh_ssh_connect（完整参数注入）。credentialPatch 包含
 *    host/port/username + password/privateKey，覆盖 SshProvider 工具的
 *    ConnectArgsSchema 必填字段（host, username, password|privateKey|privateKeyPath）。
 *  - LLM 经常只传 host（用户口述的 IP），vault 必须补全 username 等，否则
 *    zod 校验失败导致"连接失败"假象。
 *  - 对 execute / system_info / sftp_* 等工具，返回 not_applicable。
 *    auto-connect 由 resolveConnectionId 负责（解析 alias/host → 真实 connectionId）。
 *  - 如果 LLM 拼错了 connectionId，agent 会返回 isError:true，hallucination guard
 *    强制 LLM 重新建立连接。
 *
 * 返回：
 *   - { ok: true, password, privateKey, host, username, port, credentialPatch } →
 *     注入到 ssh_ssh_connect args
 *   - { ok: false, reason: 'vault_disabled' | 'not_applicable' | ... } → 走原路径
 */
export async function evaluateVaultCredentials(
  toolName: string,
  args: Record<string, unknown>,
  missingFields: string[]
): Promise<
  | {
      ok: true;
      host: string;
      username: string;
      port: number;
      authType: 'password' | 'privateKey';
      credentialPatch: Record<string, unknown>;
      alias?: string;  // Phase 2: 注入后日志显示用
    }
  | {
      ok: false;
      reason:
        | 'vault_disabled'
        | 'not_applicable'
        | 'credential_missing'
        | 'auth_failed'
        | 'host_not_found'
        | 'host_key_changed'
        | 'vault_error'
        | 'connection_denied';
      alias?: string;
      error?: string;
    }
> {
  const cfg = getConfig();
  if (!cfg.vault?.enabled) return { ok: false, reason: 'vault_disabled' };
  // v1：仅对 ssh_ssh_connect 接管。其它 ssh_* 工具需要的 connectionId 是
  // mcp-server-ssh 自己的 id，vault 不应伪造。
  if (toolName !== 'ssh_ssh_connect' && !toolName.endsWith(':ssh_ssh_connect')) {
    return { ok: false, reason: 'not_applicable' };
  }
  // Phase 2 放宽：缺 username / password / privateKey 任一认证字段都接管。
  // 不再仅以 password|privateKey 触发——LLM 经常只给 host，username 也没给。
  const authMissing = missingFields.some((f) => /username|password|privateKey/i.test(f));
  if (!authMissing) {
    return { ok: false, reason: 'not_applicable' };
  }
  // Phase 2: 优先用 args.host；缺失时回退到 hosts.md 的唯一 IP（避免再次问用户）
  let host = (args.host ?? args.hostname) as string | undefined;
  if (!host) {
    try {
      const mem = await import('./memory.js');
      const hostsContent = mem.recall('hosts');
      if (hostsContent) {
        const orphanIps = hostsContent
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => l.split('|')[0].trim())
          .filter((v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v));
        if (orphanIps.length === 1) {
          host = orphanIps[0];
          log.info(
            { fallbackHost: host, tool: toolName },
            'vault: host missing in args, falling back to unique hosts.md IP'
          );
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!host) {
    return { ok: false, reason: 'host_not_found' };
  }

  // Phase 2: 剥离尾部端口 + 大小写不敏感 + 去前后空格
  const stripPort = (s: string): string => {
    const ci = s.lastIndexOf(':');
    if (ci > 0 && /^\d{1,5}$/.test(s.slice(ci + 1))) return s.slice(0, ci);
    return s;
  };
  const norm = (s: string): string => stripPort(s).trim().toLowerCase();
  const hostKey = norm(host);

  const vault = getVaultClient();
  try {
    // 解析 alias → host/user/port/authType
    const listResult = await vault.listHosts();
    const hosts = listResult.hosts ?? [];
    const matched = hosts.find((h) => {
      const a = norm(h.alias);
      const hv = norm(h.host);
      return a === hostKey || hv === hostKey || a === norm(host) || hv === norm(host);
    });
    if (!matched) {
      metrics.vaultRedirect.inc({});
      return { ok: false, reason: 'host_not_found', alias: host };
    }
    // 从 keychain 取密码
    const secret = await vault.getCredential({ alias: matched.alias });
    if (!secret) {
      metrics.vaultRedirect.inc({});
      return {
        ok: false,
        reason: 'credential_missing',
        alias: matched.alias,
        error: 'keychain returned null',
      };
    }
    metrics.vaultAcquire.inc({ status: 'success' });
    // v2 修复：credentialPatch 必须包含 host/port/username + 凭证。
    // LLM 调 ssh_ssh_connect 时经常只传 host（用户口述的 IP），vault 需要补全
    // 完整可连接参数，否则 zod schema 的 username 校验会失败。
    const credentialPatch: Record<string, unknown> = {
      host: matched.host,
      port: matched.port,
      username: matched.user,
    };
    if (matched.authType === 'password') {
      credentialPatch.password = secret;
    } else {
      credentialPatch.privateKey = secret;
    }
    return {
      ok: true,
      host: matched.host,
      username: matched.user,
      port: matched.port,
      authType: matched.authType,
      alias: matched.alias,
      credentialPatch,
    };
  } catch (err) {
    const code = (err as { code?: number }).code;
    const msg = err instanceof Error ? err.message : String(err);
    metrics.vaultAcquire.inc({ status: 'failure' });
    if (code === VAULT_ERROR_CODES.CREDENTIAL_MISSING) {
      metrics.vaultRedirect.inc({});
      return { ok: false, reason: 'credential_missing', alias: host, error: msg };
    }
    if (code === VAULT_ERROR_CODES.AUTH_FAILED) {
      metrics.vaultRedirect.inc({});
      return { ok: false, reason: 'auth_failed', alias: host, error: msg };
    }
    if (code === VAULT_ERROR_CODES.HOST_NOT_FOUND) {
      metrics.vaultRedirect.inc({});
      return { ok: false, reason: 'host_not_found', alias: host, error: msg };
    }
    if (code === VAULT_ERROR_CODES.CONNECTION_DENIED) {
      return { ok: false, reason: 'connection_denied', alias: host, error: msg };
    }
    return { ok: false, reason: 'vault_error', error: msg };
  }
}

/**
 * v1 auto-connect 拦截器：在工具执行前，解析 LLM 传入的 connectionId。
 *
 * mcp-server-ssh 的 connectionId 是 ssh_ssh_connect 返回的 UUID/字符串。
 * 但 LLM 经常把 alias ("web1") 或 host:port ("10.0.0.1:22") 当 connectionId 用，
 * 导致后续 ssh_ssh_exec / ssh_ssh_system_info 报 "Not connected"。
 *
 * 这个拦截器在工具执行前做标准化：
 *   1. 如果 connectionId 看起来是真实 id（UUID / conn_* 形式），直接放过
 *   2. 如果 connectionId 是 alias / host:port / IP：
 *      a. 查 vault 找到 alias
 *      b. 从 keychain 取凭证
 *      c. 内部调用 ssh_ssh_connect，拿到真实 connectionId
 *      d. patch args.connectionId
 *      e. 把 alias → realCid 缓存到 runState.connectionIdCache 供后续复用
 *   3. 如果什么都查不到，返回原 args 让 mcp-server-ssh 自己报"Unknown connection"
 *
 * 注意：auto-connect 的 ssh_ssh_connect 不在 LLM 上下文中显示（silent），
 * 否则 LLM 看到两次 tool_call 会更困惑。
 */
const TOOLS_NEED_CONNECTION_ID = /^(ssh_ssh_exec|ssh_ssh_system_info|ssh_ssh_disconnect|sftp_ls|sftp_read|sftp_write|sftp_mkdir|sftp_rm|sftp_mv|sftp_stat)$/;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONN_TOKEN_LIKE = /^(conn_|connection_)?[A-Za-z0-9_-]{8,}$/;
const IP_PORT_LIKE = /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/;

export async function resolveConnectionId(
  toolName: string,
  args: Record<string, unknown>,
  cache: Map<string, string>
): Promise<{ args: Record<string, unknown>; autoConnected: boolean }> {
  if (!TOOLS_NEED_CONNECTION_ID.test(toolName)) {
    return { args, autoConnected: false };
  }
  const rawCid = args.connectionId;
  if (typeof rawCid !== 'string' || !rawCid) {
    return { args, autoConnected: false };
  }
  // 真实 id 形式：直接放过
  if (UUID_LIKE.test(rawCid) || CONN_TOKEN_LIKE.test(rawCid)) {
    return { args, autoConnected: false };
  }
  // IP:port 形式：尝试解析并自动连接
  if (IP_PORT_LIKE.test(rawCid)) {
    log.info({ tool: toolName, rawCid }, 'resolveConnectionId: detected IP:port format, will attempt auto-connect');
  }
  // 缓存命中：直接 patch
  const cached = cache.get(rawCid);
  if (cached) {
    return {
      args: { ...args, connectionId: cached },
      autoConnected: true,
    };
  }
  // 尝试从 vault 解析
  const cfg = getConfig();
  if (!cfg.vault?.enabled) {
    return { args, autoConnected: false };
  }
  const vault = getVaultClient();
  try {
    const listResult = await vault.listHosts();
    const hosts = listResult.hosts ?? [];
    // 解析 host:port
    const colonIdx = rawCid.lastIndexOf(':');
    const candidateHost = colonIdx > 0 ? rawCid.slice(0, colonIdx) : rawCid;
    const candidatePort = colonIdx > 0 ? Number(rawCid.slice(colonIdx + 1)) || 22 : 22;
    const matched = hosts.find(
      (h) =>
        h.alias === rawCid ||
        h.alias === candidateHost ||
        h.host === rawCid ||
        h.host === candidateHost
    );
    if (!matched) {
      log.info(
        { tool: toolName, rawCid, candidateHost },
        'resolveConnectionId: no vault match, will try SshProvider listConnections fallback'
      );
      // Phase 4 兜底：vault 没匹配上，但 SshProvider 进程级单例可能还持有该连接。
      // 比如 LLM 上轮用 `ssh_ssh_connect` 建了连，拿到 realCid，cache 里有。
      // 但 cache 是 runState 级，新一轮没了。我们直接查 SshProvider 的内存 map。
      try {
        const sshProv = getSshProvider();
        const allConns = sshProv.listConnections();
        const directMatch = allConns.find((c) => c.id === rawCid || c.host === candidateHost);
        if (directMatch) {
          cache.set(rawCid, directMatch.id);
          cache.set(candidateHost, directMatch.id);
          if (directMatch.id !== rawCid) {
            log.info(
              { tool: toolName, rawCid, realCid: directMatch.id, candidateHost },
              'resolveConnectionId: SshProvider listConnections fallback hit'
            );
            return {
              args: { ...args, connectionId: directMatch.id },
              autoConnected: true,
            };
          }
        }
      } catch (e) {
        log.warn({ err: String(e) }, 'resolveConnectionId: SshProvider listConnections fallback failed');
      }
      return { args, autoConnected: false };
    }
    // 取凭证
    const secret = await vault.getCredential({ alias: matched.alias });
    if (!secret) {
      log.warn({ alias: matched.alias }, 'resolveConnectionId: credential missing in keychain');
      return { args, autoConnected: false };
    }
    // 内部调用 ssh_ssh_connect
    const registry = getToolRegistry();
    const connectTool = registry.get('ssh_ssh_connect');
    const connectArgs: Record<string, unknown> = {
      host: matched.host,
      port: candidatePort === 22 ? matched.port : candidatePort,
      username: matched.user,
    };
    if (matched.authType === 'password') {
      connectArgs.password = secret;
    } else {
      connectArgs.privateKey = secret;
    }
    const result = await connectTool.execute(connectArgs, {
      sessionId: 'auto-connect',
      traceId: 'auto-connect',
      signal: new AbortController().signal,
      decision: { decision: 'allow', reason: 'auto-connect' },
    });
    if (result.isError) {
      log.warn(
        { alias: matched.alias, err: result.content.slice(0, 200) },
        'resolveConnectionId: ssh_ssh_connect failed'
      );
      return { args, autoConnected: false };
    }
    // 解析 connectionId
    const realCid = extractConnectionIdFromResult(result.content);
    if (!realCid) {
      log.warn(
        { alias: matched.alias, content: result.content.slice(0, 200) },
        'resolveConnectionId: could not extract connectionId from ssh_ssh_connect result'
      );
      return { args, autoConnected: false };
    }
    cache.set(rawCid, realCid);
    cache.set(matched.alias, realCid);
    cache.set(matched.host, realCid);
    log.info(
      { alias: matched.alias, rawCid, realCid, host: matched.host, username: matched.user },
      'resolveConnectionId: auto-connected, alias/host mapped to real connectionId'
    );
    return {
      args: { ...args, connectionId: realCid },
      autoConnected: true,
    };
  } catch (err) {
    log.warn(
      { err: String(err), rawCid },
      'resolveConnectionId: vault error during auto-connect'
    );
    return { args, autoConnected: false };
  }
}

/**
 * 从 ssh_ssh_connect 的返回内容里解析 connectionId。
 * mcp-server-ssh 的返回格式可能是 JSON 字符串或纯文本，需要兼容两种。
 */
function extractConnectionIdFromResult(content: string): string | null {
  const trimmed = content.trim();
  // 1) 纯 JSON
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === 'string' && obj.length > 0) return obj;
    if (obj && typeof obj === 'object') {
      const cid = (obj as Record<string, unknown>).connectionId
        ?? (obj as Record<string, unknown>).id
        ?? (obj as Record<string, unknown>).connection_id;
      if (typeof cid === 'string' && cid.length > 0) return cid;
    }
  } catch {
    /* not JSON */
  }
  // 2) 内嵌 connectionId 字段
  const m1 = /connectionId["'\s:]+([A-Za-z0-9_-]{8,})/i.exec(content);
  if (m1) return m1[1];
  // 3) 内嵌 id 字段
  const m2 = /["']id["']\s*:\s*["']([A-Za-z0-9_-]{8,})["']/i.exec(content);
  if (m2) return m2[1];
  return null;
}
