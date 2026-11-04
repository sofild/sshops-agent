<div align="center">

# sshops-agent

**让线上服务器运维说人话：一句自然语言，完成环境搭建、应用部署、日常监控。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](./tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple.svg)](https://modelcontextprotocol.io)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20macos%20%7C%20linux-lightgrey.svg)](#平台支持)

[English](./README.en.md) · [快速开始](#快速开始) · [架构](#架构) · [凭证安全](#凭证安全-vault) · [贡献](#贡献)

</div>

---

## 这是什么

`sshops-agent` 是一个面向线上服务器运维场景的 **AI Agent**：你用一句自然语言告诉它要做什么（部署 nginx、查磁盘、看日志、重启服务……），它会自己规划、调用 SSH/SFTP 工具执行、复核结果、把关键步骤展示给你确认。

它不是又一个 SSH 客户端的 LLM 包装，也不是把 shell 翻译成 prompt 的玩具。它在生产场景里把"模型能不能干运维"这件事拆成了 7 个工程问题，逐个解决：

| 问题 | 解决方案 |
|------|----------|
| 模型幻觉，自称执行成功 | 反幻觉守卫 + `isError` 透传 + 必填字段校验 |
| 密码进入 LLM 上下文 | 独立 vault 守护进程 + 系统 keychain，agent 只见 `connectionId` |
| 危险命令被 LLM 直接跑 | 硬黑名单 + 高危二次确认 + 主机白名单 + 审计 |
| 多轮 LLM 失忆 | WAL 会话持久化 + 完整多模态历史回灌 |
| 上下文爆炸 | Snip → Microcompact → Context-Collapse → Autocompact 四级管道 |
| 工具反复失败 | 熔断器 + 模型降级链 + 循环检测 |
| 不同 LLM 切换 | Provider 抽象层，Anthropic / OpenAI 兼容（含 vLLM / Ollama / DeepSeek）热切换 |

## 特性一览

- **一句话运维** — `sshops-agent "在 192.168.1.10 上安装 nginx 并启动"`
- **多 LLM 适配** — 内置 Anthropic Claude 与 OpenAI 兼容 Provider（vLLM / Ollama / DeepSeek 自建代理），配置文件热切换
- **自研 SSH Provider** — 直接用 `ssh2` 库走连接池，避免 `mcp-server-ssh` 冷启动 60-120s 的痛点
- **凭证安全 Vault (v1)** — SSH 凭证经由独立 vault 守护进程 + 系统 keychain 存储，agent 永远拿不到明文密码
- **命令级权限** — 危险命令硬黑名单 + 高危操作二次确认 + 主机白名单 + JSONL 审计
- **可恢复会话** — WAL 写入 `sessions/<id>.jsonl`，异常退出可 `--resume` 继续
- **反幻觉机制** — 失败关键词守卫 + 必填字段校验 + 可选项菜单追问，强制 LLM 失败时向用户请求补充
- **上下文压缩** — Snip → Microcompact → Context-Collapse → Autocompact 四级管道
- **可观测性** — `pino` 结构化日志 + `prom-client` Prometheus 指标
- **交互 REPL** — 多轮对话 + 完整消息历史 + 自动恢复上次会话

## 快速开始

### 前置要求

- **Node.js ≥ 18**（推荐 20 LTS）
- **OpenSSH 客户端**（Windows 10+ 自带；macOS/Linux 默认有）
- **可用的 LLM API Key**（Anthropic / OpenAI / 任何 OpenAI 兼容代理）

### 安装

```bash
git clone https://github.com/sofild/sshops-agent.git
cd sshops-agent
npm install
cp .env.example .env
# 编辑 .env，至少填入 LLM_API_KEY
npm run build
npm link            # 全局注册 sshops-agent 命令
```

> 改动了 `bin` 入口后若行为异常，重新执行 `npm link`。
> 卸载：`npm unlink -g sshops-agent`

### 第一次运行

#### 1. 自检

```bash
sshops-agent doctor
```

`doctor` 会检查 Node 版本、OpenSSH 可用、配置文件加载、LLM 联通性等。

#### 2. 单次任务

```bash
sshops-agent "在 192.168.1.10 上安装 nginx 并启动"
```

#### 3. 交互模式

```bash
sshops-agent -i
> 在 web-01 上检查磁盘
> [回车等待结果]
> /exit
```

`/exit` 后下次 `sshops-agent -i` 会自动恢复上次会话（从 `sessions/.last-session-id` 读取）。

#### 4. 启用 Prometheus 指标

```bash
sshops-agent --metrics-port 9090 "检查服务器状态"
# 另一个终端
curl http://localhost:9090/metrics
```

## 配置

`sshops-agent` 在 `config/` 目录下读取 4 个 YAML 文件：

| 文件 | 作用 |
|------|------|
| `providers.yaml` | LLM Provider 配置（`active` 字段切换默认） |
| `agent.yaml` | Agent 行为（步数、超时、压缩阈值、反幻觉守卫、熔断、降级链） |
| `permissions.yaml` | 命令级权限（deny / confirm / hostWhitelist / 必填字段 / 审计） |
| `tools.yaml` | 工具配置（本地工具 + 自研 SSH Provider + MCP Servers） |
| `vault.yaml` | 凭证 Vault（启用、二进制、审计） |

### 命令行子命令

```bash
sshops-agent "..."                  # 单次任务
sshops-agent -i                     # 交互模式
sshops-agent --metrics-port 9090    # 启用 Prometheus
sshops-agent --resume <id>          # 恢复会话
sshops-agent doctor                 # 环境自检
sshops-agent config validate        # 配置校验
sshops-agent config show            # 显示脱敏配置
sshops-agent session list           # 列出会话
sshops-agent session show <id>      # 查看会话
sshops-agent vault set <alias>      # 录入主机凭证
sshops-agent vault rotate <alias>   # 轮换凭证
sshops-agent vault audit 100        # 查看最近 100 条 vault 审计
```

## 凭证安全 (Vault)

> 这是本项目最关键的设计：**SSH 明文密码永远不进入 LLM 上下文。**

```
┌──────────────┐  IPC (JSON over stdio)  ┌────────────────┐
│  sshops-agent│ ───────────────────────▶│  sshops-vault  │
│  (LLM 进程)  │ ◀───── connectionId ────│  (独立进程)     │
└──────┬───────┘                          └────────┬───────┘
       │                                          │
       │ ssh2 直连 (无密码字段)                  │ 读
       ▼                                          ▼
   远端服务器                            OS Keychain (DPAPI / Keychain / libsecret)
                                         或 ~/.sshops/secrets/*.enc (PBKDF2+AES-GCM fallback)
```

**工作流**：
1. 用户：`sshops-agent vault set web1`，输入主机 + 密码 → vault 写入 keychain
2. LLM 调用 `ssh_ssh_connect({ host: "web1" })`（**只传 host**）
3. agent 内部：检测到缺认证 → 通过 IPC 让 vault 查 keychain → 注入 `{ host, port, username, password }` 到 `ssh2`
4. LLM 拿到的工具结果**只有 `connectionId: "web1:22"`**，从未见过密码

**好处**：
- LLM 服务商即使保留日志，也不会接触到你的服务器密码
- 审计日志里**绝不**记录 password/privateKey 字段（`src/vault/audit.ts` 严格剔除）
- 旋转密码无需改代码：`sshops-agent vault rotate web1`

## 权限模型

默认策略见 [config/permissions.yaml](./config/permissions.yaml)。

### 硬黑名单 `deny`（直接拒绝）

- `rm -rf /`、`shutdown`、`reboot`、`halt`、`poweroff`
- `mkfs`、`dd if=`、`fdisk`、`format`
- Fork 炸弹 `:(){ :|:& };:`
- `chmod -R 777 /`、`>/dev/sda`
- `curl * | bash`、`wget * | bash`

### 高危 `confirm`（用户输入 y 才继续）

- `rm -rf`、`chmod -R`、`chown -R`
- `iptables -F`、`userdel`、`kill -9 1`
- `systemctl stop/disable`、`service * stop`
- `DROP TABLE`、`TRUNCATE`、`DELETE FROM`
- `kubectl delete namespace`、`docker system prune`

**非交互模式**（pipe / CI）默认拒绝 confirm 级命令。

### 主机白名单

`config/permissions.yaml` 的 `hostWhitelist` 支持精确匹配和 CIDR：

```yaml
hostWhitelist:
  - 192.168.1.10
  - 10.0.0.0/24
  - prod-web-*.example.com
```

留空表示不限制。

## 审计日志

每次工具调用（含 deny）都会写入 `logs/audit-YYYY-MM-DD.jsonl`：

```json
{"timestamp":"2026-06-03T...","session_id":"...","trace_id":"...","user":"...","tool":"ssh_ssh_execute","host":"1.2.3.4","command":"systemctl stop nginx","decision":"confirm","reason":"matched confirm rule: systemctl stop"}
```

Vault 独立审计写入 `~/.sshops/vault-audit.jsonl`，适合接入 SIEM。

## 反幻觉与追问机制

`sshops-agent` 强制约束 LLM 不得杜撰工具结果。完整机制：

1. **`isError` 真实透传** — MCP adapter 把 `result.isError` 原样映射到 `ToolResult.isError`，LLM 看到工具失败会得到明确信号。
2. **失败关键词守卫** — `config/agent.yaml` 的 `hallucinationGuard.failureKeywords` 默认包含 `No authentication method`、`permission denied` 等；匹配到的工具返回会被标记为"幻觉可疑"，强制 LLM 在下一轮以 `[NEED_INPUT:field1|field2]` 标记向用户追问。
3. **必填字段校验** — `config/permissions.yaml` 的 `requiredFields` 定义每个工具的必填参数。缺一即触发 `need_input` 事件，REPL 直接渲染输入提示。
4. **可选项菜单**（多选一）— 当 LLM 无法确定目标主机/用户时，吐出 `[OPTIONS:field|val1=label1,val2=label2]` 标记，REPL 渲染 1-N 菜单供用户选。

### 配置主机清单（options menu 数据源）

`sessions/memory/hosts.md`（每行一台主机）：

```markdown
# ip | label | description
10.222.10.21 | root@web-01 | nginx running
10.222.10.22 | root@db-01  | postgres 15
10.222.10.23 | root@app-01 | node 20
```

用户在 REPL 输入"连那台 web 服务器"时，agent 会列出上述候选并询问。

## 架构

```
src/
├── main.ts              # 入口
├── cli/                 # CLI 入口与子命令
│   ├── root.ts          # commander 主程序
│   ├── doctor.ts        # 环境自检
│   └── repl.ts          # 交互模式
├── agent/               # Agent 核心
│   ├── core.ts          # 主循环（7 个 continue 站点）
│   ├── compressor.ts    # 四级上下文压缩
│   └── memory.ts        # 跨会话记忆
├── llm/                 # LLM 抽象
│   ├── types.ts
│   ├── factory.ts
│   └── providers/
│       ├── anthropic.ts
│       └── openai-compatible.ts
├── tools/               # 工具系统
│   ├── registry.ts
│   ├── bootstrap.ts
│   ├── mcp/             # MCP 客户端
│   └── local/           # 本地工具
├── permissions/         # 权限与安全
│   ├── enforcer.ts
│   ├── audit.ts
│   └── prompt.ts
├── session/             # 会话持久化
│   └── wal.ts
├── ssh/                 # 自研 SSH Provider（替代 mcp-server-ssh）
│   ├── provider.ts
│   └── registry.ts
├── vault/               # 凭证 Vault 客户端
│   ├── client.ts
│   ├── daemon.ts
│   ├── keychain.ts
│   └── ...
├── observability/       # 可观测性
│   ├── logging.ts
│   ├── metrics.ts
│   └── tracer.ts
├── config/              # 配置加载
│   └── loader.ts
└── utils/
    └── errors.ts
```

## 多轮对话

REPL 内部每轮 `agentRun` 结束后，agent 会 yield `final_history` 事件，回吐**完整** messages（包含 `assistant.tool_use` 和 `user.tool_result` 块）。REPL 覆盖 `history` 后再传回下一轮——确保 LLM 始终看到完整多模态上下文。

## 平台特定说明

### Windows

- **DPAPI keychain**：用 `System.Security.Cryptography.ProtectedData` 做 user-bound 加密。Agent 启动时检测 PowerShell 可用性；若不可用 fallback 到 EncryptedFile。
- **文件名限制**：Windows 文件名不允许 `:` 等保留字符，vault 路径生成时会自动替换。
- **mcp-server-ssh 冷启动**：通过 `npx -y` 首次拉取可能 60-120s；建议预先 warmup（`npx -y mcp-server-ssh &`，看到 "SSH MCP server running" 后 Ctrl+C）。
- **PowerShell `-Command` 坑**：PowerShell 把 `-Command` 之后的参数当作额外命令追加。本项目统一用 `-EncodedCommand` 传 Base64(UTF-16LE) 编码脚本，避免引号/转义问题。

### macOS

- **Keychain**：用 `security add-generic-password` 写到 Keychain。

### Linux

- **桌面环境**：`secret-tool` (libsecret) 是首选，常见于 GNOME/KDE。
- **无 GUI 服务器**：fallback 到 `~/.sshops/secrets/*.enc`（PBKDF2 + AES-256-GCM）；威胁模型：抗普通用户读取，**不抗 root 读取**。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `LLM_PROVIDER` | LLM 类型：`anthropic` \| `openai` | `providers.yaml` 中 `active` 字段 |
| `LLM_API_KEY` | API 密钥 | — |
| `LLM_BASE_URL` | 自定义 base URL（兼容 LiteLLM / OneAPI / 自建代理） | — |
| `LLM_MODEL` | 模型名 | — |
| `LLM_CONTEXT_WINDOW` | 覆盖 active provider 的上下文窗口（token） | `providers.yaml` 的 `contextWindow` |
| `ANTHROPIC_API_KEY` | （旧）Anthropic API 密钥 | — |
| `OPENAI_API_KEY` | （旧）OpenAI API 密钥 | — |
| `OPENAI_BASE_URL` | （旧）OpenAI base URL | `https://api.openai.com/v1` |
| `SSHOPS_LOG_LEVEL` | 日志级别 | `info` |
| `SSHOPS_METRICS_PORT` | Prometheus 端口 | `0`（禁用） |
| `SSHOPS_PROFILE` | `dev` 或 `prod` | `dev` |
| `SSHOPS_MAX_DURATION_SECONDS` | 单次任务整体超时 | `600` |
| `SSHOPS_MAX_STEPS` | 最大步数 | `30` |
| `SSHOPS_TOOL_TIMEOUT_SECONDS` | 单步工具超时 | `60` |
| `SSH_DEFAULT_USER` | SSH 默认登录用户 | `root` |
| `SSHOPS_VAULT_DISABLED` | 设为 `1` 禁用 vault（回退到原始 ask 模式） | `0` |

> **优先级**：`LLM_*` 通用变量 > 旧版 provider-specific 变量 > `config/providers.yaml`。
> 推荐使用 `LLM_*` 形式以兼容 LiteLLM、OneAPI、DeepSeek 自建代理等通用网关。

## 故障排查

| 现象 | 排查命令 / 方向 |
|------|-----------------|
| LLM 还在杜撰工具结果 | `cat config/agent.yaml` 检查 `hallucinationGuard.failureKeywords` 是否覆盖了该工具的错误关键词 |
| 多轮 LLM 失忆 | `ls -la sessions/*.jsonl` 看 WAL 是否完整；`sshops-agent -i` 看 `[resume]` 提示是否出现 |
| 模型不可用，自动降级失败 | `sshops-agent config show` 看 `fallback` 配置；指标 `agent_fallback_total` 应递增 |
| 工具反复失败导致熔断 | 指标 `agent_state_transitions_total{to="error",reason="circuit_open"}` |
| WAL 损坏 | `sessions/<id>.jsonl` 最后一行应为 `session_end`；否则用 `sshops-agent --resume <id>` 恢复 |
| `isError` 没透传 | 确认使用的是 mcp-server-ssh ≥ 0.6.0；老版本需升级 |
| Windows 上 mcp-server-ssh 启动慢 | 预先 warmup：`npx -y mcp-server-ssh &` 等看到 "SSH MCP server running" 后 Ctrl+C |
| 密码写入 vault 后仍要求输入 | 检查 keychain backend 是否可用：`sshops-agent doctor` |

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # eslint
npm run dev         # tsx 实时运行（无需 build）
npm run build       # 编译到 dist/
```

测试用例分两类：

- `tests/unit/` — 纯逻辑（无网络、无文件系统副作用）
- `scripts/test-*.mjs` — 端到端（需要真实 vault + 可达的远端主机）

## 安全最佳实践

1. **永远不要把明文密码传给 LLM**：本项目默认走 vault 路径。如确需走 inline 模式，确认你的 LLM API endpoint 支持 encryption at rest。
2. **定期 rotate**：`sshops-agent vault rotate <alias>` 改完远程服务器密码后立即调用。
3. **audit 监控**：`sshops-agent vault audit 100` 看最近 100 条；可在 SIEM 收 `~/.sshops/vault-audit.jsonl`。
4. **限制 vault.json 权限**：`chmod 600 ~/.sshops/vault.json`（含主机清单、tags，但不包含密码）。
5. **避免在 CI 跑 vault set**：CI 环境用一次性服务账号 + 短期凭证；定期 rotate 频率比开发环境高。
6. **不要把 `.env` / `sessions/` / `logs/` 提交进 Git** — `.gitignore` 已默认排除。

## 架构升级文档

- [架构审计](./docs/architecture-audit.md)：现状、关键缺陷、与主流 Agent 工程规范的差距。
- [升级计划](./docs/upgrade-plan.md)：P0–P4 路线图、目标架构、验收标准与风险。

## 路线图

- [ ] **Vault v2**：seccomp + restrictedToken 进程隔离（v1 暂未实现）
- [ ] 多用户协作：vault 支持 team shared 模式（远端 vault 服务）
- [ ] Web UI：浏览器端对话界面 + 实时工具调用可视化
- [ ] 插件市场：第三方 SSH Provider / 通知渠道（Slack / 飞书 / 钉钉）
- [ ] 离线模式：本地小模型（如 qwen2.5-coder-7b）做 fallback
- [ ] 审计合规导出：CSV / Excel / 对接 ELK

## 贡献

欢迎 Issue 与 PR：

1. Fork & 创建分支：`git checkout -b feature/xxx`
2. 本地开发：`npm install && npm run dev`
3. 跑测试 + lint：`npm test && npm run lint`
4. 提交：commit message 建议 `type(scope): subject`（feat / fix / docs / refactor / test）
5. 发起 PR，描述清楚动机与影响面

> 大改动前请先开 Issue 讨论，避免做无用功。

## 许可

[MIT](./LICENSE) © sshops-agent contributors
