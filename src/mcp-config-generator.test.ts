import { describe, it, expect } from 'vitest';
import type { ResolvedTenant } from './tenant-config.js';
import {
  generateMcpConfig,
  deriveMemoryLimit,
} from './mcp-config-generator.js';

// Base fixture: admin broker tenant with two tools
const baseTenant: ResolvedTenant = {
  id: 'test-broker',
  name: 'Test Broker',
  assistantName: 'Assistant',
  botToken: 'token-abc',
  groupFolder: 'test-broker',
  dbSchema: 'broker_test',
  type: 'broker',
  isAdmin: true,
  isCustomerFacing: false,
  allTools: ['deal-manager', 'lender-knowledge'],
  contacts: { owner: '12345' },
  chats: { dm: '12345' },
};

// Customer-facing fixture
const customerTenant: ResolvedTenant = {
  ...baseTenant,
  id: 'customer-tenant',
  isAdmin: false,
  isCustomerFacing: true,
  allTools: ['deal-manager', 'lender-knowledge'],
};

describe('generateMcpConfig', () => {
  it('generates MCP servers for tenant tools only', () => {
    const result = generateMcpConfig(baseTenant);
    expect(Object.keys(result.mcpServers)).toEqual([
      'deal-manager',
      'lender-knowledge',
    ]);
    expect(result.mcpServers['deal-manager'].command).toBe('npx');
    expect(result.mcpServers['deal-manager'].args).toEqual([
      'tsx',
      '/workspace/projects/brokerpilot/modules/deal-manager/src/index.ts',
    ]);
  });

  it('injects DB_SCHEMA for schema-scoped tools', () => {
    const result = generateMcpConfig(baseTenant);
    const env = result.mcpServers['deal-manager'].env ?? {};
    expect(env['DB_SCHEMA']).toBe('broker_test');
  });

  it('does not inject DB_SCHEMA for non-scoped tools', () => {
    const result = generateMcpConfig(baseTenant);
    const env = result.mcpServers['lender-knowledge'].env ?? {};
    expect(env['DB_SCHEMA']).toBeUndefined();
  });

  it('generates allowedTools list with mcp__ prefixes', () => {
    const result = generateMcpConfig(baseTenant);
    expect(result.allowedTools).toContain('mcp__nanoclaw__*');
    expect(result.allowedTools).toContain('mcp__deal-manager__*');
    expect(result.allowedTools).toContain('mcp__lender-knowledge__*');
  });

  it('includes base SDK tools for admin tenants', () => {
    const result = generateMcpConfig(baseTenant);
    expect(result.allowedTools).toContain('Bash');
    expect(result.allowedTools).toContain('Write');
    expect(result.allowedTools).toContain('WebSearch');
  });

  it('restricts SDK tools for customer-facing tenants', () => {
    const result = generateMcpConfig(customerTenant);
    expect(result.allowedTools).toContain('Read');
    expect(result.allowedTools).toContain('Glob');
    expect(result.allowedTools).toContain('Grep');
    expect(result.allowedTools).not.toContain('Bash');
    expect(result.allowedTools).not.toContain('Write');
    expect(result.allowedTools).not.toContain('WebSearch');
  });

  it('sets env var placeholders for required env keys', () => {
    const result = generateMcpConfig(baseTenant);
    const env = result.mcpServers['deal-manager'].env ?? {};
    expect(env['SUPABASE_URL']).toBe('${SUPABASE_URL}');
    expect(env['SUPABASE_SERVICE_ROLE_KEY']).toBe(
      '${SUPABASE_SERVICE_ROLE_KEY}',
    );
  });

  it('ignores unknown tools not in MCP_TEMPLATES', () => {
    const tenantWithUnknown: ResolvedTenant = {
      ...baseTenant,
      allTools: ['deal-manager', 'unknown-tool'],
    };
    const result = generateMcpConfig(tenantWithUnknown);
    expect(Object.keys(result.mcpServers)).toEqual(['deal-manager']);
    expect(result.allowedTools).not.toContain('mcp__unknown-tool__*');
  });
});

describe('deriveMemoryLimit', () => {
  it('returns 256m for customer-facing', () => {
    const result = deriveMemoryLimit(customerTenant);
    expect(result).toBe('256m');
  });

  it('returns 768m for <=5 tools', () => {
    const tenant: ResolvedTenant = {
      ...baseTenant,
      isCustomerFacing: false,
      allTools: ['deal-manager', 'work-email', 'calendar'],
    };
    expect(deriveMemoryLimit(tenant)).toBe('768m');
  });

  it('returns 1024m for >5 tools', () => {
    const tenant: ResolvedTenant = {
      ...baseTenant,
      isCustomerFacing: false,
      allTools: [
        'deal-manager',
        'work-email',
        'personal-email',
        'calendar',
        'document-store',
        'lender-knowledge',
      ],
    };
    expect(deriveMemoryLimit(tenant)).toBe('1024m');
  });
});
