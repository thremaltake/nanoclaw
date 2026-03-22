# NanoClaw Separation & VPS Deployment Design

**Date:** 2026-03-17
**Status:** Approved
**Author:** Claude (design), Andry (decisions)

---

## 1. Overview

### What We're Doing

Moving NanoClaw out of the BrokerPilot monorepo (`apps/nanoclaw/`) into its own standalone repository (`~/nanoclaw/`), deployed on a VPS for 24/7 operation. BrokerPilot becomes one of many projects that NanoClaw connects to via MCP (Model Context Protocol).

### Why

- NanoClaw is a general-purpose AI assistant framework — it shouldn't be coupled to one project
- BrokerPilot is just one of several projects NanoClaw will serve (future: personal tools, other business projects, non-code tasks)
- NanoClaw needs 24/7 uptime for Telegram bots — a VPS provides this without keeping a Mac on
- Matches NanoClaw's intended design: fork → customize → self-host

### What Changes

| Before | After |
|--------|-------|
| NanoClaw lives at `~/brokerpilot/apps/nanoclaw/` | NanoClaw lives at `~/nanoclaw/` (own repo on VPS) |
| Docker mounts BrokerPilot as "the project" | Docker mounts BrokerPilot as one of many projects |
| Runs on Mac via launchd | Runs on VPS via systemd |
| OAuth token from macOS Keychain | OAuth self-refresh from credentials file |
| Dashboard runs locally on Mac | Dashboard on Vercel, AI chat via Cloudflare Tunnel |

---

## 1.1. Complete Directory Maps

### Your Mac (Development Machine)

```
/Users/andryharianto/
├── brokerpilot/                          ← BrokerPilot monorepo (development)
│   ├── packages/shared/                  ← Shared types, schemas
│   ├── modules/                          ← 9 MCP servers
│   │   ├── deal-manager/
│   │   ├── work-email/
│   │   ├── lender-knowledge/
│   │   ├── lender-matching/
│   │   ├── bank-statement/
│   │   ├── calendar/
│   │   ├── personal-finance/
│   │   ├── personal-email/
│   │   └── document-store/
│   ├── apps/
│   │   ├── nanoclaw/                     ← WILL BE REMOVED after migration
│   │   └── dashboard/                    ← Next.js app (deploys to Vercel)
│   ├── supabase/migrations/
│   ├── .mcp.json                         ← Local Claude Code MCP config (stays)
│   ├── CLAUDE.md
│   └── docs/plans/                       ← This design doc
│
├── .ssh/
│   ├── id_ed25519                        ← Your SSH private key
│   └── id_ed25519.pub                    ← Your SSH public key (goes on VPS)
│
└── Library/LaunchAgents/
    └── com.brokerpilot.nanoclaw.plist    ← WILL BE REMOVED after migration
```

### VPS (Production Server)

```
/home/ubuntu/                             ← Admin user (Oracle Cloud default, has sudo)
├── .ssh/
│   └── authorized_keys                  ← Your Mac's public SSH key
├── .cloudflared/
│   ├── config.yml                        ← Cloudflare Tunnel config
│   └── <TUNNEL_ID>.json                  ← Tunnel credentials (auto-generated)
└── (no project files here)

/home/nanoclaw/                           ← Service user (runs NanoClaw, NO sudo)
├── nanoclaw/                             ← NanoClaw repo (your fork)
│   ├── .env                              ← Secrets (chmod 600). NEVER committed.
│   ├── src/                              ← NanoClaw source code
│   │   ├── index.ts                      ← Entry point
│   │   ├── bootstrap.ts                  ← Startup sequence
│   │   ├── channels/
│   │   │   └── telegram.ts               ← Telegram bot adapter
│   │   ├── container/
│   │   │   ├── runner.ts                 ← Spawns Docker containers
│   │   │   ├── mount-builder.ts          ← Builds volume mounts
│   │   │   ├── auth.ts                   ← OAuth self-refresh (REWRITTEN for VPS)
│   │   │   └── retry.ts                  ← Auth retry logic
│   │   ├── message-loop.ts              ← Polls DB every 2s
│   │   ├── message-pipeline.ts          ← Processes messages, runs agents
│   │   ├── task-scheduler.ts            ← Scheduled tasks
│   │   ├── tenant-config.ts             ← Loads tenants.json
│   │   ├── env.ts                       ← .env reader
│   │   ├── db.ts                        ← SQLite operations
│   │   └── output-validator.ts          ← Customer-facing output checks
│   ├── container/
│   │   ├── Dockerfile                    ← Container image recipe
│   │   ├── build.sh                      ← Build script
│   │   ├── entrypoint.sh                ← Container startup script
│   │   └── agent-runner/
│   │       └── src/
│   │           ├── index.ts              ← Runs INSIDE container, calls Claude SDK
│   │           └── ipc-mcp-stdio.ts     ← MCP tools: send_message, schedule_task
│   ├── tenants.json                      ← Tenant definitions (bots, tools, schemas)
│   ├── groups/
│   │   ├── global/
│   │   │   └── CLAUDE.md                ← Shared system prompt + safety rules
│   │   ├── main/
│   │   │   ├── CLAUDE.md                ← BrokerPilot main bot memory
│   │   │   ├── documents/               ← Downloaded files from Telegram
│   │   │   ├── logs/                    ← Container run logs
│   │   │   └── conversations/           ← Archived transcripts
│   │   ├── personal/
│   │   │   ├── CLAUDE.md                ← Personal assistant memory
│   │   │   ├── documents/
│   │   │   ├── logs/
│   │   │   └── conversations/
│   │   ├── caliort/
│   │   │   ├── CLAUDE.md                ← Caliort bot memory
│   │   │   ├── documents/
│   │   │   ├── logs/
│   │   │   └── conversations/
│   │   └── lead-capture/
│   │       ├── CLAUDE.md                ← Lead capture chatbot config
│   │       ├── documents/
│   │       ├── logs/
│   │       └── conversations/
│   ├── store/
│   │   ├── nanoclaw.db                  ← SQLite DB (messages, tasks, sessions)
│   │   └── state.json                   ← Last timestamp, session IDs
│   ├── templates/
│   │   └── broker-CLAUDE.md             ← Template for new brokers
│   ├── scripts/
│   │   ├── add-tenant.sh               ← Add a new broker
│   │   └── remove-tenant.sh            ← Remove a broker
│   ├── dist/                            ← Compiled JS (after npm run build)
│   ├── node_modules/                    ← Dependencies
│   ├── package.json
│   └── tsconfig.json
│
├── brokerpilot/                          ← BrokerPilot repo (cloned from GitHub)
│   ├── packages/shared/                  ← Shared types (used by MCP modules)
│   ├── modules/                          ← 9 MCP servers (mounted into containers)
│   ├── node_modules/                     ← Dependencies (npm install on VPS)
│   └── package.json
│
├── backups/                              ← Backup directory (create with mkdir -p)
│   └── nanoclaw-YYYYMMDD.db            ← Daily SQLite backups
│
├── .claude/
│   └── .credentials.json               ← OAuth tokens (chmod 600). Auto-created
│                                          by Claude Code CLI on first auth.
│
├── .config/
│   └── himalaya/
│       └── config.toml                  ← Email client config (if applicable)
│
└── .ssh/
    ├── id_ed25519                       ← VPS SSH key (for GitHub access)
    └── id_ed25519.pub                   ← Goes on GitHub as deploy key

/etc/systemd/system/
└── nanoclaw.service                      ← systemd service file (created by admin user)
```

### Inside Docker Containers (What the Agent Sees)

```
/workspace/
├── projects/
│   └── brokerpilot/                      ← Mounted from /home/nanoclaw/brokerpilot/ (READ-ONLY)
│       ├── packages/shared/
│       ├── modules/                      ← MCP servers run from here
│       │   ├── deal-manager/src/index.ts ← Example: npx tsx /workspace/projects/brokerpilot/modules/deal-manager/src/index.ts
│       │   └── ...
│       └── .env                          ← SHADOWED with /dev/null (invisible)
├── group/                                ← Mounted from /home/nanoclaw/nanoclaw/groups/{tenant}/ (READ-WRITE)
│   ├── CLAUDE.md                         ← Agent reads/writes this for memory
│   ├── documents/
│   ├── logs/
│   └── conversations/
├── global/                               ← Mounted from /home/nanoclaw/nanoclaw/groups/global/ (READ-ONLY)
│   └── CLAUDE.md                         ← Shared system prompt
└── ipc/                                  ← Mounted per-group (READ-WRITE)
    ├── input/                            ← Host writes new messages here
    │   └── *.json                        ← Agent polls these for follow-up messages
    ├── messages/                          ← Agent writes outbound messages here
    │   └── *.json                        ← Host polls and sends to Telegram
    └── tasks/                            ← Agent writes scheduled tasks here
        └── *.json                        ← Host polls and creates in DB

/app/                                     ← Agent runner code (compiled TypeScript)
├── dist/                                 ← Compiled agent-runner
└── node_modules/                         ← Agent runner dependencies

/home/node/.claude/                       ← Claude SDK session data (READ-WRITE)
```

---

## 2. Architecture

### Deployment Topology

```
┌──────────────────────────────────────────────────────────┐
│  VPS (Ubuntu 24.04, always on)                           │
│                                                          │
│  NanoClaw (~/nanoclaw/)                [own repo]        │
│  ├── Host process (Node.js, systemd)                     │
│  ├── Telegram bots (long-polling, outbound only)         │
│  ├── OAuth self-refresh from credentials file            │
│  └── Spawns containers per message/task                  │
│                                                          │
│  Docker containers (ephemeral, --rm)                     │
│  ├── Claude Agent SDK (uses OAuth or API key)            │
│  ├── MCP tools via stdio (inside container)              │
│  ├── --network=none (no internet access)                 │
│  ├── --security-opt=no-new-privileges                    │
│  └── Group memory mounted per-group                      │
│                                                          │
│  BrokerPilot (~/brokerpilot/)          [cloned repo]     │
│  ├── modules/ — 9 MCP servers (the business logic)       │
│  ├── packages/shared/ — types, schemas                   │
│  └── Mounted read-only into NanoClaw containers          │
│                                                          │
│  Future Projects (~/project-x/, ~/project-y/)            │
│  └── Same pattern: mount read-only, register MCP servers │
│                                                          │
│  Cloudflare Tunnel (cloudflared)                         │
│  └── Exposes dashboard AI chat endpoint only             │
│                                                          │
│  Tailscale                                               │
│  └── Admin SSH access (private mesh VPN)                 │
│                                                          │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Vercel (free tier)                                      │
│  └── Dashboard Next.js app                               │
│      ├── Talks to Supabase directly (data)               │
│      └── AI chat → Cloudflare Tunnel → NanoClaw on VPS   │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Your Mac (development only)                             │
│  ├── ~/brokerpilot/ — develop, commit, push              │
│  ├── Claude Code — for development work                  │
│  └── .mcp.json — local MCP tools for dev/debug           │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Cloud Services (already running)                        │
│  ├── Supabase — database (accessible from everywhere)    │
│  ├── Telegram API — bot messaging                        │
│  └── Anthropic API — Claude models                       │
└──────────────────────────────────────────────────────────┘
```

### MCP Connection Model

All MCP connections use **stdio transport** (not HTTP). This means:

- MCP servers run as child processes inside Docker containers
- Communication is via stdin/stdout — never touches the network
- Zero network attack surface for MCP tools
- No OAuth 2.1 infrastructure needed for MCP auth
- Projects are mounted read-only into containers

If a future project lives on a different machine, that specific connection would use Streamable HTTP with OAuth 2.1. But all same-machine connections stay on stdio.

### Per-Tenant Tool Scoping

Each NanoClaw tenant/group gets only its assigned MCP tools:

```
motorest (BrokerPilot Main):
  private: deals, email, calendar, document-store
  shared:  lender-knowledge, lender-matching, bank-statement

personal:
  private: personal-finance, personal-email, document-store
  shared:  calendar

caliort (Caliort Capital):
  private: deals, email, calendar, document-store
  shared:  lender-knowledge, lender-matching, bank-statement

lead-capture (customer-facing chatbot):
  private: deals
  shared:  (none)

future-project (example):
  private: project-x-tools
  shared:  (none)
```

---

## 3. Security Model (6 Layers)

### Layer 1: VPS Access Control

| Control | Implementation |
|---------|---------------|
| SSH keys only | `PasswordAuthentication no` in sshd_config |
| No root SSH | `PermitRootLogin no` |
| Fail2Ban | Auto-ban after failed login attempts |
| UFW firewall | Default deny incoming; allow Tailscale interface only |
| Automatic updates | `unattended-upgrades` for security patches |
| Tailscale | Private mesh VPN — SSH only through Tailscale, port 22 closed to public |

**Zero public ports.** Telegram uses outbound long-polling. Anthropic/Supabase are outbound API calls. Cloudflare Tunnel is outbound-initiated. Tailscale is peer-to-peer mesh.

### Layer 2: User Isolation

| Control | Implementation |
|---------|---------------|
| Dedicated service user | `nanoclaw` — no sudo, no login shell |
| Separate admin user | `ubuntu` (Oracle Cloud default) — has sudo for system admin |
| File permissions | `.env` and credentials: `chmod 600`, owned by `nanoclaw` |
| Principle of least privilege | Service user owns only its directories |

### Layer 3: Container Security

| Control | Implementation |
|---------|---------------|
| Non-root containers | Agents run as non-root inside containers |
| Read-only project mounts | `:ro` flag — agents can't modify source code |
| No network | `--network=none` — containers can't reach the internet |
| `.env` shadowed | Replaced with `/dev/null` inside containers |
| No-new-privileges | `--security-opt=no-new-privileges` |
| Filesystem allowlist | Only explicitly listed directories are visible |
| Ephemeral | `--rm` — containers destroyed after each session |
| Group isolation | Each group's container sees only its own group folder |

### Layer 4: Secret Management

| Secret | Handling |
|--------|---------|
| Claude OAuth tokens | `~/.claude/.credentials.json` (chmod 600). Self-refreshed by host. Only short-lived access token passed to container via stdin. |
| Supabase keys | `.env` (chmod 600). Passed via stdin JSON. Never mounted as files. |
| Telegram bot tokens | Same — `.env`, stdin delivery. |
| All API keys | Same pattern. Bash hook strips them from subprocess env inside container. |

### Layer 5: Network Security

```
Inbound: NOTHING (all ports closed to public internet)
  - Tailscale: admin SSH (private mesh)
  - Cloudflare Tunnel: dashboard AI chat (outbound-initiated)

Outbound:
  - Telegram API (bot long-polling)
  - Anthropic API (Claude SDK calls)
  - Supabase (database queries from MCP tools)
  - GitHub (git pull for code updates)
```

### Layer 6: Monitoring & Recovery

| Control | Implementation |
|---------|---------------|
| Auto-restart | systemd `Restart=always` |
| Logging | journald + container log files |
| Log rotation | Prevent disk fill |
| Orphan cleanup | Cron job to kill stale containers |
| Backup | SQLite state backed up; code in git; data in Supabase (cloud) |
| Auth failure alerts | Telegram notification on OAuth refresh failure |

---

## 4. AI Safety Guardrails

### The Hard Rule

**No autonomous external writes.** The AI must never automatically write to any external system that a customer, third party, or public audience can see. Everything outbound is draft-only — the user reviews and manually triggers the send.

### Three Categories

**Always allowed (internal reads/writes):**
- Query Supabase, read emails, search lenders, read documents
- Write to internal DB (deals, leads, call logs, notes)
- Send messages to owner's Telegram chats (internal communication)
- Create/update calendar events
- Read/write NanoClaw group memory (CLAUDE.md)

**Draft-only (customer-facing outputs):**
- Email drafts — saved to DB, owner copy-pastes to send
- SMS drafts — saved to DB, owner copy-pastes
- Document drafts — saved to files, owner reviews and sends
- Any communication intended for a customer or third party

**Blocked unless explicitly approved:**
- Direct send of any customer communication
- API calls that create/modify external resources
- Any action visible to people outside the organization

### Approved Exceptions

These actions are allowed but require explicit gating:

| Action | Gate |
|--------|------|
| GitHub push | Code review (automated + manual) → explicit approval → push |
| Email send | AI generates draft → owner/broker reviews → explicit approval → send |
| Customer-facing chatbot replies | Pre-approved per tenant in CLAUDE.md, with output validation |

### Customer-Facing Tenant Protections

For tenants like `lead-capture` where the AI replies to customers:

| Protection | Implementation |
|-----------|---------------|
| Input sanitization | Reject jailbreak patterns, offensive content |
| Output validation | Max 500 chars, compliance check, no code blocks |
| Prompt leak prevention | Block references to instructions, system prompts |
| Rate limiting | 30 messages per session |
| Session isolation | Per-user sessions (customers can't see each other) |
| No internal instructions | Customer-facing tenants skip global CLAUDE.md |
| Fallback | If any check fails → "Let me connect you with a broker..." |

### Container Breach Guarantees

If a container is compromised:

| Asset | Protected | How |
|-------|-----------|-----|
| Source code | Yes | Read-only mount, no network to exfiltrate |
| `.env` / secret files | Yes | Shadowed with `/dev/null` |
| API keys in memory | Partial | Present during execution but no network = can't exfiltrate |
| Other projects | Yes | Only assigned project mounted per group |
| Other containers | Yes | Docker process isolation |
| Host filesystem | Yes | Only mounted paths visible, no privilege escalation |

---

## 5. OAuth Self-Refresh on VPS

### Flow

```
Container spawn requested
    │
    ├── Read ~/.claude/.credentials.json
    │   (accessToken, refreshToken, expiresAt)
    │
    ├── Is accessToken expired or expiring within 5 min?
    │   ├── No → use current accessToken
    │   └── Yes → POST to https://platform.claude.com/v1/oauth/token
    │       │     grant_type=refresh_token
    │       │     refresh_token=<stored>
    │       │
    │       ├── Success → write new accessToken + expiresAt to credentials.json
    │       └── Failure → retry once after 2s
    │           ├── Success → proceed
    │           └── Failure → send Telegram notification + fall back to API key if configured
    │
    └── Pass fresh accessToken to container via stdin
```

### Initial Setup

1. Install Claude Code CLI on VPS
2. Run `claude` once interactively via SSH to authenticate
3. NanoClaw's self-refresh handles everything from there

### API Key Fallback Framework

Configuration structure is built but not active initially:

```json
{
  "routing": {
    "scheduled_tasks": { "auth": "api_key", "model": "haiku" },
    "lead_capture": { "auth": "api_key", "model": "sonnet" },
    "interactive": { "auth": "oauth", "model": "opus" },
    "default": { "auth": "oauth", "model": "sonnet" }
  }
}
```

Initially all traffic goes through Claude Max OAuth. The API key routing can be activated later for cost optimization.

---

## 6. BrokerPilot Cleanup

### What Gets Removed from BrokerPilot

- `apps/nanoclaw/` — entire directory (moved to own repo)
- NanoClaw references in root `CLAUDE.md`
- NanoClaw entries in `scripts/start-all.sh` and `scripts/stop-all.sh`
- NanoClaw plist in `launchd/`

### What Stays in BrokerPilot

```
~/brokerpilot/
├── packages/shared/          # Shared types, schemas, utilities
├── modules/                  # 9 MCP servers (the business logic)
│   ├── deal-manager/
│   ├── work-email/
│   ├── lender-knowledge/
│   ├── lender-matching/
│   ├── bank-statement/
│   ├── calendar/
│   ├── personal-finance/
│   ├── personal-email/
│   └── document-store/
├── apps/
│   └── dashboard/            # Next.js (deploys to Vercel)
├── supabase/migrations/
├── tests/
├── .mcp.json                 # For local Claude Code development
├── CLAUDE.md                 # Updated — no NanoClaw references
└── docs/plans/               # Design docs including this one
```

### What Gets Ported to NanoClaw Repo

| From `apps/nanoclaw/` | To NanoClaw repo | Action |
|----------------------|-------------------|--------|
| `tenants.json` | `tenants.json` | Port + update MCP paths |
| `src/tenant-config.ts` | Merge with upstream | Port customizations |
| `src/channels/telegram.ts` | Merge with upstream | Port topic routing |
| `src/output-validator.ts` | Port | BrokerPilot-specific validation |
| `src/container/auth.ts` | **Rewrite** | Replace Keychain with credentials.json + self-refresh |
| `src/container/mount-builder.ts` | **Rework** | Multi-project mount pattern |
| `groups/main/CLAUDE.md` | `groups/main/CLAUDE.md` | Copy memory |
| `groups/personal/CLAUDE.md` | `groups/personal/CLAUDE.md` | Copy memory |
| `groups/caliort/CLAUDE.md` | `groups/caliort/CLAUDE.md` | Copy memory |
| `groups/lead-capture/CLAUDE.md` | `groups/lead-capture/CLAUDE.md` | Copy memory |
| `groups/global/CLAUDE.md` | `groups/global/CLAUDE.md` | Port + add safety guardrails |
| `scripts/add-tenant.sh` | `scripts/add-tenant.sh` | Port |
| `scripts/remove-tenant.sh` | `scripts/remove-tenant.sh` | Port |
| `container/Dockerfile` | `container/Dockerfile` | Port |
| `container/agent-runner/` | `container/agent-runner/` | Port + update MCP builder |
| `templates/` | `templates/` | Port |

---

## 7. Migration Phases

### Phase 1: Provision & Harden VPS
### Phase 2: Set Up NanoClaw on VPS
### Phase 3: Move BrokerPilot to VPS
### Phase 4: Dashboard Deployment (Vercel + Cloudflare Tunnel)
### Phase 5: Cutover & Decommission on Mac

See companion document: `2026-03-17-nanoclaw-separation-guide.md` for detailed step-by-step instructions.

---

## 8. Post-Migration Workflow

### Daily Development

```
Mac: edit BrokerPilot code → commit → push to GitHub
VPS: cd ~/brokerpilot && git pull && npm install
     (NanoClaw picks up changes on next container spawn)
```

### Adding a New Project to NanoClaw

1. Create the project with MCP servers
2. Clone to VPS: `~/project-x/`
3. Add mount config in NanoClaw: point to `~/project-x/`
4. Register MCP servers in tenant config
5. Create a group folder with CLAUDE.md for the project
6. Restart NanoClaw

### Updating NanoClaw Itself

```
VPS: cd ~/nanoclaw
     Use /update-nanoclaw skill to merge upstream changes
     Resolve conflicts in your customizations
     Restart systemd service
```
