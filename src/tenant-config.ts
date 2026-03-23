import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// --- Zod Schemas ---

const TopicConfigSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    session: z.enum(['shared', 'independent']).default('shared'),
  }),
]);

const ChatsSchema = z
  .object({
    dm: z.string(),
    operations: z
      .object({
        chatId: z.string(),
        topics: z.record(z.string(), TopicConfigSchema).optional(),
      })
      .optional(),
    leads: z.string().optional(),
  })
  .catchall(z.string());

const TenantSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
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
  ai: z
    .object({ mode: z.enum(['platform', 'own']).default('platform') })
    .optional(),
  contacts: z.object({
    owner: z.string(),
    notifyOnError: z.boolean().optional(),
  }),
  chats: ChatsSchema,
});

const BrokerDefaultsSchema = z.object({
  jidPrefix: z.string().optional(),
  isAdmin: z.boolean().optional(),
  isCustomerFacing: z.boolean().optional(),
  requiresTrigger: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'suspended', 'deactivated']).optional(),
  privateTools: z.array(z.string()).optional(),
  sharedTools: z.array(z.string()).optional(),
  ai: z
    .object({ mode: z.enum(['platform', 'own']).default('platform') })
    .optional(),
});

const DefaultsSchema = z.object({
  timezone: z.string(),
  briefingTime: z.string(),
  quietHoursStart: z.number(),
  quietHoursEnd: z.number(),
});

const TenantsFileSchema = z.object({
  defaults: DefaultsSchema,
  brokerDefaults: BrokerDefaultsSchema.default({}),
  system: z.array(TenantSchema).default([]),
  brokers: z.array(TenantSchema).default([]),
});

// --- Types ---

export type ResolvedTenant = z.infer<typeof TenantSchema> & {
  type: 'system' | 'broker';
  allTools: string[];
};

export interface TenantConfig {
  defaults: z.infer<typeof DefaultsSchema>;
  tenants: ResolvedTenant[];
}

// --- Env Resolution ---

/**
 * Collect all env:VAR references from a deeply nested value.
 */
function collectEnvRefs(value: unknown): string[] {
  if (typeof value === 'string') {
    if (value.startsWith('env:')) {
      return [value.slice(4)];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectEnvRefs);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(collectEnvRefs);
  }
  return [];
}

/**
 * Recursively resolve `env:VAR` strings in a deeply nested value.
 * Falls back to process.env if the key is not in the .env map.
 * Throws if the referenced variable is not found anywhere.
 */
export function resolveEnvDeep<T>(value: T, envMap: Record<string, string>): T {
  if (typeof value === 'string') {
    if ((value as string).startsWith('env:')) {
      const varName = (value as string).slice(4);
      const resolved = envMap[varName] ?? process.env[varName];
      if (resolved === undefined) {
        throw new Error(
          `Environment variable "${varName}" is referenced in tenants.json but not found in .env or process.env`,
        );
      }
      return resolved as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvDeep(item, envMap)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvDeep(v, envMap);
    }
    return result as unknown as T;
  }
  return value;
}

// --- Loader ---

const TENANTS_FILE = path.join(process.cwd(), 'tenants.json');

/**
 * Load and validate tenants.json. Returns null if the file does not exist
 * (backward compatibility — single-tenant mode).
 *
 * Steps:
 * 1. Read and JSON-parse tenants.json
 * 2. Collect all env:VAR references and resolve them via readEnvFile()
 * 3. Substitute resolved values throughout the config
 * 4. Merge brokerDefaults into each broker (broker-specific fields win)
 * 5. Validate with Zod
 * 6. Filter out non-active tenants
 * 7. Attach type and allTools to each tenant
 */
export async function loadTenantConfig(): Promise<TenantConfig | null> {
  if (!fs.existsSync(TENANTS_FILE)) {
    logger.debug('tenants.json not found — running in single-tenant mode');
    return null;
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(TENANTS_FILE, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to read or parse tenants.json: ${(err as Error).message}`,
    );
  }

  // Collect all env var names referenced anywhere in the file
  const envVarNames = collectEnvRefs(raw);
  const envMap = envVarNames.length > 0 ? readEnvFile(envVarNames) : {};

  // Resolve env: references before Zod validation so schemas see plain strings
  const resolved = resolveEnvDeep(raw, envMap) as Record<string, unknown>;

  // Merge brokerDefaults into each broker entry (broker values override defaults)
  const brokerDefaults =
    (resolved.brokerDefaults as Record<string, unknown>) ?? {};
  const brokers = Array.isArray(resolved.brokers) ? resolved.brokers : [];
  const mergedBrokers = brokers.map((broker) => ({
    ...brokerDefaults,
    ...(broker as Record<string, unknown>),
  }));

  const dataToValidate = {
    ...resolved,
    brokers: mergedBrokers,
  };

  // Validate with Zod
  const parsed = TenantsFileSchema.parse(dataToValidate);

  // Determine which statuses are considered "active"
  const isActive = (status: string | undefined) =>
    status === undefined || status === 'active';

  // Build resolved tenants
  const systemTenants: ResolvedTenant[] = parsed.system
    .filter((t) => isActive(t.status))
    .map((t) => ({
      ...t,
      type: 'system' as const,
      allTools: [...(t.privateTools ?? []), ...(t.sharedTools ?? [])],
    }));

  const brokerTenants: ResolvedTenant[] = parsed.brokers
    .filter((t) => isActive(t.status))
    .map((t) => ({
      ...t,
      type: 'broker' as const,
      allTools: [...(t.privateTools ?? []), ...(t.sharedTools ?? [])],
    }));

  return {
    defaults: parsed.defaults,
    tenants: [...systemTenants, ...brokerTenants],
  };
}

// --- Helpers ---

export function findTenant(
  config: TenantConfig,
  id: string,
): ResolvedTenant | undefined {
  return config.tenants.find((t) => t.id === id);
}

export function findTenantByFolder(
  config: TenantConfig,
  folder: string,
): ResolvedTenant | undefined {
  return config.tenants.find((t) => t.groupFolder === folder);
}
