# sshops-agent 架构审计与差距分析

> 审计基线：`33ece9e`（master）
> 审计时间：2026-11
> 范围：`src/` 约 12.5k 行 TypeScript、`config/` 默认配置、`tests/unit/` 全部用例
> 方法：逐模块静态阅读、调用链追踪、类型检查、单测、`npm run build`、编译产物 CLI 冒烟
> 关联文档：[升级计划](./upgrade-plan.md)

本文回答三个问题：**现在是什么架构、哪里不符合当前 Agent 工程规范、先改什么**。
审计按“事实 → 影响 → 处理状态”记录，避免只给结论。

---

## 1. 结论摘要

1. **这不是一个玩具项目。** Vault、SSH Provider、命令级权限、WAL、四级压缩、MCP 适配、Prometheus 指标都有真实实现，测试覆盖 190 个用例，工程质量高于多数同类项目。
2. **但运行时仍是“单文件 ReAct 循环 + prompt 约定协议”的形态。** 约 1270 行的 `src/agent/core.ts` 同时承担控制流、权限、降级、持久化、UI 事件、反幻觉和 SSH 业务补丁；工具协议依赖 `[NEED_INPUT:...]` / `[OPTIONS:...]` 文本标记；配置里存在大量“写了但没接线”的开关。
3. **存在会让核心能力直接不可用的 P0 缺陷。** 最严重的是 OpenAI 兼容 Provider 在消息转换时**丢弃全部 `tool_result`**，导致 DeepSeek / Ollama / vLLM / OneAPI 等 OpenAI 兼容后端的工具循环根本看不到工具结果；上下文压缩又把输出上限当上下文窗口，200k 窗口模型会被过早压缩。
4. **升级的正确方向不是“再加功能”，而是把控制面做薄、把协议做真。** 先修协议与预算，再拆运行时、做可恢复执行和评测，最后才是规划、子 Agent、Skills 等上层能力。

### 1.1 维度评分（5 分制）

| 维度 | 现状 | 目标 | 说明 |
|------|------|------|------|
| 模型接入 | 2.5 | 4.5 | 双 Provider 抽象存在，但 OpenAI 工具协议错误、跨 Provider 降级缺失 |
| 工具协议 | 2.0 | 4.5 | 原生 tool use 只做了一半，追问/菜单靠文本标记 |
| 控制循环 | 1.5 | 4.0 | 单文件 1200+ 行、7 个 `continue` 站点，难以单测和扩展 |
| 上下文工程 | 2.5 | 4.5 | 四级压缩有想法，但预算口径错误、边界不安全、L2 基本失效 |
| 安全/HITL | 3.5 | 4.5 | 黑名单/确认/审计/vault 是强项，但 auto-connect 绕过策略、非交互顺序错误 |
| 持久化/恢复 | 2.0 | 4.5 | 有 WAL，但不是可恢复执行；压缩结果不落盘 |
| 可观测/评测 | 2.0 | 4.0 | 有指标和结构化日志，无 span、无延迟直方图、无回归评测集 |
| 可扩展性 | 2.5 | 4.5 | MCP adapter 存在，但无 Skills、无子 Agent、无 MCP resources/prompts |

---

## 2. 现状架构

```text
CLI (commander) / REPL
        │  AsyncGenerator<AgentEvent>
        ▼
src/agent/core.ts  ── 约 1270 行主循环（7 个 continue 站点）
  ├── SYSTEM_PROMPT（约 100 行，含大量业务补丁）
  ├── 权限：evaluateToolCall + confirmAction + auditWrite
  ├── Vault：evaluateVaultCredentials（仅在 ssh_ssh_connect 缺字段时）
  ├── Auto-connect：resolveConnectionId（alias/IP → connectionId）
  ├── LLM：getLLMClient().chat()
  ├── 压缩：compress()（L1→L4，每轮调用）
  ├── 反幻觉：[NEED_INPUT]/[OPTIONS] 文本解析 + 失败关键词
  ├── 持久化：Session.append()（每个事件 fsync）
  └── 事件：text/tool_call/tool_result/final/...
        │
        ├── src/llm/providers/anthropic.ts
        ├── src/llm/providers/openai-compatible.ts
        ├── src/tools/{local,ssh,mcp}
        ├── src/permissions/{enforcer,audit,prompt}
        ├── src/session/wal.ts
        ├── src/agent/compressor.ts
        └── src/observability/{logging,metrics,tracer}
```

### 2.1 一次 run 的实际路径

1. `run()` 组装 `runState.messages`，把用户输入追加为 `user` 消息。
2. 进入 `while (true)`：暂停信号 → 整体超时 → 步数上限 → `compress()` → 构建 tools/system → 调 LLM。
3. LLM 流式返回 `text_delta` / `tool_use_*` / `message_end`；主循环把 assistant 文本和 tool_use 写回历史。
4. 解析文本中的 `[NEED_INPUT:...]` / `[OPTIONS:...]`。
5. 串行处理每个 `tool_use`：去重 → 权限 → vault/confirm → auto-connect → 执行（重试+超时）→ 审计 → 循环检测/反幻觉。
6. 把全部 `tool_result` 拼成一条 `user` 消息回灌，继续下一轮；`end_turn` 时结束。

这条路径能跑通 Anthropic 的“顺利场景”，但把很多本属于运行时的职责塞进了一个函数。

---

## 3. 应该保留的资产

升级不是重写。以下设计值得保留并作为目标架构的基础：

- **Vault 独立进程 + keychain**：密码不进入 LLM 上下文，这是产品最核心的安全卖点。
- **自研 SSH Provider**：绕开 `mcp-server-ssh` 冷启动，连接池和会话复用都正确。
- **命令级权限 + JSONL 审计**：黑名单、confirm、hostWhitelist 的组合是运维场景的正确方向。
- **WAL**：每个事件先落盘再返回，恢复语义有基础。
- **压缩分级思路**：Snip / Microcompact / Collapse / Autocompact 的方向对，具体实现需要重做。
- **Provider 抽象**：流式事件模型已经 provider-neutral，补协议细节即可。
- **指标与结构化日志**：`agent_tool_calls_total` 等指标已经能支撑基本运维。
- **测试习惯**：190 个单元测试覆盖 vault、权限、压缩、WAL、MCP，这是后续重构的安全网。

---

## 4. 关键发现

状态说明：`已修复` = 本 PR 已处理；`待办` = 进入升级计划；`长期` = 架构级重构。

### 4.1 P0（核心能力不可用 / 数据错误）

| ID | 状态 | 发现 | 证据 | 影响 |
|----|------|------|------|------|
| F-01 | 已修复 | OpenAI 兼容消息转换丢弃 `tool_result` | 旧 `openai-compatible.ts#convertMessage()` 对 `role=user` 只保留 `text` block | DeepSeek/Ollama/vLLM/OneAPI 等后端永远看不到工具输出，多步循环不可用 |
| F-02 | 已修复 | 反幻觉提示插在 `tool_use` 与 `tool_result` 之间 | `core.ts` 解析 `[NEED_INPUT]` 后立即追加一条 `user` 消息 | Anthropic 拒绝 tool_use 无 tool_result；OpenAI 拒绝 tool 消息前出现 user |
| F-03 | 已修复 | 上下文预算用 `maxTokens`（输出上限）冒充窗口 | 旧 `compressor.ts#shouldAutocompact()` 用 `tokens / maxTokens` | 200k 窗口模型在 ~7k token 就被压缩；完全忽略 system/tools |
| F-04 | 已修复 | 非交互模式先 deny，vault 永远没机会注入 | `core.ts` confirm 分支首先判断 `nonInteractive` | CI/pipe 模式下即使 keychain 有凭证也连不上 |
| F-05 | 已修复 | Anthropic 上压缩指令被丢弃 | `summarize()` 把 system 作为普通 `role=system` 消息发送，Anthropic provider 过滤该角色 | 摘要质量不可控，L3/L4 在 Anthropic 上实际没有指令 |

### 4.2 P1（正确性 / 可靠性 / 安全）

| ID | 状态 | 发现 | 证据 | 影响 |
|----|------|------|------|------|
| F-06 | 已修复 | 模型降级链是死配置 | `factory.fallbackToNext()` 无调用方；`fallback` 事件从未发出 | README 承诺的降级链不存在，provider 重试耗尽即熔断。现在接线并在每个 run 开始时恢复主模型 |
| F-07 | 已修复 | 压缩可能拆散 tool_use/tool_result | L3 取 `max(foldIdx)+2`，L4 直接 `slice(-keepLast)` | 恢复/压缩后请求 400，或模型看到孤立工具结果 |
| F-08 | 已修复 | YAML `${VAR}` 不展开、未解析 key 静默通过 | `providers.yaml` 的 `${ANTHROPIC_API_KEY}` 被当字面量 | 设置环境变量不生效；缺 key 时报 401 难定位。现在展开占位符，并在 `loadAndValidate` / `getLLMClient` 对未解析 key 直接报 ConfigError |
| F-09 | 已修复 | README 承诺的 `SSHOPS_MAX_*` 环境变量未实现 | loader 只处理 `LLM_*` / 日志 / profile | 运维无法通过环境变量调整步数、超时 |
| F-10 | 待办 | 文本标记协议脆弱 | `parseNeedInputMarker` / `parseOptionsMenuMarker` 正则解析自然语言 | 模型可能伪造标记、在代码块里误触发；无法 schema 校验 |
| F-11 | 待办 | auto-connect 绕过权限与审计 | `resolveConnectionId()` 直接 `connectTool.execute(..., decision: allow)` | alias/IP 自动连接不受 hostWhitelist / confirm / audit 约束 |
| F-12 | 待办 | `ssh_ssh_exec` 把非零退出码当工具失败 | `src/ssh/registry.ts` `isError: exitCode !== 0` | `grep` 无匹配、`test` 返回 1 等正常语义被当成错误，反幻觉守卫误触发 |
| F-13 | 待办 | 反幻觉靠关键词匹配 | `isFailureSignal()` 在任意输出里找 `permission denied` 等 | 日志内容、文件内容里的关键词会误报，逼迫模型追问 |
| F-14 | 待办 | WAL 不是“可恢复执行” | `loadHistory()` 只回放消息；`compression` 事件被忽略；无 session_start/end | 压缩结果不持久化，恢复后上下文重新膨胀；崩溃点可能在工具调用中间 |
| F-15 | 待办 | 内存全量注入 system prompt | `allMemoryAsContext()` 拼接所有 `sessions/memory/*.md` | 记忆越多 token 越贵，且没有相关性/权限/TTL 过滤 |
| F-16 | 待办 | 工具串行执行 | `pendingTools` 逐个 `await`；`tools.concurrency.maxInFlight` 未使用 | 多个独立探测/读操作延迟叠加 |
| F-17 | 待办 | 一次性模式忽略交互事件 | `root.ts#runOnce()` switch 无 `need_input` / `options_menu` | 非 TTY 场景下缺少参数时用户看不到提示 |
| F-18 | 待办 | 压缩 L2 实际接近死代码 | 只合并“连续且相同 toolUseId”的结果，而每个 tool_use 只有一个 result | `microcompactMinRun` 配置没有实际效果 |
| F-19 | 待办 | 跨 Provider 降级缺失 | `fallback` 按 active provider 类型建链 | Anthropic 挂了不能降级到 OpenAI 兼容后端 |
| F-20 | 待办 | `tool_choice` 未用于主循环 | ChatOptions 已支持，但 `core.ts` 从不设置 | 模型可能只输出文本不调工具；首轮无法强制“先探测” |

### 4.3 P2（工程体验 / 可观测 / 可维护性）

| ID | 状态 | 发现 | 证据 | 影响 |
|----|------|------|------|------|
| F-21 | 已修复 | ESM 项目里使用 `require()` | `session/wal.ts#listSessions`、`cli/repl.ts#printBanner`、`observability/logging.ts` | `session list` / REPL banner / REPL 日志在不同运行方式下抛 ReferenceError 或被静默吞掉 |
| F-22 | 已修复 | 审计第二条记录硬编码 `exit_code: 0` | `core.ts` 二次 `auditWrite` | 失败命令在审计里显示成功 |
| F-23 | 待办 | 同一次工具调用写两条审计（决策 + 执行），且 host/args 可能已被 vault/auto-connect 修改 | `core.ts` 两处 `auditWrite` | 审计语义不清晰，难以做合规报表 |
| F-24 | 待办 | 大量配置项无消费者 | `providers.streaming`、`agent.maxTurns`、`circuitBreaker.cooldownSeconds`、`optionsMenu.preferMenuFor`、`compression.summarizerModel`、`tools.concurrency.maxInFlight` | 用户以为改配置有效，实际无行为变化 |
| F-25 | 待办 | 监控缺延迟/成本/上下文指标 | `tracer.ts` 只生成 ID；metrics 无 histogram | 无法回答“慢在哪、贵在哪、压缩是否有效” |
| F-26 | 部分 | 无 scenario 评测集 | 原 190 个单测偏纯函数；本 PR 新增 loop 级 mock 测试，但缺少覆盖双 Provider 的 golden scenario 集 | F-01 这类错误此前无法被发现；后续需要系统化评测 |
| F-27 | 待办 | 单文件 约 1270 行主循环 | `core.ts` 同时承担 7 类职责 | 任何改动都需理解全部上下文，review/测试成本高 |
| F-28 | 待办 | 工具结果语义扁平 | 统一 `content: string`，无结构化 `exitCode`/`truncated`/`retryable` | 模型和 UI 都只能猜；截断后无法继续取数 |
| F-29 | 待办 | `npm run lint` 不可用 | 仓库无 `eslint.config.*`，ESLint 9 直接报错 | CI/贡献者无法执行 README 中的 lint 步骤 |

---

## 5. 与当前主流 Agent 工程规范的差距

这里的“规范”不是某一篇 RFC，而是 2024–2025 年形成行业共识的几组实践：
Anthropic 的 *Building effective agents* / *Effective context engineering*、OpenAI 的
*A practical guide to building agents*、12-Factor Agents、MCP 规范、OpenTelemetry GenAI 语义约定。
具体链接见文末。

| 规范要求 | 当前实现 | 差距 / 优先级 |
|----------|----------|----------------|
| 优先使用最简单的可组合模式，工作流与 Agent 分开 | 所有场景都走同一个开放式 ReAct 循环 | P1：把“确定性运维流程”和“开放式排障”分成 workflow / agent 两条路径 |
| 原生 tool use，工具结果是结构化 observation | 原生 tool use 有，但追问/菜单靠文本标记，结果统一字符串 | P0/P1：`ask_user` 工具化、工具结果增加 `isError/exitCode/truncated/retryable` |
| 上下文是有限资源：预算、压缩、按需检索 | 有压缩，但预算口径错误、记忆全量注入、压缩结果不落盘 | P0：预算已修；P1：持久化压缩 + 记忆检索 |
| 显式控制流、可暂停/恢复、状态可重放 | 有 WAL，但恢复只回放消息，不是可恢复执行 | P1：checkpoint + 工具幂等 + 断点恢复 |
| 小而专注的 Agent / 子 Agent 隔离上下文 | 单 Agent、单循环、单 system prompt | P2：子 Agent/技能框架，按任务隔离上下文 |
| 人类在环（approval）是一等公民 | `confirmAction()` 直接读 stdin，耦合在主循环 | P2：审批抽象成事件/工具，支持审批策略、dry-run、UI 适配 |
| 可观测性：trace/span、token/成本、工具延迟 | 有 metrics 与日志，无 span/histogram | P2：OTel GenAI span + 延迟直方图 |
| 评测优先：golden trajectories、回归集 | 无 | P1：先补 mock LLM 的 loop 测试（本 PR 已开始） |
| 安全边界：策略在所有入口生效 | auto-connect 旁路策略/审计 | P1：统一 ToolBroker，所有连接走策略与审计 |
| MCP：工具/资源/提示词、传输解耦 | 只有 stdio tools 适配 | P2：resources/prompts、streamable HTTP |
| Provider 可替换、能力差异显式化 | 抽象存在，但 OpenAI 协议错误、无能力矩阵 | P0：协议已修；P1：能力矩阵 + 跨 Provider 降级 |

---

## 6. 根因分析

1. **Prompt 当协议用。** `[NEED_INPUT]` / `[OPTIONS]` 让模型用自然语言输出结构化意图，短期省事，长期不可校验、不可评测、不可扩展。
2. **单文件控制面。** 权限、vault、auto-connect、压缩、UI 事件全部写在 `core.ts`，导致“改一处要读全文件”，也让 loop 级测试无法编写。
3. **配置先于接线。** README/配置里承诺的 fallback、env override、streaming、cooldown 等没有消费者；没有“配置项必须有测试”的约束。
4. **Provider 覆盖偏科。** 默认 Anthropic，OpenAI 兼容路径缺少 golden test，F-01 才能长期存在。
5. **功能以补丁叠加。** auto-connect、keyword guard、vault 注入顺序都是“先解决线上问题”，没有回到抽象层收敛。
6. **没有评测闭环。** 单元测试验证纯函数，却不验证“一次完整的 tool loop 在两种 Provider 下都能跑通”。

---

## 7. 本 PR 的处理范围与验证

已处理：F-01 ~ F-09、F-21、F-22（见上表），并补充：
- OpenAI 消息协议纯函数 `openai-messages.ts` 与单测；
- 上下文预算模块 `context-budget.ts` 与安全折叠边界；
- 模型降级链接线与 loop 级 mock 测试；
- 配置占位符/环境变量覆盖测试；
- 非交互 vault 注入顺序测试；
- `docs/upgrade-plan.md` 中 P0–P4 路线图。

验证结果：

```text
npm run typecheck  通过
npm test           33 个测试文件 / 221 个用例通过
npm run build      通过
ANTHROPIC_API_KEY=sk-test node dist/main.js config validate    config OK
node dist/main.js session list       正常输出
node dist/main.js -i                 正常启动并显示 15 个工具
```

未处理的部分（P1–P4）在 [升级计划](./upgrade-plan.md) 中给出拆分、验收标准与风险。

---

## 8. 参考

- Anthropic, *Building effective agents*: <https://www.anthropic.com/engineering/building-effective-agents>
- Anthropic, *Effective context engineering for AI agents*: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- OpenAI, *A practical guide to building agents*: <https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf>
- HumanLayer, *12-Factor Agents*: <https://github.com/humanlayer/12-factor-agents>
- Model Context Protocol specification: <https://modelcontextprotocol.io/specification/2025-06-18>
- OpenTelemetry GenAI semantic conventions: <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
