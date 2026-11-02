# sshops-agent 架构升级计划

> 依据：[架构审计](./architecture-audit.md)（基线 `33ece9e`）
> 目标读者：维护者、后续接手的 Agent、评审人
> 状态：P0 已随本 PR 落地；P1–P4 为待排期计划，不是已完成承诺

---

## 1. 目标与非目标

### 1.1 目标

把 sshops-agent 从“能跑的 ReAct 脚本”升级为**可评测、可恢复、可扩展的运维 Agent 运行时**：

1. **协议正确**：Anthropic 与 OpenAI 兼容后端都能完整执行多步工具循环。
2. **上下文可控**：以真实上下文窗口为预算，压缩不破坏 tool 配对，压缩结果可持久化。
3. **控制面清晰**：循环、工具执行、上下文、模型网关、持久化分层，可单测、可替换。
4. **安全默认**：所有连接/命令/凭证注入走同一条策略与审计路径；非交互模式语义明确。
5. **可度量**：任务成功率、工具错误率、token/成本、延迟、压缩效果、恢复成功率都有数据。
6. **可扩展**：新增工具、Provider、审批策略、Skills/子 Agent 不需要改主循环。

### 1.2 非目标（本阶段不做）

- 不做 Web UI / 多租户 / 团队协作（保留为 P4 生态项）。
- 不引入 LangChain/LlamaIndex 等重型框架；保留“自有控制流”。
- 不为了“多 Agent”而多 Agent：能用确定性 workflow 的运维流程优先 workflow。
- 不重写 Vault / SSH Provider：它们是资产，只做接口收敛。

---

## 2. 设计原则

1. **Own your control flow**（12-Factor Agents）：循环、预算、终止条件、审批都在仓库内，可读可测。
2. **Native tool protocol first**：能用 provider 原生 tool use / tool_choice 表达的，不用 prompt 文本标记。
3. **Context is finite**（Anthropic context engineering）：预算、压缩、检索、缓存都是显式策略，不靠“模型自己记住”。
4. **Simple composable patterns**（Anthropic Building effective agents）：workflow（固定步骤）与 agent（开放探索）分开；只在需要时增加自主性。
5. **Human-in-the-loop as a feature**：审批不是 `readline` 的副作用，而是可测试的决策与事件。
6. **Durable by default**：run 的每一步可 checkpoint，工具调用有幂等键，崩溃可恢复。
7. **Eval before feature**：每个能力先有 golden scenario，再谈“智能”。
8. **Security at the boundary**：策略在 ToolBroker 统一执行，任何旁路（auto-connect、vault 注入）都不能绕过。

---

## 3. 目标架构

```text
┌────────────────────────────────────────────────────────────────────┐
│ Adapters: CLI / REPL / (future HTTP)                               │
│   - 只负责输入、渲染、审批交互；不包含 agent 决策                   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ AgentEvent（typed, versioned）
┌──────────────────────────────▼─────────────────────────────────────┐
│ AgentRuntime                                                       │
│   - run loop / turn lifecycle / budgets / termination / fallback   │
│   - 只依赖下面四个接口，不知道具体 provider/tool/存储                │
│                                                                    │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│   │ ContextEngine│  │ ToolBroker   │  │ ModelGateway │             │
│   │ system/memory│  │ registry     │  │ providers    │             │
│   │ budget       │  │ validation   │  │ protocol     │             │
│   │ compaction   │  │ policy/HITL  │  │ retry/fallback│            │
│   │ prompt cache │  │ pool/retry   │  │ usage/cost   │             │
│   └──────────────┘  └──────────────┘  └──────────────┘             │
│                                                                    │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ RunStore: WAL / checkpoint / replay / event schema version   │ │
│   └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬─────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
   Telemetry (OTel)       Eval harness           Config (typed)
```

### 3.1 职责边界

| 组件 | 负责 | 不负责 |
|------|------|--------|
| `AgentRuntime` | 步数/时间/token 预算、终止、降级、事件顺序 | provider 细节、shell 执行、UI |
| `ContextEngine` | system 组装、记忆检索、token 预算、压缩、缓存标记 | 工具执行、权限 |
| `ToolBroker` | 工具注册/校验、策略、审批、并发、重试、超时、审计、幂等 | 业务命令语义 |
| `ModelGateway` | provider 适配、tool 协议、重试、fallback、usage | 上下文压缩策略 |
| `RunStore` | WAL、checkpoint、replay、schema 版本 | 业务状态机 |
| Adapters | 渲染、输入、审批交互 | Agent 决策 |

### 3.2 核心契约（目标态）

**ToolResult**（替代当前 `{content, data?, isError?}`）：

```ts
type ToolStatus = 'ok' | 'error' | 'denied' | 'timeout' | 'cancelled';

interface ToolResult {
  content: string;                 // 给模型看的事实
  status: ToolStatus;              // 给运行时/UI 看的语义
  data?: unknown;                  // 结构化结果
  exitCode?: number;               // 命令退出码（与 status 解耦）
  retryable?: boolean;
  truncated?: { totalBytes: number; shownBytes: number; nextCursor?: string };
  audit?: { decision: 'allow' | 'deny' | 'confirm'; rule?: string };
}
```

**RunEvent**：所有事件带 `runId / seq / ts`，schema 版本化；审批、工具、压缩、fallback 都是事件，不再由主循环直接 `yield` 字符串。

**Approval**：

```ts
type ApprovalDecision =
  | { kind: 'allow'; reason: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'need_user'; prompt: string; options?: string[] };
```

**ContextBudget**：`inputTokens = estimate(messages, system, tools)`；
`limit = floor(contextWindow * ratio) - outputReserve`；超过则 L1→L4，并持久化压缩后的状态。

---

## 4. 路线图

估算为“熟悉该仓库的 1 名工程师”的粗略工作量，用于排期，不是承诺。

### P0 — 正确性与信任（本 PR，已完成大部分）

**目标**：先让核心能力和配置“说到做到”，建立回归网。

| 工作项 | 状态 | 验收 |
|--------|------|------|
| OpenAI `tool_result` 协议修复 + 纯函数单测 | 完成 | mock 双 Provider 的 tool loop 测试通过 |
| 反幻觉提示顺序修复 | 完成 | 不再出现 `tool_use` 后直接 user 文本 |
| 上下文预算改用 `contextWindow` | 完成 | 200k 模型 8k token 不触发压缩；超预算才压缩 |
| 压缩安全边界（不拆 tool 配对） | 完成 | `findSafeCut` 单测；L3/L4 不产生孤立 tool_result |
| 模型降级链接线 | 完成 | 错误后发出 `fallback` 事件并完成本轮 |
| 非交互 vault 注入顺序 | 完成 | CI/pipe 模式可自动注入 keychain 凭证 |
| 配置 `${VAR}` 展开 + `SSHOPS_MAX_*` | 完成 | 配置单测；环境变量可覆盖；未解析占位符的启动校验留待 P0.2 |
| ESM `require` 修复 | 完成 | 编译产物 `session list` / REPL 正常 |
| 审计 exit_code 修正 | 完成 | 失败命令审计不再写成 0 |
| ESLint 9 配置 | 待办 | `npm run lint` 可执行（当前仓库无 `eslint.config.*`） |
| 一次性模式补齐 `need_input/options_menu` | 待办 | 非 TTY 下缺参数有明确输出 |

**风险**：协议修复会改变历史消息编码，旧 WAL 恢复需要兼容。当前 `loadHistory` 是 provider-neutral 的，风险可控；上线前用旧 session 做一次 resume 冒烟。

### P1 — 运行时与上下文（建议 2–3 周）

**目标**：把 `core.ts` 拆成可测试的运行时；上下文工程达到“可解释、可恢复”。

#### P1.1 提取 AgentRuntime（行为不变的重构）

- 新建 `src/agent/runtime/`：`runtime.ts`、`budget.ts`、`events.ts`、`turn.ts`。
- `core.ts` 保留为兼容入口，内部委托 runtime；`AgentEvent` 不变，避免 REPL 大改。
- 把“暂停/超时/步数/终止/fallback”从 `while(true)` 的 `continue` 站点改成显式状态转移。
- 为 runtime 增加可注入的 `Now / Clock / Random`，便于测试超时和抖动。
- 验收：事件快照测试覆盖 8 条路径（正常结束、工具链、deny、need_input、超时、步数上限、循环、fallback）。
- 风险：重构面大。策略是“先包一层、再搬逻辑、最后删旧代码”，每个 PR 保持事件兼容。

#### P1.2 ContextEngine

- 用 provider 返回的真实 `usage.input_tokens` 校准估算；记录每次请求的 `estimated vs actual` 偏差。
- 压缩结果写入 WAL（`compression` 事件带摘要与边界），`loadHistory` 能恢复压缩后的视图。
- 记忆从“全量拼接”改为“按相关性/命名空间/TTL 检索”，并限制 token 预算；hosts 保留确定性加载。
- 压缩后重新计算 tool 配对完整性；不完整则回退到上一个安全边界。
- Anthropic prompt cache 标记策略统一到 ContextEngine；OpenAI 兼容后端支持自动前缀缓存时显式开启。
- 验收：压缩前后 100% 保持 tool 配对；WAL 恢复后 token 数不反弹；单测覆盖 L1–L4 组合。

#### P1.3 ToolBroker 与并发执行

- 抽出统一执行路径：去重 → 参数校验 → 策略 → 审批 → 凭证注入 → 连接解析 → 执行 → 审计。
- 支持 `tools.concurrency.maxInFlight`：同一轮多个 `allow` 工具并行；审批/确认类串行；结果按 tool_use 顺序回灌。
- 工具结果增加 `status/exitCode/truncated/retryable`；`ssh_ssh_exec` 的非零退出码与“工具失败”分离。
- `auto-connect` 纳入 ToolBroker：hostWhitelist、审计、confirm 策略全部生效。
- 验收：并发工具测试（时序/取消/部分失败）；hostWhitelist 对 alias/IP 自动连接生效；审计每次调用一条记录。

#### P1.4 评测集（Eval harness）

- `tests/eval/`：mock LLM + 真实 ToolBroker，跑 20 个 golden scenario：
  - 单步命令、多步 connect→exec、并行探测、权限 deny、confirm、vault 注入、缺参追问、压缩后继续、fallback、abort、循环检测。
- 每个 scenario 断言：最终回答、工具调用序列、审计记录、无协议错误。
- 双 Provider 协议层用 `convertMessages()` 直接断言，不依赖网络。
- 验收：CI 中 <30s；新增失败场景必须先补 scenario 再修代码。

### P2 — 工具/交互/安全（建议 3–4 周）

**目标**：把“追问、审批、恢复、安全”从补丁变成一等能力。

- **P2.1 `ask_user` / `choose_option` 工具化**：删除 `[NEED_INPUT]` / `[OPTIONS]` 文本协议；REPL 通过结构化事件渲染；工具 schema 可校验；模型无法用代码块伪造。
- **P2.2 审批抽象**：`ApprovalProvider` 接口（CLI / CI / future UI）；支持 `--yes`、allowlist、dry-run、审批超时；非交互策略显式化。
- **P2.3 可恢复执行**：run checkpoint、工具调用幂等键、崩溃后从最后一个安全点恢复；WAL 事件 schema 版本化。
- **P2.4 安全收敛**：所有连接入口统一策略；凭证注入后不改变已审计的命令语义；敏感字段脱敏日志；审计单条记录包含最终参数摘要。
- **P2.5 一次性模式体验**：非 TTY 下 `need_input` / `options_menu` / `fallback` 有明确输出与退出码。
- 验收：安全回归集（绕过尝试、白名单、审批拒绝、审计字段）；kill -9 后 resume 成功；文本标记 grep 为 0。

### P3 — 质量与运维（建议 2–3 周）

- **P3.1 OpenTelemetry GenAI**：run/turn/tool span；token、成本、延迟直方图；trace_id 贯通 API/工具/审计。
- **P3.2 成本与预算**：单次 run 的 token/金额上限；超限降级/终止策略；按 provider/model 计价表。
- **P3.3 MCP 完整化**：resources/prompts、streamable HTTP、工具缓存失效策略、server 健康检查。
- **P3.4 回归看板**：eval 分数趋势、工具错误率、压缩触发率、fallback 率。
- 验收：能在 dashboard 回答“上周任务成功率为什么下降”；trace 可定位到具体工具与 provider 请求。

### P4 — 扩展与生态（按需）

- Skills / 子 Agent：按任务隔离上下文；子 Agent 只返回结论与证据引用，不回传全部中间消息。
- 插件 SDK：第三方工具/Provider/审批渠道；版本化 manifest。
- 多租户 / 团队 vault / Web UI / 通知渠道（Slack/飞书/钉钉）。
- 验收：新增一个 Provider 或工具不改主循环；插件有契约测试。

---

## 5. 评测与指标

### 5.1 Golden scenarios（P1 必须落地）

| 场景 | 关键断言 |
|------|----------|
| 单步执行 | tool_call 1 次；最终回答引用真实输出 |
| 多步 connect → exec | connectionId 来自真实 connect；无伪造 |
| 并行探测 | 同轮多 tool_use 都执行；结果顺序稳定 |
| 权限 deny | 不执行；审计有 deny；模型收到拒绝 |
| confirm 拒绝 | 不执行；无副作用 |
| vault 注入（交互/非交互） | 模型从未看到密码；工具收到凭证 |
| 缺参 | 产生结构化追问，不继续下游工具 |
| 压缩后继续 | 历史保留关键事实；tool 配对完整 |
| fallback | 主模型错误后切到备模型并完成 |
| abort | 立即停止；无悬挂工具 |
| 循环检测 | 相同动作 3 次终止并给出原因 |

### 5.2 指标

- **任务成功率**：golden scenarios 通过率（目标 ≥ 95%）。
- **协议错误率**：provider 400/消息顺序错误（目标 0）。
- **工具错误率**：按工具/错误类型分桶；区分命令退出码与传输错误。
- **上下文效率**：tokens/task、压缩触发率、压缩后事实保留率。
- **成本**：按 provider/model 的 input/output token 与金额。
- **延迟**：LLM 首 token、工具 p50/p95、run 总时长。
- **恢复**：kill -9 后 resume 成功率（目标 ≥ 99%）。
- **安全**：策略旁路事件 0；审计覆盖率 100%。

---

## 6. 迁移与兼容

1. **事件契约**：`AgentEvent` 保持向后兼容；新增字段可选；破坏性变更走 `schemaVersion`。
2. **WAL**：新旧事件并存；`loadHistory` 对未知事件跳过并记录；压缩事件增加 `afterTokens/beforeTokens`。
3. **配置**：新增 `contextWindow` 已有默认值；旧配置无需迁移；未识别的旧开关在 P1 标记 deprecated 并在 `config show` 中提示。
4. **Provider**：先修协议再加能力；跨 Provider fallback 需要显式配置，默认关闭，避免行为突变。
5. **CLI**：P0/P1 不改命令与事件渲染；P2 的 `ask_user` 工具化会改 REPL 内部事件，但保持用户可见流程一致。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Provider 协议差异（流式 tool_calls、usage、stop_reason） | 工具循环中断 | 纯函数协议层 + 双 Provider contract test；不依赖真实网络 |
| 压缩丢关键事实 | 模型误判/重复操作 | 压缩后事实保留断言；关键事实白名单（命令、错误码、IP） |
| 权限重构引入绕过 | 安全事故 | 所有执行收敛到 ToolBroker；安全回归集；审计单条记录 |
| WAL 迁移破坏 resume | 历史会话不可用 | schema 版本 + 向后兼容读取；旧 session 冒烟 |
| 范围膨胀 | 长期不交付 | 每阶段有退出标准；P0/P1 先交付可测收益 |
| 多 Agent 过度设计 | 成本和复杂度上升 | 默认单 Agent；子 Agent 仅在上下文隔离有明确收益时引入 |

---

## 8. 决策记录（ADR 摘要）

- **ADR-1：原生 tool protocol 替代文本标记。**
  理由：可校验、可评测、跨 Provider 一致；代价：REPL/事件层需要改。
- **ADR-2：上下文预算以 `contextWindow` 为准，输出预留单独扣除。**
  理由：`maxTokens` 是输出上限，不是窗口；已由 P0 修复。
- **ADR-3：保留自有运行时，不引入 Agent 框架。**
  理由：运维场景需要精确控制权限、审批、审计、恢复；框架抽象会遮挡这些边界。
- **ADR-4：ToolBroker 是唯一执行入口。**
  理由：消除 auto-connect/vault/权限的旁路；代价：需要统一 ToolResult 语义。
- **ADR-5：评测优先，mock provider 为主。**
  理由：CI 不能依赖真实 LLM/SSH；协议与循环用 mock 即可覆盖大部分回归。

---

## 9. 近期可执行的下一个 PR

1. **PR-P1.1**：提取 `AgentRuntime` 骨架，`core.ts` 委托，事件快照测试。
2. **PR-P1.2**：`ToolBroker` + 并行执行 + 统一 `ToolResult`，先保留旧字段兼容。
3. **PR-P1.3**：压缩结果持久化 + `loadHistory` 恢复压缩视图 + 评测集。
4. **PR-P0.2**：ESLint 配置 + 一次性模式事件补齐 + 审计单条记录。

每个 PR 的 Definition of Done：

- `npm run typecheck` / `npm test` / `npm run build` 通过；
- 新增/修改行为有对应测试；
- 事件/配置/WAL 兼容性说明；
- 不引入未经测过的 provider 协议假设；
- 文档（本文件或 README）同步。

---

## 10. 参考

- Anthropic, *Building effective agents*: <https://www.anthropic.com/engineering/building-effective-agents>
- Anthropic, *Effective context engineering for AI agents*: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- OpenAI, *A practical guide to building agents*: <https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf>
- HumanLayer, *12-Factor Agents*: <https://github.com/humanlayer/12-factor-agents>
- Model Context Protocol specification: <https://modelcontextprotocol.io/specification/2025-06-18>
- OpenTelemetry GenAI semantic conventions: <https://opentelemetry.io/docs/specs/semconv/gen-ai/>
