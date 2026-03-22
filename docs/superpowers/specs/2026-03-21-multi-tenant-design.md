# NanoClaw Multi-Tenant Design

**Date:** 2026-03-21
**Status:** Approved
**Author:** Claude (design), Andry (decisions)

---

## 1. Overview

### Goal

Transform NanoClaw from a single-bot system into a multi-tenant broker platform. Each broker gets their own Telegram bot, scoped MCP tools pointed at their own database schema, forum groups with topic routing, and isolated conversation sessions. The architecture supports 5-20 brokers with strict data isolation, running as a single NanoClaw process.

### Tenants

| Tenant | Bot | Type | DB Schema | Chats |
|--------|-----|------|-----------|-------|
| main | @AHBrokerPilot_bot | Broker (admin) | work | DM + Operations group + Leads group |
| personal | @PersonalBot | System (admin) | personal | DM |
| caliort | @DinnerBros | Broker | caliort | DM (→ Operations + Leads groups later) |
| lead-capture | TestChat | Customer-facing (lead collection + callback booking only) | work | Single customer chat |

### Key Architecture Decisions

1. **Single process, multi-bot.** One NanoClaw instance runs all bots. Shared database, shared credential proxy, per-tenant containers.
2. **Queue by folder, not chatJid.** All chats for a broker serialize through one container queue. Prevents session/IPC race conditions.
3. **Session resolver.** Composite session keys support per-lead and per-customer isolation within a single group folder.
4. **Per-tenant .mcp.json generation.** Tools and DB_SCHEMA scoped per broker automatically from tenants.json.
5. **3-layer topic routing.** [DEAL_ID] -> [ROUTE:category] -> heuristic fallback, with sticky context and deal-ID injection backstop.

---

## 2. Tenant Configuration

### tenants.json Structure

```json
{
  "defaults": {
    "timezone": "Australia/Sydney",
    "briefingTime": "08:30",
    "quietHoursStart": 20,
    "quietHoursEnd": 7
  },
  "brokerDefaults": {
    "jidPrefix": "tg",
    "isAdmin": false,
    "isCustomerFacing": false,
    "requiresTrigger": false,
    "status": "active",
    "privateTools": ["deal-manager", "work-email", "calendar", "document-store"],
    "sharedTools": ["lender-knowledge", "lender-matching", "bank-statement"],
    "ai": { "mode": "platform" }
  },
  "system": [
    {
      "id": "personal",
      "name": "Personal Assistant",
      "assistantName": "Personal",
      "botToken": "env:TELEGRAM_PERSONAL_BOT_TOKEN",
      "groupFolder": "personal",
      "dbSchema": "personal",
      "isAdmin": true,
      "privateTools": ["personal-finance", "personal-email", "calendar", "document-store", "bank-statement"],
      "sharedTools": [],
      "contacts": { "owner": "env:TELEGRAM_PERSONAL_CHAT_ID" },
      "chats": { "dm": "env:TELEGRAM_PERSONAL_CHAT_ID" }
    },
    {
      "id": "lead-capture",
      "name": "Lead Capture Chatbot",
      "assistantName": "TestChat",
      "botToken": "env:TELEGRAM_LEAD_BOT_TOKEN",
      "groupFolder": "lead-capture",
      "dbSchema": "work",
      "isCustomerFacing": true,
      "privateTools": ["deal-manager", "calendar"],
      "sharedTools": [],
      "contacts": { "owner": "env:TELEGRAM_CHAT_ID", "notifyOnError": true },
      "chats": { "dm": "env:TELEGRAM_LEAD_CHAT_ID" }
    }
  ],
  "brokers": [
    {
      "id": "main",
      "name": "BrokerPilot Main",
      "assistantName": "BrokerPilot",
      "botToken": "env:TELEGRAM_BOT_TOKEN",
      "groupFolder": "main",
      "dbSchema": "work",
      "himalayaAccount": "work",
      "isAdmin": true,
      "contacts": { "owner": "env:TELEGRAM_CHAT_ID" },
      "chats": {
        "dm": "env:TELEGRAM_CHAT_ID",
        "operations": {
          "chatId": "env:TELEGRAM_MAIN_OPS_GROUP_ID",
          "topics": {
            "calendar-tasks-alerts": "Calendar / Tasks / Alerts",
            "lender-knowledge": "Lender Knowledge",
            "bank-statements": "Bank Statements",
            "lender-matching": "Lender Matching"
          }
        },
        "leads": "env:TELEGRAM_MAIN_LEADS_GROUP_ID"
      }
    },
    {
      "id": "caliort",
      "name": "Caliort Capital",
      "assistantName": "DinnerBros",
      "botToken": "env:BROKER_CALIORT_TOKEN",
      "groupFolder": "caliort",
      "dbSchema": "caliort",
      "himalayaAccount": "caliort",
      "contacts": { "owner": "env:BROKER_CALIORT_CHAT_ID" },
      "chats": { "dm": "env:BROKER_CALIORT_CHAT_ID" }
    }
  ]
}
```

### Key Fields

- **`env:VAR`** -- resolved from .env at load time
- **`brokerDefaults`** -- inherited by all brokers, override per-broker
- **`system` / `brokers`** -- separate arrays; add-tenant.sh only touches brokers
- **`status`** -- active / paused / suspended / deactivated
- **`ai.mode`** -- "platform" (shared Claude Max) or "own" (BYOK, v2)
- **`contacts.owner`** -- receives error notifications and alerts
- **`chats.operations.topics`** -- static forum topics created at startup

### Adding a New Broker

Add a block to `brokers` array (inherits tools, settings from `brokerDefaults`):

```json
{
  "id": "newbroker",
  "name": "New Broker Co",
  "assistantName": "NewBrokerBot",
  "botToken": "env:BROKER_NEWBROKER_TOKEN",
  "groupFolder": "newbroker",
  "dbSchema": "newbroker",
  "contacts": { "owner": "env:BROKER_NEWBROKER_CHAT_ID" },
  "chats": { "dm": "env:BROKER_NEWBROKER_CHAT_ID" }
}
```

Plus: add bot token to `.env`, create Supabase schema, create group folder from template.

---

## 3. Multi-Bot Architecture

### Startup Flow

```
NanoClaw starts
  |
  +-- Load tenants.json
  |   +-- Resolve env:VAR from .env
  |   +-- Merge brokerDefaults into each broker
  |   +-- Validate with Zod schema
  |
  +-- For each tenant:
  |   +-- Create TelegramChannel(botToken, assistantName)
  |   +-- Register chats as groups in database:
  |   |     tg:{dmChatId}         -> groups/{folder}
  |   |     tg:{opsChatId}        -> groups/{folder}
  |   |     tg:{leadsChatId}      -> groups/{folder}
  |   +-- Create static forum topics (if operations group configured)
  |   +-- Store tenant metadata for runtime lookups
  |
  +-- Start message loop (polls per group folder)
  +-- Start task scheduler
  +-- Start IPC watcher
```

### Queue by Folder with Per-Topic Parallelism

Topics can run in **shared** mode (queued together, share memory) or **independent** mode (parallel, own session). Configured per-topic or auto-detected from tool mapping.

```
GroupQueue keys for "main" broker:

Shared session (queued together):
  "main"              <- DM + Calendar/Tasks/Alerts (share memory)

Independent sessions (run in parallel):
  "main:topic:lk"     <- Lender Knowledge
  "main:topic:bs"     <- Bank Statements
  "main:topic:lm"     <- Lender Matching
  "main:lead:{dealId}" <- Per-customer lead topics (always independent)

Other brokers:
  "personal"           <- PersonalDM
  "caliort"            <- CaliortDM
  "lead-capture"       <- LeadChat (per-customer sessions)
```

All queues across different brokers and independent topics run in parallel. Queuing only happens within a shared session (e.g., DM waits for a Calendar/Tasks alert to finish, but Bank Statements runs independently).

**Auto-detection rule:** Topics mapped to a specific MCP tool category (lender-knowledge, bank-statement, lender-matching) automatically run as independent. General-purpose topics (Calendar/Tasks/Alerts) stay shared with DM. Override via tenant config:

```json
{
  "chats": {
    "operations": {
      "chatId": "env:TELEGRAM_MAIN_OPS_GROUP_ID",
      "topics": {
        "calendar-tasks-alerts": { "name": "Calendar / Tasks / Alerts", "session": "shared" },
        "lender-knowledge":      { "name": "Lender Knowledge",         "session": "independent" },
        "bank-statements":       { "name": "Bank Statements",          "session": "independent" },
        "lender-matching":       { "name": "Lender Matching",          "session": "independent" }
      }
    }
  }
}
```

### Priority Queue for Shared Sessions

When DM and Calendar/Tasks/Alerts share a queue, messages are prioritized:

```
Priority 1 (highest): DM messages (broker is actively typing)
Priority 2:           Topic replies (broker replied in a topic)
Priority 3 (lowest):  Scheduled tasks (alerts, briefings -- can wait)
```

If a scheduled briefing is processing and you send a DM message, the DM queues but jumps ahead of any other pending scheduled tasks.

### Cross-Topic Context Sharing

Independent topics can't see each other's conversation history, but they share data through a context table:

```sql
CREATE TABLE topic_context (
  group_folder TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  context_type TEXT NOT NULL,
  deal_id TEXT,
  summary TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_folder, topic_key, context_type)
);
```

When an independent topic completes a task, the agent writes a short summary:

```
topic_key: "main:topic:bs"
context_type: "bank_analysis"
deal_id: "abc-123"
summary: "Analysed John Smith's bank statement. Monthly income: $8,200.
          Living expenses: $3,100. Surplus: $5,100. 3 NSF fees in 6 months."
```

Other topics and the shared DM session can read these summaries. When you say in DM "based on the bank statement analysis, draft an email to ANZ", the system detects the cross-reference, fetches the summary, and injects it:

```
[CONTEXT FROM OTHER TOPICS]
Bank Statements (2 min ago): Analysed John Smith's bank statement.
Monthly income: $8,200. Living expenses: $3,100. Surplus: $5,100.
3 NSF fees in last 6 months.
[END CONTEXT]

User: Based on the bank statement analysis, draft an email to ANZ...
```

The DM agent didn't "see" the bank statement conversation, but it has the key facts.

### Session Warming for Independent Topics

Independent topics start fresh but are pre-loaded with:
1. The group's CLAUDE.md (memory and instructions)
2. Topic routing rules for this specific topic
3. Recent entries from `topic_context` (what other topics have been doing)
4. Last 3 messages in this topic (reconstructed from database)

This makes independent topics feel continuous rather than cold-start.

Messages from shared-session chats arriving simultaneously get batched into one prompt with chat/topic context. The agent processes all and routes responses via [ROUTE:tag].

### Group Registration in Database

```
registered_groups table:
  tg:8611182982       -> folder: main        (DM)
  tg:-100XXXXX        -> folder: main        (Operations group)
  tg:-100YYYYY        -> folder: main        (Leads group)
  tg:PERSONAL_ID      -> folder: personal    (Personal DM)
  tg:CALIORT_ID       -> folder: caliort     (Caliort DM)
  tg:LEAD_ID          -> folder: lead-capture (Lead chat)
```

---

## 4. Per-Tenant MCP Tool Scoping

### .mcp.json Generation

Each tenant gets a generated `.mcp.json` based on their `privateTools` + `sharedTools` + `dbSchema`. Generated to `data/sessions/{folder}/generated-mcp.json` at container startup. Merged with any manual overrides in `groups/{folder}/.mcp.json`.

**Example -- caliort (inherits brokerDefaults):**
- privateTools: deal-manager, work-email, calendar, document-store
- sharedTools: lender-knowledge, lender-matching, bank-statement
- DB_SCHEMA: "caliort"

Produces 7 MCP servers, each with `DB_SCHEMA=caliort` for schema-scoped tools.

**Example -- lead-capture:**
- privateTools: deal-manager, calendar
- sharedTools: (none)
- DB_SCHEMA: "work"

Produces 2 MCP servers (deal creation + callback booking).

### MCP Template Registry

```typescript
const MCP_TEMPLATES: Record<string, McpTemplate> = {
  'deal-manager': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/deal-manager/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'lender-knowledge': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/lender-knowledge/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VOYAGE_API_KEY'],
    schemaScoped: false,  // shared across tenants
  },
  // ... all 9 tools
};
```

### allowedTools Per Tenant

Passed via `ContainerInput` (new field). Agent-runner uses it if present:

```typescript
// Broker (admin):
['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
 'Task', 'TaskOutput', 'TaskStop', 'TeamCreate', 'TeamDelete', 'SendMessage',
 'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
 'mcp__nanoclaw__*', 'mcp__deal-manager__*', 'mcp__work-email__*', ...]

// Customer-facing:
['Read', 'Glob', 'Grep',  // No Bash, no Write, no Web
 'mcp__nanoclaw__*', 'mcp__deal-manager__*']
```

### Data Isolation (Phased)

| Phase | Mechanism | Prevents |
|-------|-----------|----------|
| v1 | Per-tenant .mcp.json with DB_SCHEMA | MCP tools only query tenant's schema |
| v1 | Per-tenant allowedTools | Customer bots can't use Bash/Write/Web |
| v1 | Container mount isolation (existing) | Container sees only its group folder |
| Phase 2 | Remove SUPABASE_SERVICE_ROLE_KEY from container -e flags | Bash can't access any Supabase schema |
| Phase 2 | Per-broker .env files | Scoped credentials per tenant |
| Phase 3 | Supabase RLS migrations | Database-level isolation |

---

## 5. Forum Topics & Message Routing

### Per-Broker Chat Structure

```
@AHBrokerPilot_bot (main)
+-- DM chat (tg:8611182982)              -> groups/main
+-- Operations group (tg:-100XXXXX)       -> groups/main
|   +-- General
|   +-- Calendar / Tasks / Alerts
|   +-- Lender Knowledge
|   +-- Bank Statements
|   +-- Lender Matching
+-- Leads group (tg:-100YYYYY)           -> groups/main
    +-- [Customer Name 1] (dynamic topic)
    +-- [Customer Name 2] (dynamic topic)
```

All 3 chats -> same group folder -> same container queue -> same agent session (except leads get per-deal sessions).

### 3-Layer Routing Chain

```
Agent response arrives
    |
    +-- Layer 1: [DEAL_ID:uuid] tag?
    |   +-- YES -> deal topic cache -> Send to lead's topic
    |   +-- NO  v
    |
    +-- Layer 2: [ROUTE:category] tag?
    |   +-- YES -> topic map -> Send to operations topic
    |   +-- NO  v
    |
    +-- Layer 3: Heuristic regex classification
        +-- Match -> Best-guess topic
        +-- No match -> General topic or DM
```

**Categories:** calendarTasksAlerts, lenderKnowledge, bankStatements, lenderMatching, general

### Reliability Backstops

1. **Deal ID injection from tool context.** If agent forgets [DEAL_ID:uuid], extract from most recent deal-related tool call (create_deal, update_deal, etc.). Deterministic, not LLM-dependent.

2. **Sticky topic within invocation.** Once a topic is resolved in a multi-message response, subsequent messages reuse it. Prevents "Let me check..." going to General and "Here are results..." going to the correct topic.

3. **Incoming message context.** When a user replies inside a specific topic, the message_thread_id is included in the prompt context so the agent knows where to respond.

4. **Cross-topic context summaries.** When an independent topic completes a task, it writes a summary to `topic_context`. Other sessions (including shared DM) can reference these. Enables "based on the bank statement analysis, draft an email" from DM even though the analysis ran in a parallel session.

### Session Management (Revised)

Session resolver determines which Claude session and queue to use:

```
Message arrives from chatJid + topicId
    |
    +-- Is it a leads group topic?
    |   +-- Reverse-lookup dealId from topic_mappings
    |   +-- Session key: "{folder}:lead:{dealId}"
    |   +-- Queue key: "{folder}:lead:{dealId}" (always independent)
    |   +-- Inject deal context preamble
    |
    +-- Is it a customer-facing chat?
    |   +-- Session key: "{folder}:customer:{senderId}"
    |   +-- Queue key: "{folder}:customer:{senderId}" (always independent)
    |   +-- Fresh session each invocation (no resume)
    |
    +-- Is it an independent operations topic?
    |   +-- Session key: "{folder}:topic:{topicKey}"
    |   +-- Queue key: "{folder}:topic:{topicKey}" (parallel)
    |   +-- Pre-load: CLAUDE.md + topic_context + last 3 messages
    |
    +-- Otherwise (DM, shared operations topics)
        +-- Session key: "{folder}"
        +-- Queue key: "{folder}" (shared, queued)
        +-- Inject cross-topic context summaries if referenced
        +-- Resume existing session
```

**Per-lead sessions** ensure Customer A's financial data is never in Customer B's context window.

**Customer-facing sessions** use fresh sessions each invocation (no resume). The state machine stays authoritative.

**Independent topic sessions** run in parallel with the shared session and with each other. They share data via `topic_context` table, not conversation history.

**Shared session** handles DM + general-purpose topics. Cross-topic references resolved by injecting summaries from `topic_context`.

### Lead Topic Lifecycle

```
New lead detected
    +-- create_deal via MCP tool
    +-- Create topic: "[Name] - [Asset Type]"
    +-- Store mapping: deal_id -> topic_id
    +-- Post initial summary

Ongoing
    +-- All deal messages routed via [DEAL_ID:uuid]
    +-- Reverse lookup on incoming topic messages

Stage change
    +-- Rename topic: "[Name] - [Asset] (Application)"

Settled/Lost
    +-- Post final summary, archive topic
    +-- Preserve session data (compliance)
```

### Database Additions

```sql
-- Maps Telegram forum topics to deals for routing
CREATE TABLE topic_mappings (
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  topic_name TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  deal_id TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_jid, topic_id)
);

-- Shares context between independent topic sessions
CREATE TABLE topic_context (
  group_folder TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  context_type TEXT NOT NULL,
  deal_id TEXT,
  summary TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_folder, topic_key, context_type)
);
```

---

## 6. Customer-Facing Bot Protections

### 7-Layer Protection Stack

| Layer | What | How |
|-------|------|-----|
| 1 | Conversation state machine | 7-state flow: welcome -> ask_needs -> ask_contact -> ask_callback -> confirm -> create_lead -> handoff |
| 2 | Sandwich defense | Instructions before AND after user message block in prompt |
| 3 | Input sanitizer | Jailbreak patterns, Unicode homoglyphs, length limits |
| 4 | Structured output | Agent outputs JSON; only `response` field sent to customer |
| 5 | Output validator | PII detection (TFN, BSB, account numbers), internal reference filter, blocks any finance discussion (rates, terms, LVR, approval) |
| 6 | Rate limiter | Token bucket: 30 messages/session, 1 per 2 seconds refill |
| 7 | Compliance | Privacy Act notice, conversation logging (7-year retention) |

### Purpose

The lead-capture bot is a **lead collection tool only**. It does NOT discuss finance, rates, terms, lender options, or give any advice. Its sole job is to:
1. Greet the customer warmly
2. Find out what they need (asset type, rough amount)
3. Collect contact details (name, phone, email)
4. Optionally book a callback via calendar
5. Create the lead in the system
6. Hand off to a real broker

If the customer asks finance questions ("What's the interest rate?", "Can I get approved?", "Which lender is best?"), the bot redirects: "Great question! That's exactly what our broker will cover with you. Let me get your details so they can call you back."

### State Machine

```
WELCOME -> ASK_NEEDS -> ASK_CONTACT -> ASK_CALLBACK -> CONFIRM -> CREATE_LEAD -> HANDOFF
```

| State | Collects | Bot says |
|-------|----------|----------|
| WELCOME | Nothing | Greeting + privacy notice |
| ASK_NEEDS | Asset type, rough amount, timeline | "What are you looking to finance?" |
| ASK_CONTACT | Name, phone, email | "So we can have a broker get back to you..." |
| ASK_CALLBACK | Preferred callback time (optional) | "When's a good time for a broker to call?" |
| CONFIRM | Nothing (reviews collected data) | "Just to confirm: [summary]. Is that right?" |
| CREATE_LEAD | Nothing (calls create_deal + optionally schedule_callback) | "All set! A broker will be in touch." |
| HANDOFF | Follow-up questions only | Redirects finance questions, answers basic process questions |

Each state has:
- Expected input (what fields to collect)
- System prompt (scoped to current step)
- Validation (phone format, email format, etc.)
- Finance-question redirect (any state)
- Fallback if LLM goes off-script

### Fresh Sessions (No Resume)

Customer-facing bots start fresh Claude sessions each invocation. Conversation history is reconstructed from the database and injected into the prompt. The state machine stays authoritative -- the agent can't "remember" rolled-back states.

### Sandbox Configuration

```json
{
  "id": "lead-capture",
  "isCustomerFacing": true,
  "privateTools": ["deal-manager", "calendar"],
  "allowedTools": ["Read", "Glob", "Grep", "mcp__nanoclaw__*", "mcp__deal-manager__*", "mcp__calendar__*"],
  "networkMode": "host"
}
```

Tools: `deal-manager` (create lead) + `calendar` (book callback). No Bash, no Write, no WebSearch, no WebFetch, no lender tools, no email tools. Network access kept (needed for Claude API and Supabase).

### Australian Compliance

**Welcome message (every new customer):**

```
Hi! I'm [Bot Name] from [Business Name].

I'm here to connect you with one of our brokers who can
help with vehicle, equipment, and business finance.

I'll just need a few quick details so the right broker
can get back to you.

We collect your name, contact details, and what you're
looking for to match you with a broker.
Privacy policy: [link]

What are you looking to finance?
```

The bot does NOT discuss rates, terms, lender options, approval chances, or any financial details. It collects lead info and books callbacks only.

**Compliance log table:**

```sql
CREATE TABLE compliance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  customer_id TEXT,
  event_type TEXT NOT NULL,
  reason TEXT,
  original_content TEXT,
  replacement_content TEXT,
  metadata TEXT
);
```

Retained 7 years (ASIC/AML requirement).

---

## 7. Cybersecurity

### Docker Container Hardening

```typescript
// All containers:
'--security-opt=no-new-privileges'
'--cap-drop=ALL'
'--pids-limit', '100'
'--rm'

// Memory limits (tiered):
// Broker (7-9 MCP servers): --memory 1024m
// Personal (5 MCP servers):  --memory 768m
// Customer-facing (1 tool):  --memory 256m
```

### OWASP LLM Top 10 Coverage

| Risk | Level | Primary Control |
|------|-------|----------------|
| LLM01 Prompt Injection | Low | Sandwich defense + state machine + input sanitizer + output validator |
| LLM02 Sensitive Disclosure | Medium (v1), Low (Phase 2) | Per-tenant DB_SCHEMA + Phase 2 credential isolation |
| LLM03 Supply Chain | Low | Pinned deps, npm audit, container CVE scanning |
| LLM04 Data Poisoning | Very Low | Global CLAUDE.md read-only, per-group sessions |
| LLM05 Improper Output | Low | Output validator, PII detection, topic routing |
| LLM06 Excessive Agency | Low | Tool restrictions, draft-only policy |
| LLM07 Prompt Leakage | Low | Input/output filters, no global CLAUDE.md for customer bots |
| LLM08 Vector Weaknesses | Very Low | RAG uses verified docs, not customer-accessible |
| LLM09 Misinformation | Very Low (customer), Medium (broker) | Lead-capture bot doesn't discuss finance at all. Broker output has ASIC compliance checks. |
| LLM10 Unbounded Consumption | Low | Rate limiter, container limits, global cap 25 |

### Data Isolation by Phase

| Phase | Mechanism | When |
|-------|-----------|------|
| v1 | Per-tenant .mcp.json + DB_SCHEMA + allowedTools + mount isolation | Now |
| Phase 2 | Remove secrets from container env + per-broker .env files | Before external brokers |
| Phase 3 | Supabase RLS + LUKS encryption + bridge network with firewall | At scale |

### Audit Logging

Structured security events via Pino logger:
- container_spawned, container_terminated
- ipc_authorized, ipc_blocked
- input_sanitizer_blocked, output_validator_blocked
- rate_limit_triggered, credential_proxy_request

### Backup & Disaster Recovery

| Tier | What | When | RPO |
|------|------|------|-----|
| Daily local | SQLite hot backup + groups/ + tenants.json | Week 1 | 24h |
| Weekly offsite | Encrypted upload to cloud storage | Month 1 | 7 days |
| Quarterly test | Full restore from backup | Ongoing | Verified |

### Australian Regulatory

| Requirement | Status |
|-------------|--------|
| ASIC: No rates/guarantees in customer output | Covered (output validator) |
| ASIC: General info disclaimer | Covered (welcome message) |
| Privacy Act: Collection notice | Covered (welcome message) |
| Privacy Act: Cross-border disclosure (Anthropic API = US) | Covered (privacy policy states US processing) |
| OAIC: Mandatory data breach notification (30 days) | Covered (incident response playbook) |
| AML: 7-year record keeping | Covered (compliance_log table) |

### Incident Response (Summary)

| Scenario | Detection | Response |
|----------|-----------|----------|
| Container escape | Seccomp violation in journal | Stop service, preserve evidence, analyse, notify OAIC if PII exposed |
| API key compromise | Unusual API usage alert | Revoke key, rotate .env, restart, notify brokers |
| Prompt injection at scale | Output validator spike | Kill container, review messages, update sanitizer patterns |

### Secret Management Roadmap

| Phase | Approach |
|-------|----------|
| Current | .env file, credential proxy replaces placeholders |
| Phase 2 | Per-broker .env files, MCP env via SDK config only |
| Phase 3 | age encryption for .env at rest |
| Phase 4 | HashiCorp Vault (if SOC2 required) |

---

## 8. Implementation Priority

### P0 -- Before Multi-Tenant Launch

| Task | Files | Effort |
|------|-------|--------|
| Create tenants.json + loader (tenant-config.ts) | New: src/tenant-config.ts | 4h |
| Multi-bot TelegramChannel (per-tenant) | src/channels/telegram.ts, src/index.ts | 6h |
| Queue by folder with per-topic parallelism | src/group-queue.ts, src/index.ts | 4h |
| Session resolver (composite keys + topic independence) | src/index.ts, src/db.ts | 4h |
| Priority queue (DM > topic reply > scheduled task) | src/group-queue.ts | 2h |
| .mcp.json generator from tenant config | New: src/mcp-config-generator.ts | 3h |
| allowedTools in ContainerInput | src/container-runner.ts, src/types.ts, container/agent-runner/src/index.ts | 2h |
| Container hardening (--cap-drop, --pids-limit, --memory) | src/container-runner.ts | 1h |
| Daily backup cron | New: backup.sh, crontab | 30m |
| Tiered memory limits | src/container-runner.ts | 1h |

### P1 -- Forum Topics & Routing

| Task | Files | Effort |
|------|-------|--------|
| Topic routing (3-layer chain) | New: src/topic-routing.ts | 4h |
| Forum topic management (create, rename, archive) | src/channels/telegram.ts | 3h |
| Message context (chat type, topic name, topicId) | src/router.ts | 2h |
| send_message with topicId + createTopic | container/agent-runner/src/ipc-mcp-stdio.ts, src/ipc.ts | 3h |
| topic_mappings table | src/db.ts | 1h |
| topic_context table + cross-topic sharing | src/db.ts, container/agent-runner/src/index.ts | 3h |
| Session warming for independent topics | src/container-runner.ts, container/agent-runner/src/index.ts | 2h |
| Smart session bridging (cross-topic reference injection) | src/index.ts, src/router.ts | 2h |
| Deal ID injection backstop | container/agent-runner/src/index.ts | 2h |
| Lead handler (per-lead sessions, context injection) | New: src/lead-handler.ts | 4h |
| Sticky topic context | src/topic-routing.ts | 1h |
| CLAUDE.md templates with routing rules | templates/broker-CLAUDE.md | 2h |

### P2 -- Customer-Facing Protections

| Task | Files | Effort |
|------|-------|--------|
| Lead state machine | New: src/lead-state-machine.ts | 4h |
| Sandwich defense prompt builder | New: src/prompt-builder.ts | 2h |
| Input sanitizer | New: src/input-sanitizer.ts | 2h |
| Output validator (enhanced with PII) | New: src/output-validator.ts | 3h |
| Rate limiter (token bucket) | New: src/rate-limiter.ts | 2h |
| Customer CLAUDE.md template | templates/customer-CLAUDE.md | 1h |
| Skip global CLAUDE.md for customer-facing | container/agent-runner/src/index.ts | 30m |
| Fresh sessions for customer-facing (no resume) | src/index.ts, src/container-runner.ts | 2h |
| Compliance log table | src/db.ts | 1h |
| ASIC disclaimers + privacy notice | templates/customer-CLAUDE.md | 1h |

### P3 -- Security Hardening (Before External Brokers)

| Task | Files | Effort |
|------|-------|--------|
| Audit logging (structured security events) | src/container-runner.ts, src/ipc.ts, src/credential-proxy.ts | 3h |
| Per-broker .env files | src/env.ts, src/credential-proxy.ts | 2h |
| Remove service role key from container -e flags | src/container-runner.ts | 2h |
| Incident response playbook doc | New: docs/INCIDENT_RESPONSE.md | 2h |
| Privacy policy + DPA docs | New: docs/PRIVACY_POLICY.md, docs/DPA.md | 4h |
| Offsite encrypted backups | backup.sh enhancement | 1h |
| agent-runner-src mount read-only for non-admin | src/container-runner.ts | 30m |

### V2 Features (Deferred)

Tracked in memory at `memory/project_v2_features.md`:
- maxContainers per-tenant throttling
- Feature flags for plan tiers
- onboardedAt / plan for billing
- Hot-reload tenants.json
- Per-tenant AI credentials (BYOK)
- Model routing (Haiku for lead-capture, Opus for brokers)
- Secondary LLM input classifier
- Per-tenant Supabase projects
- LUKS disk encryption
- HashiCorp Vault

---

## 9. Cross-Section Conflict Resolutions

Issues found during cross-section review and their resolutions:

| Conflict | Resolution |
|----------|------------|
| networkMode "none" breaks lead-capture (needs Claude API + Supabase) | Keep "host" network for all. Rely on other 6 protection layers. Air-gapped option deferred to v2. |
| Three session scoping models incompatible | Session resolver with composite keys: "folder", "folder:lead:dealId", "folder:customer:senderId" |
| Multiple chats to same folder causes queue/IPC race | Queue by group folder with per-topic parallelism. Shared topics queue together, independent topics (tool-mapped) run in parallel with own sessions. Cross-topic data shared via topic_context table. |
| 512MB memory insufficient for 9 MCP servers | Tiered: 1024m broker, 768m personal, 256m customer-facing |
| .mcp.json generation overwrites hand-crafted configs | Generate to data/sessions/{folder}/. Merge with group folder overrides. |
| State machine vs session history divergence | Fresh sessions for customer-facing (no resume). State machine stays authoritative. |
| allowedTools not in ContainerInput | Add to ContainerInput. Agent-runner reads from stdin JSON. Absent = current hardcoded list (backward compatible). |
| Global ASSISTANT_NAME singleton vs per-tenant names | Replace global config with per-tenant lookup. Tenant metadata stored in registeredGroups. Trigger pattern resolved per group at message processing time. |
| Channel.sendMessage(jid, text) interface lacks topicId | Extend to sendMessage(jid, text, options?: { topicId?, createTopic? }). Non-Telegram channels ignore options. |
| Generated .mcp.json path not visible inside container | Host merges generated config + group overrides, writes result to groups/{folder}/.mcp.json before container startup. Agent-runner reads from /workspace/group/.mcp.json as before. |
| NOW() invalid in SQLite | Use DEFAULT CURRENT_TIMESTAMP |
| Memory tier not tied to tenant config | Derive from isCustomerFacing + tool count. isCustomerFacing=true -> 256m. Tools <= 5 -> 768m. Tools > 5 -> 1024m. |
| himalayaAccount field undocumented | Email account identifier for himalaya CLI. Maps to ~/.config/himalaya/config.toml account section. Used by work-email and personal-email MCP tools. |

---

## 10. Migration from Single-Tenant

### Existing Data Preservation

The VPS currently has:
- `registered_groups` table with 3 JIDs (tg:8611182982, tg:-100XXXXX, tg:-100YYYYY)
- `sessions` table with session IDs keyed by group folder
- Group folders with CLAUDE.md, .mcp.json, conversations, logs

### Migration Steps

1. **Create tenants.json** from current .env values and group folder structure. No data loss.

2. **Migrate sessions table:**
```sql
-- Rename column for clarity (data preserved)
ALTER TABLE sessions RENAME COLUMN group_folder TO session_key;
-- Existing rows like "main" still work as session keys
```

3. **Update registered_groups at startup.** On first launch with tenants.json, NanoClaw re-registers all groups from tenant config. Existing registrations for the same JIDs get updated (folder stays the same). New JIDs (operations group, leads group) get added.

4. **Existing .mcp.json files become overrides.** The generator writes the base config from tenant tools. Existing hand-crafted .mcp.json content is preserved as the override layer. On first run, existing configs are renamed to .mcp.override.json, and the merged result is written to .mcp.json.

5. **No container rebuild needed.** Agent-runner changes (allowedTools from ContainerInput) are compiled on container startup from the source mount.

### Backward Compatibility

If tenants.json does not exist, NanoClaw falls back to current single-bot behavior (reads TELEGRAM_BOT_TOKEN from env, single channel). This allows gradual migration.

---

## 11. Technical Specifications

### ContainerInput Interface Change

```typescript
// src/types.ts and container/agent-runner/src/index.ts
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  // NEW fields:
  allowedTools?: string[];       // Per-tenant tool whitelist
  isCustomerFacing?: boolean;    // Skip global CLAUDE.md, enable output validation
  tenantId?: string;             // For audit logging
}
```

When `allowedTools` is absent, the agent-runner uses its current hardcoded list (full backward compatibility).

### Session Table Schema Change

```sql
-- Migration
ALTER TABLE sessions RENAME COLUMN group_folder TO session_key;

-- New usage:
-- session_key = "main"                    (broker session)
-- session_key = "main:lead:abc-123"       (per-lead session)
-- session_key = "lead-capture:customer:111" (per-customer session)
```

`getSession()` and `setSession()` in db.ts change parameter name from `groupFolder` to `sessionKey`. Callers pass the result of the session resolver.

### Queue-by-Folder Data Model

```typescript
// Current: registeredGroups keyed by JID
registeredGroups: Record<string, RegisteredGroup>
// "tg:123" -> { folder: "main", ... }

// NEW: add reverse lookup
folderToJids: Record<string, string[]>
// "main" -> ["tg:123", "tg:456", "tg:789"]

// GroupQueue changes:
// Key: group folder (not chatJid)
// enqueueMessageCheck("main") instead of enqueueMessageCheck("tg:123")
```

### Multi-JID Message Batching

```typescript
// In processGroupMessages():
async function processGroupMessages(folder: string) {
  const jids = folderToJids[folder];  // ["tg:DM", "tg:OpsGroup", "tg:LeadsGroup"]

  // Collect messages from ALL JIDs for this folder
  const allMessages: NewMessage[] = [];
  for (const jid of jids) {
    const msgs = getMessagesSince(jid, lastTimestamp[jid]);
    allMessages.push(...msgs);
  }

  // Sort by timestamp
  allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Format with chat context
  const prompt = formatMessagesWithChatContext(allMessages, jidMetadata);
  // Each message includes: sender, time, chat type, topic name, topicId
}
```

### Channel Interface Extension

```typescript
// src/types.ts
interface Channel {
  name: string;
  ownsJid(jid: string): boolean;
  sendMessage(jid: string, text: string, options?: MessageOptions): Promise<void>;
  // ...
}

interface MessageOptions {
  topicId?: number;
  createTopic?: string;  // Create topic with this name, send text as first message
}
```

Non-Telegram channels ignore `options`. Grammy's `sendMessage` already supports `message_thread_id`.

### Per-Tenant ASSISTANT_NAME and TRIGGER_PATTERN

```typescript
// Replace global singleton:
// BEFORE: const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
// AFTER: resolved per-group from tenant config

// In registeredGroups, add tenant metadata:
interface RegisteredGroup {
  // existing fields...
  tenantId?: string;
  assistantName?: string;
  requiresTrigger?: boolean;
  triggerPattern?: RegExp;
}

// In processGroupMessages, use per-group trigger:
const group = registeredGroups[chatJid];
if (group.requiresTrigger && !group.triggerPattern?.test(messageText)) {
  return; // Skip, trigger not matched
}
```
