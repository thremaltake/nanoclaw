# P0: Multi-Tenant Core Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform NanoClaw from a single-bot system into a multi-tenant broker platform where each tenant gets their own Telegram bot, scoped MCP tools, isolated sessions, and hardened containers — all running in a single process.

**Architecture:** Single NanoClaw process loads `tenants.json` at startup, creates one TelegramChannel per tenant, registers all chats to group folders, and uses composite session keys for per-topic/per-lead isolation. Containers get per-tenant allowedTools and MCP configs. Queue keys change from chatJid to groupFolder with per-topic parallelism.

**Tech Stack:** Node.js/TypeScript, Zod (validation), grammy (Telegram), better-sqlite3, Docker, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-multi-tenant-design.md`

**Reference code (Mac install):** `/home/nanoclaw/brokerpilot/apps/nanoclaw/` (check patterns if needed)

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/tenant-config.ts` | Load tenants.json, resolve env:VAR, merge defaults, validate with Zod |
| `src/tenant-config.test.ts` | Tests for tenant config loader |
| `src/mcp-config-generator.ts` | Generate per-tenant .mcp.json from tool templates + dbSchema |
| `src/mcp-config-generator.test.ts` | Tests for MCP config generator |
| `src/session-resolver.ts` | Composite session key + queue key resolution |
| `src/session-resolver.test.ts` | Tests for session resolver |
| `tenants.json` | Tenant configuration (initial setup for main + personal) |

### Modified Files
| File | Changes |
|------|---------|
| `src/types.ts` | Add `MessageOptions`, extend `Channel.sendMessage`, extend `ContainerInput`, extend `RegisteredGroup` with tenant metadata |
| `src/config.ts` | Remove global `ASSISTANT_NAME` / `TRIGGER_PATTERN` singletons |
| `src/channels/telegram.ts` | Accept per-tenant assistantName + triggerPattern, support `MessageOptions` (topicId), multi-instance registration |
| `src/channels/telegram.test.ts` | Update tests for per-tenant TelegramChannel |
| `src/group-queue.ts` | Change keys from chatJid to queueKey (folder-based), add priority ordering for shared queues |
| `src/group-queue.test.ts` | Tests for folder-based queue keys + priority |
| `src/container-runner.ts` | Pass `allowedTools` in ContainerInput, add `--cap-drop=ALL`, `--pids-limit=100`, tiered `--memory` |
| `src/container-runner.test.ts` | Tests for hardening flags + tiered memory |
| `src/db.ts` | Rename sessions column `group_folder` to `session_key`, update accessors |
| `src/db.test.ts` | Update session tests for composite keys |
| `src/index.ts` | Tenant-aware startup, multi-JID message batching, session resolver integration, per-tenant ASSISTANT_NAME |
| `src/router.ts` | Extend `routeOutbound` to pass `MessageOptions` through |
| `container/agent-runner/src/index.ts` | Read `allowedTools` from ContainerInput (fall back to hardcoded list if absent) |

---

### Task 1: Extend Type Interfaces

**Files:**
- Modify: `src/types.ts`

This task adds the new interfaces and extends existing ones that all subsequent tasks depend on.

- [ ] **Step 1: Read current types.ts**

Read `src/types.ts` to confirm current interfaces.

- [ ] **Step 2: Add MessageOptions and extend Channel.sendMessage**

```typescript
// Add after ScheduledTask interface:

export interface MessageOptions {
  topicId?: number;
  createTopic?: string;  // Create topic with this name, send text as first message
}
```

Update Channel interface `sendMessage` signature:
```typescript
sendMessage(jid: string, text: string, options?: MessageOptions): Promise<void>;
```

- [ ] **Step 3: Extend ContainerInput with tenant fields**

Add to `ContainerInput` in `src/container-runner.ts:56-64`:
```typescript
export interface ContainerInput {
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

- [ ] **Step 4: Extend RegisteredGroup with tenant metadata**

```typescript
export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
  isMain?: boolean;
  // NEW fields:
  tenantId?: string;
  assistantName?: string;
  triggerPattern?: RegExp;      // Per-tenant trigger (not serialized to DB)
  isCustomerFacing?: boolean;
  allowedTools?: string[];
}
```

- [ ] **Step 5: Run build to verify no type errors**

Run: `npm run build`
Expected: Compilation succeeds (new fields are all optional, backward compatible).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/container-runner.ts
git commit -m "feat: extend types for multi-tenant (MessageOptions, ContainerInput, RegisteredGroup)"
```

---

### Task 2: Tenant Config Loader with Zod Validation

**Files:**
- Create: `src/tenant-config.ts`
- Create: `src/tenant-config.test.ts`
- Create: `tenants.json`

This task builds the tenant configuration loader that reads `tenants.json`, resolves `env:VAR` references from `.env`, merges `brokerDefaults` into each broker, and validates with Zod. If `tenants.json` doesn't exist, returns null (backward compatibility).

- [ ] **Step 1: Install zod dependency**

Run: `npm install zod`

- [ ] **Step 2: Write the failing test — basic tenant loading**

Create `src/tenant-config.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadTenantConfig, type TenantConfig } from './tenant-config.js';

// Mock fs so we can control tenants.json content
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() } };
});

vi.mock('./env.js', () => ({
  readEnvFile: () => ({
    TELEGRAM_BOT_TOKEN: 'test-token-main',
    TELEGRAM_CHAT_ID: '12345',
    TELEGRAM_PERSONAL_BOT_TOKEN: 'test-token-personal',
    TELEGRAM_PERSONAL_CHAT_ID: '67890',
  }),
}));

import fs from 'fs';

const MINIMAL_TENANTS = {
  defaults: { timezone: 'Australia/Sydney' },
  brokerDefaults: {
    jidPrefix: 'tg',
    isAdmin: false,
    isCustomerFacing: false,
    requiresTrigger: false,
    status: 'active',
    privateTools: ['deal-manager'],
    sharedTools: ['lender-knowledge'],
    ai: { mode: 'platform' },
  },
  system: [],
  brokers: [
    {
      id: 'main',
      name: 'Test Main',
      assistantName: 'TestBot',
      botToken: 'env:TELEGRAM_BOT_TOKEN',
      groupFolder: 'main',
      dbSchema: 'work',
      isAdmin: true,
      contacts: { owner: 'env:TELEGRAM_CHAT_ID' },
      chats: { dm: 'env:TELEGRAM_CHAT_ID' },
    },
  ],
};

describe('loadTenantConfig', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MINIMAL_TENANTS));
  });

  it('returns null when tenants.json does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadTenantConfig()).toBeNull();
  });

  it('loads and resolves env:VAR references', () => {
    const config = loadTenantConfig()!;
    expect(config).not.toBeNull();
    const main = config.tenants.find(t => t.id === 'main')!;
    expect(main.botToken).toBe('test-token-main');
    expect(main.contacts.owner).toBe('12345');
  });

  it('merges brokerDefaults into brokers', () => {
    const config = loadTenantConfig()!;
    const main = config.tenants.find(t => t.id === 'main')!;
    expect(main.privateTools).toContain('deal-manager');
    expect(main.sharedTools).toContain('lender-knowledge');
  });

  it('throws on invalid config (missing required fields)', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ brokers: [{}] }));
    expect(() => loadTenantConfig()).toThrow();
  });

  it('resolves chats.dm from env:VAR', () => {
    const config = loadTenantConfig()!;
    const main = config.tenants.find(t => t.id === 'main')!;
    expect(main.chats.dm).toBe('12345');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/tenant-config.test.ts`
Expected: FAIL — module `./tenant-config.js` not found.

- [ ] **Step 4: Implement tenant-config.ts**

Create `src/tenant-config.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// --- Zod Schemas ---

const AiConfigSchema = z.object({
  mode: z.enum(['platform', 'own']).default('platform'),
}).optional();

const TopicConfigSchema = z.union([
  z.string(), // Simple: just the display name
  z.object({
    name: z.string(),
    session: z.enum(['shared', 'independent']).default('shared'),
  }),
]);

const ChatsSchema = z.object({
  dm: z.string(),
  operations: z.object({
    chatId: z.string(),
    topics: z.record(z.string(), TopicConfigSchema).optional(),
  }).optional(),
  leads: z.string().optional(),
}).catchall(z.string()); // Allow additional chat entries

const ContactsSchema = z.object({
  owner: z.string(),
  notifyOnError: z.boolean().optional(),
});

const TenantSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Tenant ID must be lowercase alphanumeric with dashes'),
  name: z.string(),
  assistantName: z.string(),
  botToken: z.string(),
  groupFolder: z.string(),
  dbSchema: z.string(),
  himalayaAccount: z.string().optional(),
  isAdmin: z.boolean().optional(),
  isCustomerFacing: z.boolean().optional(),
  requiresTrigger: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'suspended', 'deactivated']).optional(),
  privateTools: z.array(z.string()).optional(),
  sharedTools: z.array(z.string()).optional(),
  ai: AiConfigSchema,
  contacts: ContactsSchema,
  chats: ChatsSchema,
});

const DefaultsSchema = z.object({
  timezone: z.string().default('Australia/Sydney'),
  briefingTime: z.string().optional(),
  quietHoursStart: z.number().optional(),
  quietHoursEnd: z.number().optional(),
});

const BrokerDefaultsSchema = z.object({
  jidPrefix: z.string().default('tg'),
  isAdmin: z.boolean().default(false),
  isCustomerFacing: z.boolean().default(false),
  requiresTrigger: z.boolean().default(false),
  status: z.enum(['active', 'paused', 'suspended', 'deactivated']).default('active'),
  privateTools: z.array(z.string()).default([]),
  sharedTools: z.array(z.string()).default([]),
  ai: AiConfigSchema,
});

const TenantsFileSchema = z.object({
  defaults: DefaultsSchema.optional(),
  brokerDefaults: BrokerDefaultsSchema.optional(),
  system: z.array(TenantSchema).default([]),
  brokers: z.array(TenantSchema).default([]),
});

// --- Resolved Types ---

export type ResolvedTenant = z.infer<typeof TenantSchema> & {
  type: 'system' | 'broker';
  allTools: string[];  // privateTools + sharedTools combined
};

export interface TenantConfig {
  defaults: z.infer<typeof DefaultsSchema>;
  tenants: ResolvedTenant[];
}

// --- Env Resolution ---

function resolveEnvValue(value: string, envMap: Record<string, string>): string {
  if (!value.startsWith('env:')) return value;
  const varName = value.slice(4);
  const resolved = envMap[varName] || process.env[varName];
  if (!resolved) {
    throw new Error(`Environment variable ${varName} not found (referenced as env:${varName})`);
  }
  return resolved;
}

function resolveEnvDeep(obj: unknown, envMap: Record<string, string>): unknown {
  if (typeof obj === 'string') return resolveEnvValue(obj, envMap);
  if (Array.isArray(obj)) return obj.map(item => resolveEnvDeep(item, envMap));
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvDeep(value, envMap);
    }
    return result;
  }
  return obj;
}

// --- Loader ---

const TENANTS_PATH = path.resolve(process.cwd(), 'tenants.json');

export function loadTenantConfig(): TenantConfig | null {
  if (!fs.existsSync(TENANTS_PATH)) {
    logger.info('No tenants.json found — running in single-tenant mode');
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(TENANTS_PATH, 'utf-8'));

  // Collect all env:VAR references so we can bulk-load them
  const envKeys = new Set<string>();
  JSON.stringify(raw, (_, value) => {
    if (typeof value === 'string' && value.startsWith('env:')) {
      envKeys.add(value.slice(4));
    }
    return value;
  });
  const envMap = readEnvFile([...envKeys]);

  // Resolve env:VAR references throughout the config
  const resolved = resolveEnvDeep(raw, envMap);

  // Validate schema
  const parsed = TenantsFileSchema.parse(resolved);

  // Merge brokerDefaults into each broker
  const brokerDefaults = parsed.brokerDefaults ?? {};
  const tenants: ResolvedTenant[] = [];

  for (const systemTenant of parsed.system) {
    tenants.push({
      ...systemTenant,
      type: 'system',
      allTools: [...(systemTenant.privateTools ?? []), ...(systemTenant.sharedTools ?? [])],
    });
  }

  for (const broker of parsed.brokers) {
    const merged = {
      ...brokerDefaults,
      ...broker,
      // Arrays: broker overrides completely (not appended)
      privateTools: broker.privateTools ?? brokerDefaults.privateTools ?? [],
      sharedTools: broker.sharedTools ?? brokerDefaults.sharedTools ?? [],
      status: broker.status ?? brokerDefaults.status ?? 'active',
    };
    tenants.push({
      ...merged,
      type: 'broker',
      allTools: [...merged.privateTools, ...merged.sharedTools],
    });
  }

  // Filter to active tenants only
  const activeTenants = tenants.filter(t => (t.status ?? 'active') === 'active');

  logger.info(
    { total: tenants.length, active: activeTenants.length },
    'Loaded tenant config',
  );

  return {
    defaults: parsed.defaults ?? { timezone: 'Australia/Sydney' },
    tenants: activeTenants,
  };
}

/**
 * Look up a tenant by ID.
 */
export function findTenant(config: TenantConfig, tenantId: string): ResolvedTenant | undefined {
  return config.tenants.find(t => t.id === tenantId);
}

/**
 * Look up a tenant by group folder.
 */
export function findTenantByFolder(config: TenantConfig, folder: string): ResolvedTenant | undefined {
  return config.tenants.find(t => t.groupFolder === folder);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/tenant-config.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 6: Write additional tests — system tenants, status filtering, topic config**

Add to `src/tenant-config.test.ts`:

```typescript
describe('loadTenantConfig — system tenants', () => {
  it('loads system tenants with type "system"', () => {
    const withSystem = {
      ...MINIMAL_TENANTS,
      system: [{
        id: 'personal',
        name: 'Personal',
        assistantName: 'Personal',
        botToken: 'env:TELEGRAM_PERSONAL_BOT_TOKEN',
        groupFolder: 'personal',
        dbSchema: 'personal',
        isAdmin: true,
        privateTools: ['personal-finance'],
        sharedTools: [],
        contacts: { owner: 'env:TELEGRAM_PERSONAL_CHAT_ID' },
        chats: { dm: 'env:TELEGRAM_PERSONAL_CHAT_ID' },
      }],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(withSystem));
    const config = loadTenantConfig()!;
    const personal = config.tenants.find(t => t.id === 'personal')!;
    expect(personal.type).toBe('system');
    expect(personal.allTools).toEqual(['personal-finance']);
  });
});

describe('loadTenantConfig — status filtering', () => {
  it('excludes paused/suspended tenants', () => {
    const withPaused = {
      ...MINIMAL_TENANTS,
      brokers: [
        ...MINIMAL_TENANTS.brokers,
        {
          id: 'paused-broker',
          name: 'Paused',
          assistantName: 'PausedBot',
          botToken: 'direct-token',
          groupFolder: 'paused',
          dbSchema: 'paused',
          status: 'paused',
          contacts: { owner: '999' },
          chats: { dm: '999' },
        },
      ],
    };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(withPaused));
    const config = loadTenantConfig()!;
    expect(config.tenants.find(t => t.id === 'paused-broker')).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run all tenant-config tests**

Run: `npx vitest run src/tenant-config.test.ts`
Expected: All tests PASS.

- [ ] **Step 8: Create initial tenants.json**

Create `tenants.json` at project root. This captures the current single-tenant setup:

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
    }
  ]
}
```

- [ ] **Step 9: Commit**

```bash
git add src/tenant-config.ts src/tenant-config.test.ts tenants.json package.json package-lock.json
git commit -m "feat: add tenants.json loader with Zod validation and env resolution"
```

---

### Task 3: MCP Config Generator

**Files:**
- Create: `src/mcp-config-generator.ts`
- Create: `src/mcp-config-generator.test.ts`

Generates per-tenant `.mcp.json` files from the MCP template registry and tenant tool lists. Merges with existing group-level overrides.

- [ ] **Step 1: Write the failing test**

Create `src/mcp-config-generator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateMcpConfig, deriveMemoryLimit, MCP_TEMPLATES } from './mcp-config-generator.js';
import type { ResolvedTenant } from './tenant-config.js';

describe('generateMcpConfig', () => {
  const baseTenant: ResolvedTenant = {
    id: 'test',
    name: 'Test Broker',
    assistantName: 'TestBot',
    botToken: 'token',
    groupFolder: 'test',
    dbSchema: 'test_schema',
    contacts: { owner: '123' },
    chats: { dm: '123' },
    type: 'broker',
    allTools: ['deal-manager', 'lender-knowledge'],
    privateTools: ['deal-manager'],
    sharedTools: ['lender-knowledge'],
  };

  it('generates MCP servers for tenant tools only', () => {
    const config = generateMcpConfig(baseTenant);
    const serverNames = Object.keys(config.mcpServers);
    expect(serverNames).toContain('deal-manager');
    expect(serverNames).toContain('lender-knowledge');
    expect(serverNames).not.toContain('work-email');
  });

  it('injects DB_SCHEMA for schema-scoped tools', () => {
    const config = generateMcpConfig(baseTenant);
    const dealManager = config.mcpServers['deal-manager'];
    expect(dealManager.env?.DB_SCHEMA).toBe('test_schema');
  });

  it('does not inject DB_SCHEMA for non-scoped tools', () => {
    const config = generateMcpConfig(baseTenant);
    const lk = config.mcpServers['lender-knowledge'];
    expect(lk.env?.DB_SCHEMA).toBeUndefined();
  });

  it('generates allowedTools list with mcp__ prefixes', () => {
    const config = generateMcpConfig(baseTenant);
    expect(config.allowedTools).toContain('mcp__deal-manager__*');
    expect(config.allowedTools).toContain('mcp__lender-knowledge__*');
    expect(config.allowedTools).not.toContain('mcp__work-email__*');
  });

  it('includes base SDK tools for admin tenants', () => {
    const admin = { ...baseTenant, isAdmin: true };
    const config = generateMcpConfig(admin);
    expect(config.allowedTools).toContain('Bash');
    expect(config.allowedTools).toContain('Write');
    expect(config.allowedTools).toContain('WebSearch');
  });

  it('restricts SDK tools for customer-facing tenants', () => {
    const customer = { ...baseTenant, isCustomerFacing: true };
    const config = generateMcpConfig(customer);
    expect(config.allowedTools).toContain('Read');
    expect(config.allowedTools).toContain('Glob');
    expect(config.allowedTools).not.toContain('Bash');
    expect(config.allowedTools).not.toContain('Write');
    expect(config.allowedTools).not.toContain('WebSearch');
  });
});

describe('deriveMemoryLimit', () => {
  it('returns 256m for customer-facing', () => {
    expect(deriveMemoryLimit({ isCustomerFacing: true, allTools: ['deal-manager'] } as any)).toBe('256m');
  });

  it('returns 768m for <=5 tools', () => {
    expect(deriveMemoryLimit({ allTools: ['a', 'b', 'c'] } as any)).toBe('768m');
  });

  it('returns 1024m for >5 tools', () => {
    expect(deriveMemoryLimit({ allTools: ['a', 'b', 'c', 'd', 'e', 'f'] } as any)).toBe('1024m');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-config-generator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement mcp-config-generator.ts**

Create `src/mcp-config-generator.ts`:

```typescript
import type { ResolvedTenant } from './tenant-config.js';

export interface McpTemplate {
  command: string;
  args: string[];
  envKeys: string[];
  schemaScoped: boolean;
}

export const MCP_TEMPLATES: Record<string, McpTemplate> = {
  'deal-manager': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/deal-manager/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'work-email': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/work-email/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'personal-email': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/personal-email/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'calendar': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/calendar/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'document-store': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/document-store/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'lender-knowledge': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/lender-knowledge/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VOYAGE_API_KEY'],
    schemaScoped: false,
  },
  'lender-matching': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/lender-matching/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: false,
  },
  'bank-statement': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/bank-statement/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'personal-finance': {
    command: 'npx',
    args: ['tsx', '/workspace/projects/brokerpilot/modules/personal-finance/src/index.ts'],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
};

// Base SDK tools for admin/broker tenants
const ADMIN_SDK_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
];

// Restricted SDK tools for customer-facing tenants
const CUSTOMER_SDK_TOOLS = [
  'Read', 'Glob', 'Grep',
];

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface GeneratedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  allowedTools: string[];
}

export function generateMcpConfig(tenant: ResolvedTenant): GeneratedMcpConfig {
  const mcpServers: Record<string, McpServerConfig> = {};

  for (const toolName of tenant.allTools) {
    const template = MCP_TEMPLATES[toolName];
    if (!template) continue;

    const env: Record<string, string> = {};
    for (const key of template.envKeys) {
      env[key] = `\${${key}}`;  // Placeholder for env resolution
    }
    if (template.schemaScoped) {
      env.DB_SCHEMA = tenant.dbSchema;
    }

    mcpServers[toolName] = {
      command: template.command,
      args: [...template.args],
      env,
    };
  }

  // Build allowedTools list
  const sdkTools = tenant.isCustomerFacing ? CUSTOMER_SDK_TOOLS : ADMIN_SDK_TOOLS;
  const mcpToolPatterns = tenant.allTools
    .filter(t => MCP_TEMPLATES[t])
    .map(t => `mcp__${t}__*`);

  const allowedTools = [
    ...sdkTools,
    'mcp__nanoclaw__*',
    ...mcpToolPatterns,
  ];

  return { mcpServers, allowedTools };
}

/**
 * Derive container memory limit from tenant config.
 * customer-facing: 256m, <=5 tools: 768m, >5 tools: 1024m
 */
export function deriveMemoryLimit(tenant: ResolvedTenant): string {
  if (tenant.isCustomerFacing) return '256m';
  if (tenant.allTools.length <= 5) return '768m';
  return '1024m';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp-config-generator.test.ts`
Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-config-generator.ts src/mcp-config-generator.test.ts
git commit -m "feat: add MCP config generator with per-tenant tool scoping and memory tiering"
```

---

### Task 4: Session Resolver

**Files:**
- Create: `src/session-resolver.ts`
- Create: `src/session-resolver.test.ts`

The session resolver determines the session key and queue key for each incoming message based on chat type, topic, and tenant config. This is the composite key logic from spec Section 5.

- [ ] **Step 1: Write the failing test**

Create `src/session-resolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveSession, type SessionContext } from './session-resolver.js';

describe('resolveSession', () => {
  it('resolves DM to folder-level session with priority 1', () => {
    const result = resolveSession({
      folder: 'main',
      chatType: 'dm',
    });
    expect(result.sessionKey).toBe('main');
    expect(result.queueKey).toBe('main');
    expect(result.priority).toBe(1);
  });

  it('resolves shared operations topic to folder-level session with priority 2', () => {
    const result = resolveSession({
      folder: 'main',
      chatType: 'operations',
      topicKey: 'calendar-tasks-alerts',
      topicSession: 'shared',
    });
    expect(result.sessionKey).toBe('main');
    expect(result.queueKey).toBe('main');
    expect(result.priority).toBe(2);
  });

  it('resolves independent topic to topic-level session', () => {
    const result = resolveSession({
      folder: 'main',
      chatType: 'operations',
      topicKey: 'lender-knowledge',
      topicSession: 'independent',
    });
    expect(result.sessionKey).toBe('main:topic:lender-knowledge');
    expect(result.queueKey).toBe('main:topic:lender-knowledge');
    expect(result.priority).toBe(2);
  });

  it('resolves lead topic to per-deal session', () => {
    const result = resolveSession({
      folder: 'main',
      chatType: 'leads',
      dealId: 'deal-abc-123',
    });
    expect(result.sessionKey).toBe('main:lead:deal-abc-123');
    expect(result.queueKey).toBe('main:lead:deal-abc-123');
    expect(result.priority).toBe(2);
  });

  it('resolves customer-facing to per-customer session', () => {
    const result = resolveSession({
      folder: 'lead-capture',
      chatType: 'customer',
      senderId: 'user-456',
    });
    expect(result.sessionKey).toBe('lead-capture:customer:user-456');
    expect(result.queueKey).toBe('lead-capture:customer:user-456');
    expect(result.priority).toBe(1);
  });

  it('assigns priority 3 to scheduled tasks', () => {
    const result = resolveSession({
      folder: 'main',
      chatType: 'dm',
      isScheduledTask: true,
    });
    expect(result.priority).toBe(3);
  });

  it('falls back to folder session for leads without dealId', () => {
    const result = resolveSession({
      folder: 'main',
      chatType: 'leads',
    });
    expect(result.sessionKey).toBe('main');
    expect(result.queueKey).toBe('main');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/session-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement session-resolver.ts**

Create `src/session-resolver.ts`:

```typescript
export interface SessionContext {
  folder: string;
  chatType: 'dm' | 'operations' | 'leads' | 'customer';
  topicKey?: string;
  topicSession?: 'shared' | 'independent';
  dealId?: string;
  senderId?: string;
  isScheduledTask?: boolean;
}

export interface ResolvedSession {
  sessionKey: string;
  queueKey: string;
  priority: number; // 1 = highest (DM), 2 = topic reply, 3 = scheduled task
}

/**
 * Resolve session key, queue key, and priority from message context.
 *
 * Priority levels (for shared queues):
 *   1 = DM messages (broker actively typing)
 *   2 = Topic replies (broker replied in a topic)
 *   3 = Scheduled tasks (alerts, briefings — can wait)
 */
export function resolveSession(ctx: SessionContext): ResolvedSession {
  // Scheduled tasks always get lowest priority
  if (ctx.isScheduledTask) {
    return { sessionKey: ctx.folder, queueKey: ctx.folder, priority: 3 };
  }

  // Customer-facing: per-customer session, always independent
  if (ctx.chatType === 'customer') {
    const key = `${ctx.folder}:customer:${ctx.senderId}`;
    return { sessionKey: key, queueKey: key, priority: 1 };
  }

  // Lead topics: per-deal session, always independent
  if (ctx.chatType === 'leads' && ctx.dealId) {
    const key = `${ctx.folder}:lead:${ctx.dealId}`;
    return { sessionKey: key, queueKey: key, priority: 2 };
  }

  // Independent operations topics: own session + queue
  if (ctx.chatType === 'operations' && ctx.topicSession === 'independent' && ctx.topicKey) {
    const key = `${ctx.folder}:topic:${ctx.topicKey}`;
    return { sessionKey: key, queueKey: key, priority: 2 };
  }

  // DM or shared operations topics: folder-level session
  const priority = ctx.chatType === 'dm' ? 1 : 2;
  return { sessionKey: ctx.folder, queueKey: ctx.folder, priority };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session-resolver.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session-resolver.ts src/session-resolver.test.ts
git commit -m "feat: add session resolver with composite keys and priority levels"
```

---

### Task 5: Database Migration — Session Key Rename

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

Rename the `sessions.group_folder` column to `session_key` so it can store composite keys like `main:topic:lk` and `main:lead:abc-123`.

- [ ] **Step 1: Read current db.ts session functions**

Read `src/db.ts` around lines 514-530 to see current `getSession`/`setSession`.

- [ ] **Step 2: Write the failing test for composite session keys**

Add to `src/db.test.ts`:

```typescript
describe('session management — composite keys', () => {
  it('stores and retrieves session with simple key', () => {
    setSession('main', 'session-abc');
    expect(getSession('main')).toBe('session-abc');
  });

  it('stores and retrieves session with composite key', () => {
    setSession('main:topic:lender-knowledge', 'session-xyz');
    expect(getSession('main:topic:lender-knowledge')).toBe('session-xyz');
  });

  it('keeps simple and composite keys independent', () => {
    setSession('main', 'session-1');
    setSession('main:topic:lk', 'session-2');
    expect(getSession('main')).toBe('session-1');
    expect(getSession('main:topic:lk')).toBe('session-2');
  });

  it('getAllSessions returns all session types', () => {
    setSession('main', 'session-1');
    setSession('main:lead:deal-123', 'session-2');
    const all = getAllSessions();
    expect(all['main']).toBe('session-1');
    expect(all['main:lead:deal-123']).toBe('session-2');
  });
});
```

- [ ] **Step 3: Run test to check baseline**

Run: `npx vitest run src/db.test.ts`
The current schema should already support composite keys as data. Verify the tests pass.

- [ ] **Step 4: Rename column in schema and accessors**

In `src/db.ts`, update the sessions table CREATE statement:
```sql
CREATE TABLE IF NOT EXISTS sessions (session_key TEXT PRIMARY KEY, session_id TEXT)
```

Add migration logic at database init:
```typescript
// Migration: rename group_folder -> session_key in sessions table
try {
  db.prepare('ALTER TABLE sessions RENAME COLUMN group_folder TO session_key').run();
} catch {
  // Column already renamed or table created with new schema — ignore
}
```

Update function signatures:
- `getSession(sessionKey: string)` (was `groupFolder`)
- `setSession(sessionKey: string, sessionId: string)` (was `groupFolder`)
- `getAllSessions()` return keys are now `session_key`

- [ ] **Step 5: Update all callers**

Search for `getSession(` and `setSession(` in `src/index.ts` and `src/task-scheduler.ts`. The parameter name changes but call sites pass strings — just rename the parameter for clarity.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/db.test.ts src/index.ts src/task-scheduler.ts
git commit -m "refactor: rename sessions.group_folder to session_key for composite key support"
```

---

### Task 6: Multi-Bot TelegramChannel

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify: `src/channels/telegram.test.ts`

Change TelegramChannel to accept per-tenant assistantName and triggerPattern instead of using the global singleton. Support `MessageOptions` (topicId) in `sendMessage`. Support multiple instances (one per tenant).

- [ ] **Step 1: Update TelegramChannelOpts with per-tenant fields**

In `src/channels/telegram.ts`, add to `TelegramChannelOpts`:

```typescript
export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  assistantName?: string;     // Per-tenant (falls back to global)
  triggerPattern?: RegExp;    // Per-tenant (falls back to global)
}
```

Replace hardcoded `ASSISTANT_NAME` / `TRIGGER_PATTERN` usage with instance getters:

```typescript
private get assistantName(): string {
  return this.opts.assistantName ?? ASSISTANT_NAME;
}

private get triggerPattern(): RegExp {
  return this.opts.triggerPattern ?? TRIGGER_PATTERN;
}
```

- [ ] **Step 2: Update sendTelegramMessage helper and sendMessage for topicId**

First, update the `sendTelegramMessage` helper to accept and merge additional options:

```typescript
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}
```

Note: The existing helper already accepts an `options` parameter with this exact signature — verify it matches and update if needed.

Then update `sendMessage` to pass topicId through:

```typescript
async sendMessage(jid: string, text: string, options?: MessageOptions): Promise<void> {
  // ... existing null/length checks ...
  const sendOpts = options?.topicId ? { message_thread_id: options.topicId } : {};
  await sendTelegramMessage(this.bot.api, numericId, text, sendOpts);
}
```

- [ ] **Step 3: Support per-instance naming and JID ownership**

Give each instance a unique name and track managed JIDs:

```typescript
name: string;
private managedJids = new Set<string>();

constructor(botToken: string, opts: TelegramChannelOpts, instanceName?: string) {
  this.botToken = botToken;
  this.opts = opts;
  this.name = instanceName ?? 'telegram';
}

addManagedJid(jid: string): void {
  this.managedJids.add(jid);
}

ownsJid(jid: string): boolean {
  if (this.managedJids.size > 0) return this.managedJids.has(jid);
  return jid.startsWith('tg:');
}
```

- [ ] **Step 4: Add factory function for multi-tenant creation**

```typescript
export function createTenantTelegramChannel(
  botToken: string,
  opts: TelegramChannelOpts,
  tenantId: string,
): TelegramChannel {
  return new TelegramChannel(botToken, opts, `telegram:${tenantId}`);
}
```

**Important:** The existing `registerChannel('telegram', ...)` self-registration at the bottom of the file creates a single instance from env vars. In multi-tenant mode, this factory is bypassed — the orchestrator (Task 9) creates channels directly via `createTenantTelegramChannel` and adds them to the `channels` array. The self-registration path only runs in single-tenant fallback mode. Ensure the existing `registerChannel` call is guarded so it doesn't conflict with multi-tenant channels.

- [ ] **Step 5: Write tests**

Add to `src/channels/telegram.test.ts`:

```typescript
describe('TelegramChannel — multi-tenant', () => {
  it('uses per-tenant instance name', () => {
    const channel = new TelegramChannel('token', baseOpts, 'telegram:main');
    expect(channel.name).toBe('telegram:main');
  });

  it('routes messages only to managed JIDs when populated', () => {
    const channel = new TelegramChannel('token', baseOpts, 'telegram:main');
    channel.addManagedJid('tg:123');
    expect(channel.ownsJid('tg:123')).toBe(true);
    expect(channel.ownsJid('tg:456')).toBe(false);
  });

  it('falls back to all tg: JIDs when managedJids empty', () => {
    const channel = new TelegramChannel('token', baseOpts);
    expect(channel.ownsJid('tg:anything')).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/channels/telegram.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat: multi-bot TelegramChannel with per-tenant name, trigger, and topicId support"
```

---

### Task 7: Queue by Folder with Per-Topic Parallelism and Priority

**Files:**
- Modify: `src/group-queue.ts`
- Modify: `src/group-queue.test.ts`

The queue already uses string keys, so folder-based keys work without structural changes. The key additions are: (1) priority support so DM messages jump ahead of scheduled tasks in shared queues, and (2) verifying that different queue keys (independent topics) run in parallel.

- [ ] **Step 1: Write the test for parallel independent topics**

Add to `src/group-queue.test.ts`:

```typescript
describe('GroupQueue — per-topic parallelism', () => {
  it('runs different queue keys in parallel', async () => {
    let running = 0;
    let maxConcurrent = 0;

    queue.setProcessMessagesFn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 100));
      running--;
      return true;
    });

    queue.enqueueMessageCheck('main');
    queue.enqueueMessageCheck('main:topic:lk');

    await vi.advanceTimersByTimeAsync(200);
    expect(maxConcurrent).toBe(2);
  });

  it('serializes within same queue key', async () => {
    let running = 0;
    let maxConcurrent = 0;

    queue.setProcessMessagesFn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 100));
      running--;
      return true;
    });

    queue.enqueueMessageCheck('main');
    queue.enqueueMessageCheck('main'); // same key

    await vi.advanceTimersByTimeAsync(300);
    expect(maxConcurrent).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify baseline**

Run: `npx vitest run src/group-queue.test.ts`
These should already pass since the queue treats each string key independently.

- [ ] **Step 3: Add priority support to GroupState and enqueue**

Extend `GroupState` with a priority-ordered pending queue:

```typescript
interface GroupState {
  // ... existing fields ...
  pendingMessages: boolean;
  pendingWithPriority: Array<{ priority: number }>;  // NEW
  // ...
}
```

Initialize `pendingWithPriority: []` in `getGroup()`.

Add `enqueueWithPriority` method:

```typescript
enqueueWithPriority(queueKey: string, priority: number): void {
  if (this.shuttingDown) return;
  const state = this.getGroup(queueKey);

  if (state.active) {
    state.pendingWithPriority.push({ priority });
    state.pendingMessages = true;
    logger.debug({ queueKey, priority }, 'Container active, priority message queued');
    return;
  }

  if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
    state.pendingWithPriority.push({ priority });
    state.pendingMessages = true;
    if (!this.waitingGroups.includes(queueKey)) {
      this.waitingGroups.push(queueKey);
    }
    return;
  }

  this.runForGroup(queueKey, 'messages').catch(err =>
    logger.error({ queueKey, err }, 'Unhandled error in runForGroup'),
  );
}
```

Update `drainGroup` to consume `pendingWithPriority` sorted by priority:

```typescript
private drainGroup(queueKey: string): void {
  const state = this.getGroup(queueKey);

  // Priority-aware drain: sort and take highest priority (lowest number)
  if (state.pendingWithPriority.length > 0) {
    state.pendingWithPriority.sort((a, b) => a.priority - b.priority);
    state.pendingWithPriority.shift(); // consume next
    state.pendingMessages = state.pendingWithPriority.length > 0;
    this.runForGroup(queueKey, 'messages').catch(err =>
      logger.error({ queueKey, err }, 'Unhandled error in drainGroup'),
    );
    return;
  }

  // Fall through to existing drain logic (pendingMessages boolean, pendingTasks, waitingGroups)
  if (state.pendingMessages) {
    state.pendingMessages = false;
    this.runForGroup(queueKey, 'messages').catch(err =>
      logger.error({ queueKey, err }, 'Unhandled error in drainGroup'),
    );
    return;
  }

  // ... existing task drain + waiting groups logic unchanged
}
```

- [ ] **Step 4: Write priority ordering test that verifies actual order**

```typescript
describe('GroupQueue — priority ordering', () => {
  it('processes DM (priority 1) before scheduled task (priority 3)', async () => {
    const processedPriorities: number[] = [];
    let callCount = 0;

    queue.setProcessMessagesFn(async () => {
      callCount++;
      if (callCount === 1) {
        // While first container runs, queue low then high priority
        queue.enqueueWithPriority('main', 3); // scheduled task
        queue.enqueueWithPriority('main', 1); // DM — should jump ahead
      }
      // Track which priority processed (1st call is the initial trigger)
      if (callCount === 2) processedPriorities.push(1); // expect DM first
      if (callCount === 3) processedPriorities.push(3); // then scheduled
      await new Promise(r => setTimeout(r, 50));
      return true;
    });

    queue.enqueueWithPriority('main', 2); // initial trigger

    await vi.advanceTimersByTimeAsync(500);
    expect(callCount).toBe(3);
    // DM (1) should have been drained before scheduled (3)
    expect(processedPriorities).toEqual([1, 3]);
  });
});
```

- [ ] **Step 5: Run all queue tests**

Run: `npx vitest run src/group-queue.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat: folder-based queue keys with per-topic parallelism and priority ordering"
```

---

### Task 8: Container Hardening and allowedTools

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`
- Modify: `container/agent-runner/src/index.ts`

Add `--cap-drop=ALL`, `--pids-limit=100`, and tiered `--memory` to container args. Pass `allowedTools` through `ContainerInput` so the agent-runner reads it.

- [ ] **Step 1: Export buildContainerArgs for testing and write failing tests**

First, export `buildContainerArgs` from `container-runner.ts` (currently module-scoped). Add `export` keyword:

```typescript
export function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  containerConfig?: ContainerConfig,
  memoryLimit?: string,
): string[] {
```

Then add to `src/container-runner.test.ts`:

```typescript
import { buildContainerArgs } from './container-runner.js';

describe('container hardening', () => {
  it('includes --cap-drop=ALL in container args', () => {
    const args = buildContainerArgs([], 'test-container');
    expect(args).toContain('--cap-drop=ALL');
  });

  it('includes --pids-limit 100', () => {
    const args = buildContainerArgs([], 'test-container');
    const idx = args.indexOf('--pids-limit');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('100');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/container-runner.test.ts`
Expected: FAIL — flags not present.

- [ ] **Step 3: Add hardening flags**

In `src/container-runner.ts` `buildContainerArgs()`, after `--security-opt=no-new-privileges` (line 308):

```typescript
args.push('--cap-drop=ALL');
args.push('--pids-limit', '100');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Add tiered memory limit support**

Add `memoryLimit` parameter to `buildContainerArgs`:

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  containerConfig?: ContainerConfig,
  memoryLimit?: string,
): string[] {
  // ... existing code ...

  if (memoryLimit) {
    args.push('--memory', memoryLimit);
  }

  // ... rest of function ...
}
```

- [ ] **Step 6: Write and run test for memory limits**

```typescript
describe('container memory limits', () => {
  it('sets --memory when memoryLimit provided', () => {
    // Verify '--memory' '1024m' in args
  });

  it('omits --memory when not provided', () => {
    // Verify '--memory' not in args
  });
});
```

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Pass allowedTools in ContainerInput**

In `runContainerAgent`, include new fields in the JSON passed to container stdin:

```typescript
const containerInput: ContainerInput = {
  prompt,
  sessionId,
  groupFolder,
  chatJid,
  isMain,
  isScheduledTask,
  assistantName,
  allowedTools,       // NEW
  isCustomerFacing,   // NEW
  tenantId,           // NEW
};
```

- [ ] **Step 8: Update agent-runner to read allowedTools from stdin**

In `container/agent-runner/src/index.ts`, after parsing ContainerInput:

```typescript
const input: ContainerInput = JSON.parse(stdinData);

// Per-tenant allowedTools (fall back to hardcoded list for backward compat)
const allowedTools = input.allowedTools ?? [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__deal-manager__*', 'mcp__work-email__*',
  'mcp__lender-knowledge__*', 'mcp__lender-matching__*',
  'mcp__bank-statement__*', 'mcp__calendar__*',
  'mcp__personal-finance__*', 'mcp__personal-email__*',
  'mcp__document-store__*',
];
```

Then use this variable in the SDK query options:
```typescript
allowedTools: allowedTools,
```

- [ ] **Step 9: Run build**

Run: `npm run build`
Expected: Compilation succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts container/agent-runner/src/index.ts
git commit -m "feat: container hardening (cap-drop, pids-limit, tiered memory) + per-tenant allowedTools"
```

---

### Task 9: Orchestrator Rewire — Tenant-Aware Startup

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Modify: `src/router.ts`

This is the integration task. Wire tenant config into startup: create per-tenant TelegramChannels, register all chats, build reverse folder-to-JID mapping, use session resolver, pass tenant metadata to containers.

- [ ] **Step 1: Read current index.ts startup flow**

Read `src/index.ts` to understand the current `main()` / startup sequence.

- [ ] **Step 2: Add tenant config loading to startup**

After `loadState()`, load tenants:

```typescript
import { loadTenantConfig, type TenantConfig, type ResolvedTenant } from './tenant-config.js';
import { generateMcpConfig, deriveMemoryLimit } from './mcp-config-generator.js';
import { resolveSession } from './session-resolver.js';
import { createTenantTelegramChannel } from './channels/telegram.js';

let tenantConfig: TenantConfig | null = null;
let folderToTenant = new Map<string, ResolvedTenant>();
let folderToJids = new Map<string, string[]>();
```

- [ ] **Step 3: Implement multi-tenant channel creation**

In startup, after loading state:

```typescript
tenantConfig = loadTenantConfig();

if (tenantConfig) {
  for (const tenant of tenantConfig.tenants) {
    const mcpConfig = generateMcpConfig(tenant);
    const channel = createTenantTelegramChannel(tenant.botToken, {
      onMessage: handleInboundMessage,
      onChatMetadata: handleChatMetadata,
      registeredGroups: () => registeredGroups,
      assistantName: tenant.assistantName,
    }, tenant.id);

    const jids: string[] = [];

    // Register DM
    const dmJid = `tg:${tenant.chats.dm}`;
    jids.push(dmJid);
    channel.addManagedJid(dmJid);
    registerGroup(dmJid, {
      name: `${tenant.name} DM`,
      folder: tenant.groupFolder,
      trigger: `@${tenant.assistantName}`,
      added_at: new Date().toISOString(),
      requiresTrigger: tenant.requiresTrigger ?? false,
      isMain: tenant.isAdmin ?? false,
      tenantId: tenant.id,
      assistantName: tenant.assistantName,
      isCustomerFacing: tenant.isCustomerFacing,
      allowedTools: mcpConfig.allowedTools,
    });

    // Register operations group if configured
    if (tenant.chats.operations) {
      const ops = tenant.chats.operations;
      const opsJid = `tg:${ops.chatId}`;
      jids.push(opsJid);
      channel.addManagedJid(opsJid);
      registerGroup(opsJid, {
        name: `${tenant.name} Operations`,
        folder: tenant.groupFolder,
        trigger: `@${tenant.assistantName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: tenant.isAdmin ?? false,
        tenantId: tenant.id,
        assistantName: tenant.assistantName,
        allowedTools: mcpConfig.allowedTools,
      });
    }

    // Register leads group if configured
    if (typeof tenant.chats.leads === 'string' && tenant.chats.leads) {
      const leadsJid = `tg:${tenant.chats.leads}`;
      jids.push(leadsJid);
      channel.addManagedJid(leadsJid);
      registerGroup(leadsJid, {
        name: `${tenant.name} Leads`,
        folder: tenant.groupFolder,
        trigger: `@${tenant.assistantName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: tenant.isAdmin ?? false,
        tenantId: tenant.id,
        assistantName: tenant.assistantName,
        allowedTools: mcpConfig.allowedTools,
      });
    }

    folderToJids.set(tenant.groupFolder, jids);
    folderToTenant.set(tenant.groupFolder, tenant);
    channels.push(channel);
  }
} else {
  // Single-tenant fallback: existing channel factory logic (unchanged)
}
```

- [ ] **Step 4: Update processGroupMessages for multi-JID batching**

When processing a queue key for a folder with multiple JIDs, collect messages from all:

```typescript
async function processGroupMessages(queueKey: string): Promise<boolean> {
  const folder = queueKey.split(':')[0];
  const jids = folderToJids.get(folder) ?? [queueKey];
  const tenant = folderToTenant.get(folder);

  const allMessages: NewMessage[] = [];
  for (const jid of jids) {
    const cursor = lastAgentTimestamp[jid] ?? '';
    const assistantName = tenant?.assistantName ?? ASSISTANT_NAME;
    const { messages } = getMessagesSince(jid, cursor, assistantName);
    allMessages.push(...messages);
  }

  allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (allMessages.length === 0) return true;

  // ... format and run agent with tenant-scoped fields
}
```

- [ ] **Step 5: Update runAgent to pass tenant fields**

Pass `allowedTools`, `isCustomerFacing`, `tenantId`, and `memoryLimit` to the container:

```typescript
const result = await runContainerAgent({
  prompt,
  sessionId: getSession(sessionKey),
  groupFolder: group.folder,
  chatJid,
  isMain: group.isMain ?? false,
  assistantName: group.assistantName ?? ASSISTANT_NAME,
  allowedTools: group.allowedTools,
  isCustomerFacing: group.isCustomerFacing,
  tenantId: group.tenantId,
}, onOutput, {
  memoryLimit: tenant ? deriveMemoryLimit(tenant) : undefined,
});
```

- [ ] **Step 6: Update router.ts to pass MessageOptions**

```typescript
export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  options?: MessageOptions,
): Promise<void> {
  for (const channel of channels) {
    if (channel.ownsJid(jid)) {
      await channel.sendMessage(jid, text, options);
      return;
    }
  }
}
```

- [ ] **Step 7: Add topic session auto-detection helper**

The session resolver needs `topicSession` ('shared' | 'independent'), but topic config can be a simple string (display name only). Add a helper that auto-detects session mode from tool mapping:

```typescript
// Auto-detection: topics mapped to specific MCP tool categories run as independent
const INDEPENDENT_TOOL_TOPICS = new Set([
  'lender-knowledge', 'bank-statements', 'lender-matching',
]);

function resolveTopicSession(
  topicKey: string,
  topicConfig: string | { name: string; session?: string },
): 'shared' | 'independent' {
  // Explicit config takes precedence
  if (typeof topicConfig === 'object' && topicConfig.session) {
    return topicConfig.session as 'shared' | 'independent';
  }
  // Auto-detect from topic key
  if (INDEPENDENT_TOOL_TOPICS.has(topicKey)) return 'independent';
  return 'shared';
}
```

Use this in the message loop when building `SessionContext` for the session resolver. When a message arrives from an operations group with a `message_thread_id`, look up the topic config from the tenant and resolve its session mode.

- [ ] **Step 8: Update per-tenant trigger in message loop**

Replace global `TRIGGER_PATTERN` with per-group trigger:

```typescript
const group = registeredGroups[chatJid];
const assistantName = group?.assistantName ?? ASSISTANT_NAME;
const triggerPattern = group?.triggerPattern ??
  new RegExp(`^@${escapeRegex(assistantName)}\\b`, 'i');
if (group?.requiresTrigger && !triggerPattern.test(content)) continue;
```

- [ ] **Step 9: Run build**

Run: `npm run build`
Expected: Compilation succeeds.

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS. Fix any broken tests.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts src/config.ts src/router.ts
git commit -m "feat: tenant-aware startup with multi-JID batching, session resolver, and per-tenant routing"
```

---

### Task 10: MCP Config File Generation at Container Startup

**Files:**
- Modify: `src/container-runner.ts`

Generate per-tenant `.mcp.json` to `groups/{folder}/.mcp.json` before container startup, merging with group-level overrides.

- [ ] **Step 1: Read current MCP config handling**

Check how `.mcp.json` is currently mounted into containers in `container-runner.ts`.

- [ ] **Step 2: Add MCP config generation before container spawn**

In `runContainerAgent`, before building container args:

```typescript
import { generateMcpConfig } from './mcp-config-generator.js';

// Generate per-tenant .mcp.json (merged with overrides)
if (tenantConfig) {
  const tenant = findTenantByFolder(tenantConfig, groupFolder);
  if (tenant) {
    const mcpConfig = generateMcpConfig(tenant);
    const groupMcpPath = path.join(GROUPS_DIR, groupFolder, '.mcp.json');
    const overridePath = path.join(GROUPS_DIR, groupFolder, '.mcp.override.json');

    let finalServers = mcpConfig.mcpServers;

    if (fs.existsSync(overridePath)) {
      const overrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      finalServers = { ...finalServers, ...(overrides.mcpServers ?? {}) };
    } else if (fs.existsSync(groupMcpPath)) {
      // First run: preserve existing hand-crafted config as override
      fs.renameSync(groupMcpPath, overridePath);
      const overrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      finalServers = { ...finalServers, ...(overrides.mcpServers ?? {}) };
    }

    fs.writeFileSync(groupMcpPath, JSON.stringify({ mcpServers: finalServers }, null, 2));
  }
}
```

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Compilation succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: generate per-tenant .mcp.json with override merge at container startup"
```

---

### Task 11: Backward Compatibility and Integration Verification

**Files:**
- Modify: `src/index.ts` (if needed)

Ensure that when `tenants.json` doesn't exist, the system falls back to current single-bot behavior with no changes.

- [ ] **Step 1: Verify backward compat in code**

Confirm that all tenant-aware code paths have `if (tenantConfig)` guards and fall through to existing logic when null.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Compilation succeeds with no errors.

- [ ] **Step 4: Manual smoke test checklist**

Verify on the VPS:

- [ ] Start with `tenants.json` absent: single-bot mode works as before
- [ ] Start with `tenants.json` present: multi-bot mode starts, one TelegramChannel per tenant
- [ ] Send DM to main bot: routes to `groups/main/`, container spawns with correct allowedTools
- [ ] Send DM to personal bot: routes to `groups/personal/`, separate container
- [ ] Container args include `--cap-drop=ALL`, `--pids-limit=100`, `--memory` flag
- [ ] `.mcp.json` in each group folder matches tenant tool config
- [ ] Session keys persist correctly in SQLite `sessions` table

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: backward compatibility and integration verification for multi-tenant"
```

---

### Task 12: Daily Backup Script

**Files:**
- Create: `backup.sh`

Simple daily backup of SQLite, groups/, and tenants.json. Per spec Section 7.

- [ ] **Step 1: Create backup.sh**

Create `backup.sh` at project root:

```bash
#!/usr/bin/env bash
# NanoClaw daily backup
# Install: crontab -e
# Add: 0 3 * * * /home/nanoclaw/nanoclaw/backup.sh >> /home/nanoclaw/backups/nanoclaw/backup.log 2>&1
set -euo pipefail

BACKUP_DIR="${HOME}/backups/nanoclaw"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEST="${BACKUP_DIR}/${TIMESTAMP}"
NANOCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "${DEST}"

# SQLite hot backup (safe for concurrent reads)
sqlite3 "${NANOCLAW_DIR}/store/messages.db" ".backup '${DEST}/messages.db'"

# Group folders (memory, conversations, configs)
rsync -a --exclude='node_modules' "${NANOCLAW_DIR}/groups/" "${DEST}/groups/"

# Tenant config
cp -f "${NANOCLAW_DIR}/tenants.json" "${DEST}/tenants.json" 2>/dev/null || true

# Prune backups older than 14 days
find "${BACKUP_DIR}" -maxdepth 1 -type d -mtime +14 -not -path "${BACKUP_DIR}" -print0 | xargs -0 rm -rf

echo "Backup complete: ${DEST}"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x backup.sh`

- [ ] **Step 3: Commit**

```bash
git add backup.sh
git commit -m "feat: add daily backup script for SQLite, groups, and tenants.json"
```

---

## Dependency Graph

```
Task 1 (Types)
  ├── Task 2 (Tenant Config) ──── Task 3 (MCP Generator)
  │                                     │
  ├── Task 4 (Session Resolver)         │
  │                                     │
  ├── Task 5 (DB Migration)            │
  │                                     │
  ├── Task 6 (Multi-Bot Telegram)       │
  │                                     │
  ├── Task 7 (Queue + Priority)         │
  │                                     │
  ├── Task 8 (Container Hardening)      │
  │        │                            │
  └────────┴────────────────────────────┘
           │
      Task 9 (Orchestrator Rewire) ── depends on Tasks 2-8
           │
      Task 10 (MCP File Gen) ── depends on Task 3, 9
           │
      Task 11 (Backward Compat) ── depends on Task 9
           │
      Task 12 (Backup Script) ── independent (no dependencies)
```

**Parallelizable groups:**
- Tasks 2, 4, 5, 6, 7, 8 can start in parallel after Task 1
- Task 3 depends on Task 2
- Task 9 depends on all of 2-8 (integration)
- Task 10 depends on Tasks 3 and 9
- Task 11 depends on Task 9
- Task 12 is fully independent
