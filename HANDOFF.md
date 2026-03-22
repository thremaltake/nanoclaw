# VPS NanoClaw — Handoff Prompt for Claude Code

Copy everything below this line and paste it into Claude Code on the VPS (`/home/nanoclaw/nanoclaw`).

---

## Context: What Has Been Done

I've been migrating NanoClaw from being embedded inside a BrokerPilot monorepo on my Mac to a standalone installation on this VPS. Here's the full picture.

### The Goal

NanoClaw is a general-purpose AI assistant — not tied to any single project. BrokerPilot is just one of many projects it connects to via MCP. The VPS runs NanoClaw 24/7 with Telegram bots.

### What's On This VPS

```
/home/nanoclaw/nanoclaw/          ← NanoClaw (forked from qwibitai/nanoclaw, customized)
/home/nanoclaw/brokerpilot/       ← BrokerPilot project (cloned from GitHub, read-only mount for containers)
/home/nanoclaw/.claude/           ← Claude Code credentials (OAuth tokens)
/home/nanoclaw/.config/nanoclaw/  ← Mount allowlist config
/home/nanoclaw/backups/           ← For scheduled SQLite backups
```

### VPS Details

- **Provider:** Oracle Cloud (Free Trial, $300 credits, 30 days — temporary, migrating to Mac Mini after)
- **Shape:** VM.Standard.E4.Flex (AMD x86), 8 OCPU, 64 GB RAM, 200 GB disk
- **OS:** Ubuntu 24.04 LTS
- **Tailscale IP:** 100.118.45.111 (SSH access only through Tailscale, zero public ports)
- **Admin user:** `ubuntu` (has sudo)
- **Service user:** `nanoclaw` (no sudo, runs NanoClaw)
- **systemd service:** `nanoclaw.service` at `/etc/systemd/system/nanoclaw.service`

### Security Setup (Already Done)

- SSH keys only, no root login, no password auth
- Fail2Ban installed
- UFW firewall: default deny incoming, Tailscale interface only
- Docker installed, nanoclaw user in docker group
- Node.js 20, Claude Code CLI installed
- Chrony time sync

### NanoClaw Setup (Already Done)

- Forked from qwibitai/nanoclaw to thremaltake/nanoclaw
- `/setup` completed — Docker container image built, Telegram bot connected
- OAuth: using 1-year setup-token (NOT short-lived access tokens)
- Token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`
- Bot: @AHBrokerPilot_bot connected and responding

### Customizations Already Applied

1. **Mount builder** (`src/container-runner.ts`): Modified to support multiple project mounts. Reads `projects` array from `~/.config/nanoclaw/mount-allowlist.json`. Each project mounted read-only at `/workspace/projects/{name}/`.

2. **Container security** (`src/container-runner.ts`): Added `--security-opt=no-new-privileges`. Network mode defaults to `bridge` (agent needs API access). Configurable per-group via `networkMode` in container config.

3. **Agent runner MCP loading** (`container/agent-runner/src/index.ts`): Modified to read `/workspace/group/.mcp.json` at startup and merge those MCP servers into the `mcpServers` option passed to `query()`. Resolves `${VAR}` env variable templates from `process.env`.

4. **Agent runner source sync** (`src/container-runner.ts`): Removed the `!fs.existsSync` guard — now copies fresh agent-runner source on every container start (was causing stale cached code).

5. **Build script** (`container/build.sh`): Added `docker builder prune -f` and `--no-cache` to prevent BuildKit cache poisoning.

6. **Container env passthrough** (`src/container-runner.ts`): Injects SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY, HIMALAYA_CONFIG_PATH, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, BSR_BASE_URL, BSR_AUTH_SECRET as `-e` flags on containers.

7. **Safety guardrails** (`groups/global/CLAUDE.md`): Added HARD RULES at the top — no autonomous external writes, draft-only for customer communications, exceptions require explicit approval.

### BrokerPilot MCP Tools (Working)

9 MCP servers configured via `.mcp.json` files in group folders. All verified loading inside containers:

| MCP Server | Module Path | Key Env Vars |
|-----------|-------------|-------------|
| deal-manager | /workspace/projects/brokerpilot/modules/deal-manager/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DB_SCHEMA=work |
| work-email | /workspace/projects/brokerpilot/modules/work-email/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HIMALAYA_CONFIG_PATH |
| lender-knowledge | /workspace/projects/brokerpilot/modules/lender-knowledge/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY |
| lender-matching | /workspace/projects/brokerpilot/modules/lender-matching/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY |
| bank-statement | /workspace/projects/brokerpilot/modules/bank-statement/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BSR_BASE_URL, BSR_AUTH_SECRET |
| calendar | /workspace/projects/brokerpilot/modules/calendar/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_* |
| personal-finance | /workspace/projects/brokerpilot/modules/personal-finance/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DB_SCHEMA=personal |
| personal-email | /workspace/projects/brokerpilot/modules/personal-email/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HIMALAYA_CONFIG_PATH |
| document-store | /workspace/projects/brokerpilot/modules/document-store/src/index.ts | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY |

### Group Folders

```
groups/
├── global/CLAUDE.md          ← Shared system prompt + safety rules (all groups)
├── main/                     ← BrokerPilot main (from Mac migration)
│   ├── CLAUDE.md             ← Bot memory and instructions
│   ├── .mcp.json             ← 9 BrokerPilot MCP servers
│   ├── documents/            ← Downloaded files
│   ├── logs/                 ← Container logs
│   ├── conversations/        ← Archived transcripts
│   ├── lender_criteria/      ← Lender criteria files
│   └── settings.json         ← Runtime settings
├── personal/                 ← Personal assistant (from Mac)
│   ├── CLAUDE.md
│   ├── .mcp.json             ← Same 9 MCP servers
│   └── logs/
├── caliort/                  ← Caliort Capital broker (from Mac)
│   ├── CLAUDE.md
│   ├── .mcp.json             ← Same 9 MCP servers
│   ├── logs/
│   └── settings.json
├── lead-capture/             ← Customer-facing chatbot (from Mac)
│   ├── CLAUDE.md
│   ├── logs/
│   └── settings.json
├── telegram_personal/        ← Created by /setup (current active DM group)
│   ├── .mcp.json             ← Same 9 MCP servers
│   └── logs/
└── telegram_group/           ← Created by /setup (group chat)
    ├── .mcp.json             ← Same 9 MCP servers
    └── logs/
```

### systemd Service

File: `/etc/systemd/system/nanoclaw.service`

Key settings:
- `User=nanoclaw`, `Group=nanoclaw`
- `WorkingDirectory=/home/nanoclaw/nanoclaw`
- `ExecStart=/usr/bin/node dist/index.js`
- `Restart=always`, `RestartSec=10`
- `ProtectHome=read-only`
- `ReadWritePaths`: store, groups, logs, data, ~/.claude

Commands:
- Start: `sudo systemctl start nanoclaw`
- Stop: `sudo systemctl stop nanoclaw` (may hang — use `sudo systemctl kill nanoclaw` if needed)
- Restart: `sudo systemctl kill nanoclaw && sudo systemctl start nanoclaw`
- Logs: `sudo journalctl -u nanoclaw -f`
- Status: `sudo systemctl status nanoclaw`

---

## What Still Needs To Be Done

### 1. Multi-Tenant Setup (HIGH PRIORITY)

The Mac setup had 4 Telegram bots, each scoped to different tools and database schemas. The VPS currently runs only 1 bot (@AHBrokerPilot_bot) with all tools available.

**The Mac's `tenants.json` (NOT yet transferred to VPS) defines:**

| Tenant | Bot | DB Schema | Private Tools | Shared Tools |
|--------|-----|-----------|--------------|-------------|
| motorest (main) | @AHBrokerPilot_bot | work | deals, email, calendar, document-store | lender-knowledge, lender-matching, bank-statement |
| personal | @PersonalBot (TELEGRAM_PERSONAL_BOT_TOKEN) | personal | personal-finance, personal-email, document-store | calendar |
| caliort | @DinnerBros (BROKER_CALIORT_TOKEN) | caliort | deals, email, calendar, document-store | lender-knowledge, lender-matching, bank-statement |
| lead-capture | Lead bot (TELEGRAM_LEAD_BOT_TOKEN) | work | deals | (none) |

**What needs to happen:**
- The upstream NanoClaw doesn't have multi-tenant support — it's a single-bot system
- The Mac's `apps/nanoclaw/` had custom multi-tenant code (tenant-config.ts, tenant loop in bootstrap.ts, per-tenant container runner)
- Decision needed: either port the multi-tenant code to this fork, or run separate NanoClaw instances per bot
- The `.env` already has all 4 bot tokens (TELEGRAM_BOT_TOKEN, TELEGRAM_PERSONAL_BOT_TOKEN, BROKER_CALIORT_TOKEN, TELEGRAM_LEAD_BOT_TOKEN)

### 2. Per-Tenant MCP Scoping

Currently every group gets all 9 MCP tools. The Mac setup scoped tools per tenant:
- `motorest` group should only have deals, email, calendar, document-store, lender-*, bank-statement (DB_SCHEMA=work)
- `personal` group should only have personal-finance, personal-email, document-store, calendar (DB_SCHEMA=personal)
- `caliort` group should only have deals, email, calendar, document-store, lender-*, bank-statement (DB_SCHEMA=caliort)
- `lead-capture` should only have deals (DB_SCHEMA=work)

Each group already has its own `.mcp.json` — we could create different `.mcp.json` files per group with only the relevant tools.

### 3. Templates & Scripts (NOT transferred)

These files from the Mac need to be copied:
- `templates/broker-CLAUDE.md` — template for onboarding new brokers
- `scripts/add-tenant.sh` — script to add a new broker tenant
- `scripts/remove-tenant.sh` — script to remove a broker tenant

These are BrokerPilot-specific customizations. They may not work without the multi-tenant code.

### 4. Customer-Facing Bot Protections (lead-capture)

The Mac setup had special protections for the lead-capture bot:
- Input sanitization (block jailbreak attempts)
- Output validation (max 500 chars, compliance check, no code blocks)
- Rate limiting (30 messages per session)
- Per-user session isolation
- Skip global CLAUDE.md (don't leak internal instructions)

These were implemented in `src/output-validator.ts` and `src/message-pipeline.ts` on the Mac. Not yet ported.

### 5. Orphan Container Cleanup Cron

Add a cron job to clean up stale Docker containers:
```
0 * * * * docker ps -q --filter "name=nanoclaw-" --filter "status=running" | xargs -r docker inspect --format '{{.Id}} {{.State.StartedAt}}' | awk -v cutoff=$(date -d '2 hours ago' +%s) '{...}' | xargs -r docker rm -f
```

### 6. SQLite Backup Cron

Add daily backup of the NanoClaw database:
```
0 3 * * * cp /home/nanoclaw/nanoclaw/store/messages.db /home/nanoclaw/backups/messages-$(date +%Y%m%d).db
```

### 7. Dashboard Deployment (Phase 5 — Optional)

Deploy the BrokerPilot dashboard to Vercel:
- App is at `/home/nanoclaw/brokerpilot/apps/dashboard/`
- Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
- AI chat feature would need Cloudflare Tunnel to this VPS

### 8. Phase 8: Cutover (When Ready)

After VPS is stable:
- Stop NanoClaw on the Mac
- Remove `apps/nanoclaw/` from BrokerPilot repo on Mac
- Update BrokerPilot's CLAUDE.md and start/stop scripts

---

## AI Safety Rules (MUST FOLLOW)

These are non-negotiable rules that apply to ALL work on this VPS:

1. **No autonomous external writes** — Never send emails, SMS, or messages directly to customers. All customer-facing outputs are DRAFTS ONLY.
2. **GitHub push requires approval** — Code can be pushed only after code review and explicit user approval.
3. **Email send requires approval** — Draft first, user reviews, then explicit approval to send.
4. **Everything runs in containers** — No risk to internal code, auth keys, or secrets if a container is breached.
5. **Container mounts are read-only** — BrokerPilot code cannot be modified by agents.

---

## Key Files to Know

| File | Purpose |
|------|---------|
| `/home/nanoclaw/nanoclaw/.env` | All secrets (chmod 600) |
| `/home/nanoclaw/nanoclaw/src/container-runner.ts` | Spawns Docker containers, mounts, env passthrough |
| `/home/nanoclaw/nanoclaw/container/agent-runner/src/index.ts` | Runs inside container, loads MCP servers from .mcp.json |
| `/home/nanoclaw/nanoclaw/container/build.sh` | Builds Docker image (uses --no-cache) |
| `/home/nanoclaw/nanoclaw/groups/*/mcp.json` | Per-group MCP server config |
| `/home/nanoclaw/nanoclaw/groups/global/CLAUDE.md` | Shared system prompt + safety rules |
| `/home/nanoclaw/.config/nanoclaw/mount-allowlist.json` | Which directories containers can mount |
| `/etc/systemd/system/nanoclaw.service` | systemd service config |

---

## How To Make Changes

1. Stop service: `sudo systemctl kill nanoclaw`
2. Switch to nanoclaw user: `sudo -u nanoclaw -i`
3. Edit code in `/home/nanoclaw/nanoclaw/`
4. If agent-runner changed: `bash container/build.sh` (rebuilds Docker image)
5. If host code changed: `npm run build` (recompiles TypeScript)
6. Exit nanoclaw user: `exit`
7. Start service: `sudo systemctl start nanoclaw`
8. Check logs: `sudo journalctl -u nanoclaw -f`

---

## Your First Task

Please scan the VPS to verify everything matches what's described above. Then tell me:
1. What's working correctly
2. What's missing or broken
3. Your recommendation for what to tackle first from the "What Still Needs To Be Done" list
