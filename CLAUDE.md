# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

**Multi-tenant mode** (active): `tenants.json` defines tenants (brokers + system). Each tenant gets its own Telegram bot, group folder, MCP tool scoping, and session isolation. When `tenants.json` exists, the orchestrator creates per-tenant TelegramChannel instances instead of using the channel registry.

## Architecture

### Message Flow

```
Telegram → TelegramChannel (Grammy bot) → onMessage callback → storeMessage (SQLite)
→ message loop → GroupQueue → container-runner (Docker) → agent-runner (Claude Agent SDK)
→ result → router → TelegramChannel.sendMessage → Telegram
```

### Multi-Tenant Flow

```
tenants.json → tenant-config.ts (load + validate with Zod)
→ index.ts creates per-tenant TelegramChannel (one Grammy bot per tenant)
→ Each tenant's chats registered as groups (DM, operations, leads)
→ mcp-config-generator.ts creates per-tenant .mcp.json (tool scoping)
→ container-runner.ts passes tenantId, assistantName, allowedTools to container
→ credential-proxy.ts injects real OAuth token + anthropic-beta header
```

### Credential Proxy (OAuth)

Containers never see real credentials. The proxy at port 3001:
- Containers get `ANTHROPIC_AUTH_TOKEN=placeholder` and `ANTHROPIC_BASE_URL=http://localhost:3001`
- Proxy swaps placeholder Bearer token for real OAuth token from `.env`
- Injects `anthropic-beta: oauth-2025-04-20` header (required for OAuth on /v1/messages)
- OAuth token from `claude setup-token` valid ~1 year, stored in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`

### Session Resolution

`session-resolver.ts` determines session isolation:
- DM → folder-level session (priority 1)
- Customer-facing → per-customer session
- Operations topic (independent) → per-topic session
- Operations topic (shared) → folder-level session
- Scheduled task → folder-level session (priority 3)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation, multi-tenant startup |
| `src/tenant-config.ts` | Load/validate tenants.json, resolve env vars, merge broker defaults |
| `src/mcp-config-generator.ts` | Generate per-tenant .mcp.json with tool scoping and memory limits |
| `src/container-runner.ts` | Spawn agent containers with mounts, auth, hardening flags |
| `src/credential-proxy.ts` | Proxy that injects real credentials into container API requests |
| `src/session-resolver.ts` | Composite session key resolution per tenant/topic/customer |
| `src/channels/telegram.ts` | Telegram channel (Grammy), multi-bot via createTenantTelegramChannel |
| `src/channels/registry.ts` | Channel registry (single-tenant fallback) |
| `src/group-queue.ts` | Per-group FIFO message queue with dedupe and rate limiting |
| `src/ipc.ts` | File-based IPC for container↔host communication |
| `src/router.ts` | Message formatting and outbound routing |
| `src/db.ts` | SQLite operations, schema, migrations |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Cron-based scheduled tasks |
| `tenants.json` | Multi-tenant configuration (brokers, system tenants, tool scoping) |
| `groups/{name}/CLAUDE.md` | Per-group agent memory (isolated per tenant) |
| `container/agent-runner/src/index.ts` | Container-side entry point, runs Claude Agent SDK query() |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/add-telegram` | Add/configure Telegram channel |
| `/add-telegram-swarm` | Agent swarm — each subagent gets its own bot identity |

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run build          # Compile TypeScript
npm run dev            # Run with hot reload
npx vitest run         # Run all tests
npx vitest run src/tenant-config.test.ts  # Run single test file
./container/build.sh   # Rebuild agent container
```

Service management (this VPS has no systemd — uses nohup wrapper):
```bash
bash start-nanoclaw.sh              # Start/restart (kills old process, clears port)
kill $(cat nanoclaw.pid)            # Stop
tail -f logs/nanoclaw.log           # Watch logs
tail -f logs/nanoclaw.error.log     # Watch errors
```

Container debugging:
```bash
ls -t groups/main/logs/container-*.log | head -1 | xargs cat  # Latest container log
docker ps -a --filter name=nanoclaw                            # Running containers
sqlite3 store/messages.db "SELECT * FROM registered_groups;"   # Check registrations
sqlite3 store/messages.db "SELECT * FROM sessions;"            # Check sessions
```

## Troubleshooting

**Container exit code 137:** OOM killed. Increase memory in `deriveMemoryLimit()` in `mcp-config-generator.ts`. This VPS has 47GB RAM — be generous. Current limits: 4096m (>5 tools), 2048m (<=5), 1024m (customer-facing).

**EADDRINUSE port 3001:** Old process didn't die. `start-nanoclaw.sh` handles this (kills port holder + waits for clean shutdown).

**OAuth 401 errors:** Check that `.env` has `CLAUDE_CODE_OAUTH_TOKEN` and it matches `~/.claude/.credentials.json`. Token valid ~1 year from `claude setup-token`. Proxy must inject `anthropic-beta: oauth-2025-04-20` header.

**Container starts query then hangs:** Check `--pids-limit` (currently 256) and `--memory` in container-runner.ts. 9 MCP servers need significant resources.

**WhatsApp not connecting after upgrade:** WhatsApp is a separate channel fork. Run `/add-whatsapp` to install.

## Container Build Cache

The container buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force clean rebuild: `docker builder prune -f` then `./container/build.sh`.
