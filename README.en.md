<div align="center">

# sshops-agent

**Production server ops that speaks human: one sentence to provision, deploy, and monitor.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](./tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-1.0-purple.svg)](https://modelcontextprotocol.io)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20macos%20%7C%20linux-lightgrey.svg)](#platform-support)

[中文](./README.md) · [Quick Start](#quick-start) · [Architecture](#architecture) · [Credential Safety](#credential-safety-vault) · [Contributing](#contributing)

</div>

---

## What is it

`sshops-agent` is an **AI Agent for production server operations**. Tell it what to do in plain language — deploy nginx, check disk, read logs, restart a service — and it plans, calls SSH/SFTP tools, verifies the result, and asks for confirmation on anything risky.

It is *not* another LLM wrapper around an SSH client, nor a toy that translates shell to prompts. It treats "can an LLM actually do ops" as 7 engineering problems and solves each one head-on:

| Problem | Solution |
|---------|----------|
| Model hallucinates, claims success | Hallucination guard + raw `isError` propagation + required-field validation |
| Passwords leak into LLM context | Separate vault daemon + OS keychain — agent only ever sees a `connectionId` |
| LLM runs dangerous commands freely | Hard deny list + high-risk confirm prompt + host whitelist + JSONL audit |
| LLM forgets across turns | WAL session persistence + full multi-modal history replay |
| Context window blows up | Snip → Microcompact → Context-Collapse → Autocompact, 4-stage pipeline |
| Tool keeps failing in a loop | Circuit breaker + model fallback chain + loop detection |
| Switching between LLM providers | Provider abstraction with Anthropic + OpenAI-compatible (vLLM / Ollama / DeepSeek self-hosted) |

## Features

- **One-line ops** — `sshops-agent "install and start nginx on 192.168.1.10"`
- **Multi-LLM** — Anthropic Claude and OpenAI-compatible (vLLM / Ollama / DeepSeek) providers; hot-swap via config file
- **Native SSH Provider** — built directly on `ssh2` with a connection pool; avoids the 60–120s cold-start pain of `mcp-server-ssh`
- **Credential Vault (v1)** — SSH secrets live in a separate vault daemon + OS keychain; the agent never holds plaintext
- **Command-level permissions** — hard deny list + high-risk confirm prompt + host whitelist + audit log
- **Resumable sessions** — WAL written to `sessions/<id>.jsonl`; crash-safe `--resume`
- **Hallucination resistance** — failure-keyword guard + required-field check + options-menu follow-up; the LLM is forced to ask, never to invent
- **Context compression** — Snip → Microcompact → Context-Collapse → Autocompact
- **Observability** — `pino` structured logs + `prom-client` Prometheus metrics
- **Interactive REPL** — multi-turn + full message history + auto-resume last session

## Quick Start

### Prerequisites

- **Node.js ≥ 18** (20 LTS recommended)
- **OpenSSH client** (built-in on Windows 10+; default on macOS/Linux)
- **A working LLM API key** (Anthropic / OpenAI / any OpenAI-compatible gateway)

### Install

```bash
git clone https://github.com/sofild/sshops-agent.git
cd sshops-agent
npm install
cp .env.example .env
# Edit .env, set LLM_API_KEY at minimum
npm run build
npm link            # register the sshops-agent command globally
```

> If you change the `bin` entry later, re-run `npm link`.
> Uninstall: `npm unlink -g sshops-agent`

### First run

#### 1. Self-check

```bash
sshops-agent doctor
```

`doctor` verifies Node version, OpenSSH availability, config loading, and LLM reachability.

#### 2. Single-shot task

```bash
sshops-agent "install and start nginx on 192.168.1.10"
```

#### 3. Interactive mode

```bash
sshops-agent -i
> check disk on web-01
> [Enter to wait for the result]
> /exit
```

After `/exit`, the next `sshops-agent -i` automatically resumes the last session (read from `sessions/.last-session-id`).

#### 4. Enable Prometheus metrics

```bash
sshops-agent --metrics-port 9090 "check server status"
# In another terminal
curl http://localhost:9090/metrics
```

## Configuration

`sshops-agent` reads 5 YAML files from `config/`:

| File | Purpose |
|------|---------|
| `providers.yaml` | LLM Provider configuration (switch the default via the `active` field) |
| `agent.yaml` | Agent behavior (step count, timeouts, compression thresholds, hallucination guard, circuit breaker, fallback chain) |
| `permissions.yaml` | Command-level permissions (deny / confirm / hostWhitelist / required fields / audit) |
| `tools.yaml` | Tool configuration (local tools + native SSH provider + MCP servers) |
| `vault.yaml` | Credential vault (enable, binary path, audit) |

### CLI subcommands

```bash
sshops-agent "..."                  # single-shot task
sshops-agent -i                     # interactive mode
sshops-agent --metrics-port 9090    # enable Prometheus
sshops-agent --resume <id>          # resume a session
sshops-agent doctor                 # environment self-check
sshops-agent config validate        # validate config
sshops-agent config show            # print redacted config
sshops-agent session list           # list sessions
sshops-agent session show <id>      # show a session
sshops-agent vault set <alias>      # register host credentials
sshops-agent vault rotate <alias>   # rotate credentials
sshops-agent vault audit 100        # show last 100 vault audit entries
```

## Credential Safety (Vault)

> The single most important design point: **SSH plaintext passwords never enter the LLM context.**

```
┌──────────────┐  IPC (JSON over stdio)  ┌────────────────┐
│  sshops-agent│ ───────────────────────▶│  sshops-vault  │
│  (LLM proc)  │ ◀───── connectionId ────│  (separate     │
└──────┬───────┘                          │   process)     │
       │                                  └────────┬───────┘
       │ ssh2 direct (no password field)           │
       ▼                                           │ read
   Remote host                          OS Keychain (DPAPI / Keychain / libsecret)
                                        or ~/.sshops/secrets/*.enc (PBKDF2+AES-GCM fallback)
```

**Flow:**
1. User: `sshops-agent vault set web1`, enters host + password → vault writes to keychain
2. LLM calls `ssh_ssh_connect({ host: "web1" })` (**only `host`**)
3. Agent internals: detects missing auth → IPC asks vault to read keychain → injects `{ host, port, username, password }` into `ssh2`
4. The LLM only ever sees `connectionId: "web1:22"`; it has never seen the password

**Why this matters:**
- Even if your LLM vendor logs prompts, your server passwords aren't there
- Audit log **never** records `password` / `privateKey` fields (see `src/vault/audit.ts` for the strict strip)
- Rotating a password needs no code change: `sshops-agent vault rotate web1`

## Permission Model

Default policy lives in [config/permissions.yaml](./config/permissions.yaml).

### Hard `deny` list (rejected outright)

- `rm -rf /`, `shutdown`, `reboot`, `halt`, `poweroff`
- `mkfs`, `dd if=`, `fdisk`, `format`
- Fork bomb `:(){ :|:& };:`
- `chmod -R 777 /`, `>/dev/sda`
- `curl * | bash`, `wget * | bash`

### High-risk `confirm` list (proceeds only after `y`)

- `rm -rf`, `chmod -R`, `chown -R`
- `iptables -F`, `userdel`, `kill -9 1`
- `systemctl stop/disable`, `service * stop`
- `DROP TABLE`, `TRUNCATE`, `DELETE FROM`
- `kubectl delete namespace`, `docker system prune`

**Non-interactive mode** (piped / CI) rejects `confirm` commands by default.

### Host whitelist

`hostWhitelist` in `config/permissions.yaml` supports exact match and CIDR:

```yaml
hostWhitelist:
  - 192.168.1.10
  - 10.0.0.0/24
  - prod-web-*.example.com
```

Empty list means "no restriction".

## Audit Log

Every tool call (including denials) is appended to `logs/audit-YYYY-MM-DD.jsonl`:

```json
{"timestamp":"2026-06-03T...","session_id":"...","trace_id":"...","user":"...","tool":"ssh_ssh_execute","host":"1.2.3.4","command":"systemctl stop nginx","decision":"confirm","reason":"matched confirm rule: systemctl stop"}
```

Vault writes its own audit to `~/.sshops/vault-audit.jsonl` for SIEM ingestion.

## Hallucination Resistance

`sshops-agent` is engineered to prevent the model from inventing tool results. The full mechanism:

1. **Raw `isError` propagation** — the MCP adapter maps `result.isError` straight onto `ToolResult.isError`, so the LLM gets an unambiguous failure signal.
2. **Failure-keyword guard** — `hallucinationGuard.failureKeywords` in `config/agent.yaml` (default: `No authentication method`, `permission denied`, …) flags any tool return that looks like a failure and forces the LLM to emit a `[NEED_INPUT:field1|field2]` marker on its next turn.
3. **Required-field validation** — `requiredFields` in `config/permissions.yaml` declares the must-have parameters for each tool (e.g. `ssh_ssh_connect` needs `host` + `password|privateKey|privateKeyPath`). Missing fields raise a `need_input` event that the REPL renders as a prompt.
4. **Options menu** (pick-one) — when the LLM can't decide on a host/user, it emits `[OPTIONS:field|val1=label1,val2=label2]` and the REPL renders a 1-N menu.

### Host manifest (data source for the options menu)

`sessions/memory/hosts.md` — one host per line:

```markdown
# ip | label | description
10.222.10.21 | root@web-01 | nginx running
10.222.10.22 | root@db-01  | postgres 15
10.222.10.23 | root@app-01 | node 20
```

When the user says "connect to that web server" in the REPL, the agent lists these candidates and asks.

## Architecture

```
src/
├── main.ts              # entry
├── cli/                 # CLI entry & subcommands
│   ├── root.ts          # commander main
│   ├── doctor.ts        # environment self-check
│   └── repl.ts          # interactive mode
├── agent/               # agent core
│   ├── core.ts          # main loop (7 continue points)
│   ├── compressor.ts    # 4-stage context compression
│   └── memory.ts        # cross-session memory
├── llm/                 # LLM abstraction
│   ├── types.ts
│   ├── factory.ts
│   └── providers/
│       ├── anthropic.ts
│       └── openai-compatible.ts
├── tools/               # tool system
│   ├── registry.ts
│   ├── bootstrap.ts
│   ├── mcp/             # MCP client
│   └── local/           # local tools
├── permissions/         # permissions & safety
│   ├── enforcer.ts
│   ├── audit.ts
│   └── prompt.ts
├── session/             # session persistence
│   └── wal.ts
├── ssh/                 # native SSH provider (replaces mcp-server-ssh)
│   ├── provider.ts
│   └── registry.ts
├── vault/               # credential vault client
│   ├── client.ts
│   ├── daemon.ts
│   ├── keychain.ts
│   └── ...
├── observability/       # observability
│   ├── logging.ts
│   ├── metrics.ts
│   └── tracer.ts
├── config/              # config loader
│   └── loader.ts
└── utils/
    └── errors.ts
```

## Multi-turn Conversation

At the end of each `agentRun`, the REPL receives a `final_history` event containing the **full** messages array (including `assistant.tool_use` and `user.tool_result` blocks). The REPL overwrites its `history` and passes it back on the next turn — so the LLM always sees the complete multi-modal context.

## Platform Support

### Windows

- **DPAPI keychain** — uses `System.Security.Cryptography.ProtectedData` for user-bound encryption. The agent probes PowerShell availability at startup and falls back to EncryptedFile if not.
- **Filename restrictions** — Windows forbids reserved characters like `:` in filenames; vault path generation auto-replaces them.
- **`mcp-server-ssh` cold start** — `npx -y` may take 60–120s on first fetch. Pre-warm with `npx -y mcp-server-ssh &` and wait for the "SSH MCP server running" message before Ctrl+C.
- **PowerShell `-Command` trap** — PowerShell appends everything after `-Command` as extra commands. We always use `-EncodedCommand` with Base64(UTF-16LE) to avoid quoting/escaping issues.

### macOS

- **Keychain** — credentials are written via `security add-generic-password`.

### Linux

- **Desktop** — `secret-tool` (libsecret) is the preferred backend; common on GNOME/KDE.
- **Headless server** — falls back to `~/.sshops/secrets/*.enc` (PBKDF2 + AES-256-GCM). Threat model: resists normal user reads, **does not resist root**.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_PROVIDER` | LLM type: `anthropic` \| `openai` | `active` field in `providers.yaml` |
| `LLM_API_KEY` | API key | — |
| `LLM_BASE_URL` | Custom base URL (LiteLLM / OneAPI / self-hosted) | — |
| `LLM_MODEL` | Model name | — |
| `LLM_CONTEXT_WINDOW` | Override the active provider context window (tokens) | `contextWindow` in `providers.yaml` |
| `ANTHROPIC_API_KEY` | (legacy) Anthropic API key | — |
| `OPENAI_API_KEY` | (legacy) OpenAI API key | — |
| `OPENAI_BASE_URL` | (legacy) OpenAI base URL | `https://api.openai.com/v1` |
| `SSHOPS_LOG_LEVEL` | Log level | `info` |
| `SSHOPS_METRICS_PORT` | Prometheus port | `0` (disabled) |
| `SSHOPS_PROFILE` | `dev` or `prod` | `dev` |
| `SSHOPS_MAX_DURATION_SECONDS` | Per-task overall timeout | `600` |
| `SSHOPS_MAX_STEPS` | Max steps | `30` |
| `SSHOPS_TOOL_TIMEOUT_SECONDS` | Per-step tool timeout | `60` |
| `SSH_DEFAULT_USER` | Default SSH login user | `root` |
| `SSHOPS_VAULT_DISABLED` | Set to `1` to disable vault (fall back to legacy ask mode) | `0` |

> **Precedence:** `LLM_*` generic vars > legacy provider-specific vars > `config/providers.yaml`.
> Prefer the `LLM_*` form for compatibility with LiteLLM, OneAPI, and self-hosted DeepSeek gateways.

## Troubleshooting

| Symptom | Where to look |
|---------|---------------|
| LLM still invents results | Check `hallucinationGuard.failureKeywords` in `config/agent.yaml` covers this tool's error words |
| LLM forgets across turns | `ls -la sessions/*.jsonl` to inspect WAL; look for `[resume]` on next `sshops-agent -i` |
| Model unavailable, fallback failed | `sshops-agent config show` to inspect `fallback`; metric `agent_fallback_total` should increment |
| Tool keeps failing → circuit open | Metric `agent_state_transitions_total{to="error",reason="circuit_open"}` |
| WAL corruption | `sessions/<id>.jsonl` last line should be `session_end`; otherwise run `sshops-agent --resume <id>` |
| `isError` not propagated | Make sure `mcp-server-ssh` ≥ 0.6.0; older versions must be upgraded |
| Slow `mcp-server-ssh` startup on Windows | Pre-warm: `npx -y mcp-server-ssh &` and wait for "SSH MCP server running" before Ctrl+C |
| Vault set succeeded but still asked for password | Check keychain backend availability: `sshops-agent doctor` |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # eslint
npm run dev         # tsx watch mode (no build needed)
npm run build       # compile to dist/
```

Tests fall into two groups:

- `tests/unit/` — pure logic (no network, no real filesystem side effects)
- `scripts/test-*.mjs` — end-to-end (requires real vault + reachable remote hosts)

## Security Best Practices

1. **Never feed plaintext passwords to the LLM.** This project defaults to the vault path. If you must use inline mode, make sure your LLM endpoint supports encryption at rest.
2. **Rotate regularly.** `sshops-agent vault rotate <alias>` immediately after changing the password on the remote host.
3. **Monitor the audit log.** `sshops-agent vault audit 100` shows recent entries; ingest `~/.sshops/vault-audit.jsonl` into your SIEM.
4. **Restrict vault.json permissions.** `chmod 600 ~/.sshops/vault.json` (it contains the host manifest and tags, but no passwords).
5. **Avoid `vault set` in CI.** Use short-lived service accounts and short-lived credentials; rotate more often than in dev.
6. **Don't commit `.env` / `sessions/` / `logs/`.** `.gitignore` excludes them by default.

## Architecture upgrade docs

- [Architecture audit](./docs/architecture-audit.md) — current state, key defects, gaps against modern agent engineering practices.
- [Upgrade plan](./docs/upgrade-plan.md) — P0–P4 roadmap, target architecture, acceptance criteria and risks.

## Roadmap

- [ ] **Vault v2** — seccomp + restrictedToken process isolation (not in v1)
- [ ] Team collaboration — shared remote vault service
- [ ] Web UI — browser-based chat + real-time tool call visualization
- [ ] Plugin marketplace — third-party SSH providers / notification channels (Slack / Feishu / DingTalk)
- [ ] Offline mode — small local model (e.g. qwen2.5-coder-7b) as fallback
- [ ] Compliance export — CSV / Excel / ELK integration

## Contributing

Issues and PRs welcome:

1. Fork & branch: `git checkout -b feature/xxx`
2. Develop locally: `npm install && npm run dev`
3. Run tests + lint: `npm test && npm run lint`
4. Commit: prefer `type(scope): subject` style (feat / fix / docs / refactor / test)
5. Open a PR and describe the motivation and impact

> Open an Issue first for larger changes, to avoid wasted effort.

## License

[MIT](./LICENSE) © sshops-agent contributors
