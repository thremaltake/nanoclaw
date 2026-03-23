# Multi-Tenant Routing Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix JID collisions, persist tenant fields across restarts, wire up per-topic session isolation, and add Caliort tenant so all Telegram bots route correctly.

**Architecture:** Namespace DM JIDs by tenant (`tg:{tenantId}:{chatId}`), add topic JIDs (`tg:{chatId}:topic:{topicId}`), extend the DB schema with tenant columns, and add Caliort to `tenants.json`. The `session-resolver.ts` already handles independent topic sessions — just needs wiring.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Grammy (Telegram), Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/channels/telegram.ts` | Modify | JID construction with tenant prefix; parse prefix back out for sendMessage |
| `src/channels/telegram.test.ts` | Modify | Tests for new JID format |
| `src/db.ts` | Modify | Add tenant columns, drop folder UNIQUE, update get/set functions |
| `src/db.test.ts` | Modify | Tests for new columns |
| `src/index.ts` | Modify | Namespace JIDs during group registration, wire topic routing |
| `src/types.ts` | Modify | Add topic_id to NewMessage |
| `src/task-scheduler.ts` | Check | scheduled_tasks.chat_jid may reference old JIDs |
| `tenants.json` | Modify | Add Caliort tenant |
| `.env` | Modify | Add TELEGRAM_CALIORT_CHAT_ID |

## Notes from Review

- **Scheduled tasks:** `scheduled_tasks.chat_jid` stores old-format JIDs. Must clear or migrate in Task 6.
- **Message history:** Old messages stored under `tg:8611182982` won't be retrievable via new JIDs. This is a one-time reset — group history preserved (group JIDs unchanged).
- **`parseChatId`:** Should be a standalone exported function (not static method) so other modules can use it.
- **Migration safety:** The folder UNIQUE constraint removal MUST use a transaction.

---

### Task 0: Commit start-nanoclaw.sh fix from last session

The improved `start-nanoclaw.sh` hasn't been committed yet.

**Files:**
- Modified: `start-nanoclaw.sh`

- [ ] **Step 1: Commit**

```bash
git add start-nanoclaw.sh
git commit -m "fix: start-nanoclaw.sh waits for clean shutdown and clears port"
```

---

### Task 1: Add tenant columns to registered_groups DB schema

The `registered_groups` table lacks `tenant_id`, `assistant_name`, `is_customer_facing`, and `allowed_tools` columns. These exist in memory but are lost on restart. Also, `folder` has a `UNIQUE` constraint that prevents multiple JIDs (DM, ops, leads) from mapping to the same folder.

**Files:**
- Modify: `src/db.ts:76-84` (schema), `src/db.ts:86-129` (migrations), `src/db.ts:591-644` (get/set functions)
- Test: `src/db.test.ts`

- [ ] **Step 1: Write failing test for new columns**

In `src/db.test.ts`, add a test that verifies tenant fields are persisted:

```typescript
it('persists tenant fields in registered_groups', () => {
  setRegisteredGroup('tg:personal:12345', {
    name: 'Personal DM',
    folder: 'personal',
    trigger: '@Personal',
    added_at: new Date().toISOString(),
    isMain: true,
    tenantId: 'personal',
    assistantName: 'Personal',
    isCustomerFacing: false,
    allowedTools: ['calendar', 'email'],
  });

  const groups = getAllRegisteredGroups();
  expect(groups['tg:personal:12345'].tenantId).toBe('personal');
  expect(groups['tg:personal:12345'].assistantName).toBe('Personal');
  expect(groups['tg:personal:12345'].isCustomerFacing).toBe(false);
  expect(groups['tg:personal:12345'].allowedTools).toEqual(['calendar', 'email']);
});

it('allows multiple JIDs for the same folder', () => {
  setRegisteredGroup('tg:main:12345', {
    name: 'Main DM',
    folder: 'main',
    trigger: '@BrokerPilot',
    added_at: new Date().toISOString(),
    tenantId: 'main',
    assistantName: 'BrokerPilot',
  });
  setRegisteredGroup('tg:-100999', {
    name: 'Main Ops',
    folder: 'main',
    trigger: '@BrokerPilot',
    added_at: new Date().toISOString(),
    tenantId: 'main',
    assistantName: 'BrokerPilot',
  });

  const groups = getAllRegisteredGroups();
  expect(groups['tg:main:12345'].folder).toBe('main');
  expect(groups['tg:-100999'].folder).toBe('main');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts -v`
Expected: FAIL — tenantId/assistantName undefined, folder UNIQUE constraint violation

- [ ] **Step 3: Add migrations in `createSchema()`**

In `src/db.ts`, after the `is_main` migration block (~line 129), add tenant column migrations and drop the folder UNIQUE constraint by recreating the table. Follow the existing migration pattern (try/catch for each ALTER TABLE).

- [ ] **Step 4: Update `setRegisteredGroup()` to persist new columns**

Add `tenant_id`, `assistant_name`, `is_customer_facing`, `allowed_tools` to the INSERT statement. `allowed_tools` stored as JSON string.

- [ ] **Step 5: Update `getAllRegisteredGroups()` to read new columns**

Add new columns to the row type and map them back to `RegisteredGroup` fields. Parse `allowed_tools` from JSON.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add tenant columns to registered_groups, drop folder UNIQUE"
```

---

### Task 2: Namespace DM JIDs by tenant in Telegram channel

Currently all DMs produce `tg:{chatId}`. Personal and main both produce `tg:8611182982`, causing collision. Fix: DMs from tenant channels use `tg:{tenantId}:{chatId}`. Groups stay `tg:{chatId}`.

**Files:**
- Modify: `src/channels/telegram.ts:47-63` (constructor), `src/channels/telegram.ts:107-186` (onMessage), `src/channels/telegram.ts:260-294` (sendMessage), `src/channels/telegram.ts:317-325` (setTyping)
- Test: `src/channels/telegram.test.ts`

- [ ] **Step 1: Add `tenantId` field to TelegramChannel**

Add `private tenantId: string | null = null` and accept it in constructor + `createTenantTelegramChannel()`.

- [ ] **Step 2: Add JID construction and parsing helpers**

`buildJid(chatId, chatType)`: Returns `tg:{tenantId}:{chatId}` for DMs when tenantId is set, `tg:{chatId}` for groups.

`static parseChatId(jid)`: Extracts numeric chat ID from either format. Splits on `:` — if 3 parts, returns `parts[2]`; if 2 parts, returns `parts[1]`.

- [ ] **Step 3: Replace all `tg:$\{ctx.chat.id}` with `this.buildJid()`**

Update `onMessage` handler (line 113), `storeNonText` handler (line 190), and `/chatid` command (line 93).

- [ ] **Step 4: Update `sendMessage()` and `setTyping()` to use `parseChatId()`**

Replace `jid.replace(/^tg:/, '')` with `TelegramChannel.parseChatId(jid)`.

- [ ] **Step 5: Write tests for JID construction and parsing**

```typescript
describe('JID construction and parsing', () => {
  it('parseChatId handles tg:{chatId} format', () => {
    expect(TelegramChannel.parseChatId('tg:12345')).toBe('12345');
    expect(TelegramChannel.parseChatId('tg:-1003766720076')).toBe('-1003766720076');
  });

  it('parseChatId handles tg:{tenantId}:{chatId} format', () => {
    expect(TelegramChannel.parseChatId('tg:personal:12345')).toBe('12345');
    expect(TelegramChannel.parseChatId('tg:main:8611182982')).toBe('8611182982');
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat: namespace DM JIDs by tenant to prevent collision"
```

---

### Task 3: Update group registration in index.ts to use namespaced JIDs

The orchestrator currently registers DMs as `tg:{chatId}`. Update to use `tg:{tenantId}:{chatId}` for DMs, keeping groups as `tg:{chatId}`.

**Files:**
- Modify: `src/index.ts:636` (DM JID construction)

- [ ] **Step 1: Update DM JID construction**

In `src/index.ts`, line 636, change:
```typescript
const dmJid = `tg:${tenant.chats.dm}`;
```
to:
```typescript
const dmJid = `tg:${tenant.id}:${tenant.chats.dm}`;
```

Operations and leads group JIDs stay unchanged (already unique negative IDs).

- [ ] **Step 2: Run all tests**

Run: `npx vitest run -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: register DMs with tenant-namespaced JIDs"
```

---

### Task 4: Wire topic routing for operations group

The operations group should deliver per-topic messages with independent sessions. Telegram's `message_thread_id` identifies topics. The `session-resolver.ts` already handles `topicSession === 'independent'` — we just need to pass the topic context through.

**Files:**
- Modify: `src/types.ts:55-64` (add topic_id to NewMessage)
- Modify: `src/channels/telegram.ts:107-186` (pass topicId in message)
- Modify: `src/db.ts` (add topic_id column to messages table)
- Modify: `src/index.ts:167-200` (use topicId for session resolution and reply routing)

- [ ] **Step 1: Add `topic_id` to NewMessage type**

In `src/types.ts`, add `topic_id?: number` to the `NewMessage` interface.

- [ ] **Step 2: Pass `message_thread_id` from Telegram onMessage**

In `src/channels/telegram.ts`, capture `ctx.message.message_thread_id` and include it as `topic_id` in the message object passed to `onMessage`. Do this in both the `message:text` handler and `storeNonText`.

- [ ] **Step 3: Add topic_id column to messages table**

In `src/db.ts`, add migration: `ALTER TABLE messages ADD COLUMN topic_id INTEGER`. Update `storeMessage()` to include topic_id in the INSERT.

- [ ] **Step 4: Use topic_id for session resolution in processGroupMessages**

In `src/index.ts` `processGroupMessages()`, after looking up the group, check if the tenant has operations topics configured. If the messages have a `topic_id`, resolve the session using `resolveSession()` with `chatType: 'operations'`, `topicKey`, and `topicSession: 'independent'`.

- [ ] **Step 5: Pass topicId to sendMessage for reply routing**

When the container responds, pass the `topicId` in `MessageOptions` so the reply goes to the same Telegram topic thread.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/channels/telegram.ts src/db.ts src/index.ts
git commit -m "feat: wire per-topic session isolation for operations group"
```

---

### Task 5: Add Caliort/DinnerBros tenant to tenants.json

Bot token exists in `.env` (`TELEGRAM_CALIORT_BOT_TOKEN`), group folder exists (`groups/caliort/`), CLAUDE.md exists. Just needs a tenant entry.

**Files:**
- Modify: `tenants.json`
- Modify: `.env` (add `TELEGRAM_CALIORT_CHAT_ID`)

- [ ] **Step 1: Add Caliort to tenants.json brokers array**

Add after the `main` broker entry:
```json
{
  "id": "caliort",
  "name": "Caliort Capital",
  "assistantName": "DinnerBros",
  "botToken": "env:TELEGRAM_CALIORT_BOT_TOKEN",
  "groupFolder": "caliort",
  "dbSchema": "caliort",
  "isAdmin": false,
  "isCustomerFacing": false,
  "requiresTrigger": false,
  "privateTools": [],
  "sharedTools": [],
  "contacts": { "owner": "env:TELEGRAM_CALIORT_CHAT_ID" },
  "chats": { "dm": "env:TELEGRAM_CALIORT_CHAT_ID" }
}
```

- [ ] **Step 2: Add TELEGRAM_CALIORT_CHAT_ID to .env**

```
TELEGRAM_CALIORT_CHAT_ID=8611182982
```

- [ ] **Step 3: Run build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tenants.json
git commit -m "feat: add Caliort/DinnerBros tenant to tenants.json"
```

---

### Task 6: Clear stale state and integration test

Wipe old registered_groups and sessions that use the old JID format. Verify the full startup flow registers all groups correctly.

- [ ] **Step 1: Build**

Run: `npm run build`

- [ ] **Step 2: Stop NanoClaw**

Kill existing process and clear port 3001.

- [ ] **Step 3: Clear stale DB state**

Delete all rows from `registered_groups`, `sessions`, and `scheduled_tasks` tables (old JID format).

- [ ] **Step 4: Start NanoClaw**

Run: `bash start-nanoclaw.sh`

- [ ] **Step 5: Verify all groups registered correctly**

Query `registered_groups` table. Expected:
- `tg:personal:8611182982` → folder=personal, tenant_id=personal, assistant_name=Personal
- `tg:main:8611182982` → folder=main, tenant_id=main, assistant_name=BrokerPilot
- `tg:-1003766720076` → folder=main, tenant_id=main (ops group)
- `tg:-1003845315559` → folder=main, tenant_id=main (leads group)
- `tg:caliort:8611182982` → folder=caliort, tenant_id=caliort, assistant_name=DinnerBros

- [ ] **Step 6: Verify all 3 bots connected in logs**

Expected: @AndryPersonalBot, @AHBrokerPilot_bot, @DinnerBros_bot

- [ ] **Step 7: Test each bot on Telegram**

Send "test" to each bot DM:
- @AndryPersonalBot responds as "Personal"
- @AHBrokerPilot_bot responds as "BrokerPilot"
- @DinnerBros_bot responds as "DinnerBros"

- [ ] **Step 8: Test topic routing**

In BrokerPilot operations group, send a message in a specific topic. Verify it gets its own session.

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass
