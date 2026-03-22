import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { loadTenantConfig, findTenant, findTenantByFolder } from './tenant-config.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

const minimalConfig = {
  defaults: {
    timezone: 'Australia/Sydney',
    briefingTime: '08:30',
    quietHoursStart: 20,
    quietHoursEnd: 7,
  },
  brokerDefaults: {},
  system: [],
  brokers: [
    {
      id: 'main',
      name: 'Main',
      assistantName: 'Assistant',
      botToken: 'env:TELEGRAM_BOT_TOKEN',
      groupFolder: 'main',
      dbSchema: 'work',
      contacts: { owner: 'env:TELEGRAM_CHAT_ID' },
      chats: { dm: 'env:TELEGRAM_CHAT_ID' },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadTenantConfig', () => {
  it('returns null when tenants.json does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await loadTenantConfig();
    expect(result).toBeNull();
  });

  it('loads and resolves env:VAR references', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(minimalConfig));

    const result = await loadTenantConfig();
    expect(result).not.toBeNull();
    const mainTenant = result!.tenants.find((t) => t.id === 'main');
    expect(mainTenant).toBeDefined();
    expect(mainTenant!.botToken).toBe('test-token-main');
    expect(mainTenant!.chats.dm).toBe('12345');
  });

  it('merges brokerDefaults into brokers', async () => {
    const configWithDefaults = {
      ...minimalConfig,
      brokerDefaults: {
        isAdmin: false,
        isCustomerFacing: true,
        requiresTrigger: false,
        status: 'active' as const,
        privateTools: ['deal-manager'],
        sharedTools: ['lender-knowledge'],
        ai: { mode: 'platform' as const },
      },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configWithDefaults));

    const result = await loadTenantConfig();
    expect(result).not.toBeNull();
    const mainTenant = result!.tenants.find((t) => t.id === 'main');
    expect(mainTenant!.isCustomerFacing).toBe(true);
    expect(mainTenant!.privateTools).toEqual(['deal-manager']);
    expect(mainTenant!.sharedTools).toEqual(['lender-knowledge']);
  });

  it('throws on invalid config (missing required fields)', async () => {
    const invalidConfig = {
      defaults: { timezone: 'UTC', briefingTime: '08:00', quietHoursStart: 20, quietHoursEnd: 7 },
      brokerDefaults: {},
      system: [],
      brokers: [
        {
          // missing id, name, assistantName, botToken, groupFolder, dbSchema, contacts, chats
          id: 'incomplete',
        },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(invalidConfig));

    await expect(loadTenantConfig()).rejects.toThrow();
  });

  it('resolves chats.dm from env:VAR', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(minimalConfig));

    const result = await loadTenantConfig();
    const mainTenant = result!.tenants.find((t) => t.id === 'main');
    expect(mainTenant!.chats.dm).toBe('12345');
  });

  it('loads system tenants with type "system"', async () => {
    const configWithSystem = {
      ...minimalConfig,
      brokers: [],
      system: [
        {
          id: 'personal',
          name: 'Personal Assistant',
          assistantName: 'Personal',
          botToken: 'env:TELEGRAM_PERSONAL_BOT_TOKEN',
          groupFolder: 'personal',
          dbSchema: 'personal',
          contacts: { owner: 'env:TELEGRAM_PERSONAL_CHAT_ID' },
          chats: { dm: 'env:TELEGRAM_PERSONAL_CHAT_ID' },
        },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configWithSystem));

    const result = await loadTenantConfig();
    expect(result).not.toBeNull();
    const personalTenant = result!.tenants.find((t) => t.id === 'personal');
    expect(personalTenant).toBeDefined();
    expect(personalTenant!.type).toBe('system');
    expect(personalTenant!.botToken).toBe('test-token-personal');
    expect(personalTenant!.chats.dm).toBe('67890');
  });

  it('excludes paused/suspended tenants', async () => {
    const configWithStatuses = {
      ...minimalConfig,
      brokerDefaults: {},
      brokers: [
        { ...minimalConfig.brokers[0], id: 'active-tenant', status: 'active' },
        {
          ...minimalConfig.brokers[0],
          id: 'paused-tenant',
          name: 'Paused',
          assistantName: 'Paused',
          botToken: 'env:TELEGRAM_BOT_TOKEN',
          status: 'paused',
        },
        {
          ...minimalConfig.brokers[0],
          id: 'suspended-tenant',
          name: 'Suspended',
          assistantName: 'Suspended',
          botToken: 'env:TELEGRAM_BOT_TOKEN',
          status: 'suspended',
        },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configWithStatuses));

    const result = await loadTenantConfig();
    const ids = result!.tenants.map((t) => t.id);
    expect(ids).toContain('active-tenant');
    expect(ids).not.toContain('paused-tenant');
    expect(ids).not.toContain('suspended-tenant');
  });

  it('computes allTools as privateTools + sharedTools', async () => {
    const configWithTools = {
      ...minimalConfig,
      brokerDefaults: {
        privateTools: ['tool-a', 'tool-b'],
        sharedTools: ['tool-c'],
      },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(configWithTools));

    const result = await loadTenantConfig();
    const mainTenant = result!.tenants.find((t) => t.id === 'main');
    expect(mainTenant!.allTools).toEqual(['tool-a', 'tool-b', 'tool-c']);
  });
});

describe('findTenant', () => {
  it('finds tenant by id', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(minimalConfig));

    const config = await loadTenantConfig();
    const tenant = findTenant(config!, 'main');
    expect(tenant).toBeDefined();
    expect(tenant!.id).toBe('main');
  });

  it('returns undefined for unknown id', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(minimalConfig));

    const config = await loadTenantConfig();
    const tenant = findTenant(config!, 'nonexistent');
    expect(tenant).toBeUndefined();
  });
});

describe('findTenantByFolder', () => {
  it('finds tenant by groupFolder', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(minimalConfig));

    const config = await loadTenantConfig();
    const tenant = findTenantByFolder(config!, 'main');
    expect(tenant).toBeDefined();
    expect(tenant!.groupFolder).toBe('main');
  });

  it('returns undefined for unknown folder', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(minimalConfig));

    const config = await loadTenantConfig();
    const tenant = findTenantByFolder(config!, 'unknown-folder');
    expect(tenant).toBeUndefined();
  });
});
