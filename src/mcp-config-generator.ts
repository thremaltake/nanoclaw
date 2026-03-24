import type { ResolvedTenant } from './tenant-config.js';

// --- Interfaces ---

export interface McpTemplate {
  command: string;
  args: string[];
  envKeys: string[];
  schemaScoped: boolean;
}

export interface GeneratedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  allowedTools: string[];
}

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// --- SDK Tool Sets ---

const ADMIN_SDK_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

const CUSTOMER_SDK_TOOLS = ['Read', 'Glob', 'Grep'];

// --- MCP Templates ---

export const MCP_TEMPLATES: Record<string, McpTemplate> = {
  'deal-manager': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/deal-manager/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'work-email': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/work-email/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'personal-email': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/personal-email/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  calendar: {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/calendar/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'document-store': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/document-store/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'lender-knowledge': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/lender-knowledge/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VOYAGE_API_KEY'],
    schemaScoped: false,
  },
  'lender-matching': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/lender-matching/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: false,
  },
  'bank-statement': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/bank-statement/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
  'personal-finance': {
    command: 'npx',
    args: [
      'tsx',
      '/workspace/projects/brokerpilot/modules/personal-finance/src/index.ts',
    ],
    envKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    schemaScoped: true,
  },
};

// --- Generator ---

/**
 * Generate a .mcp.json config and allowedTools list for a tenant.
 *
 * - Only tools present in MCP_TEMPLATES are included.
 * - Env vars are written as `${VAR}` placeholders for runtime substitution.
 * - Schema-scoped tools receive DB_SCHEMA set to tenant.dbSchema.
 * - Admin/broker tenants get full SDK tool access; customer-facing get restricted set.
 */
export function generateMcpConfig(tenant: ResolvedTenant): GeneratedMcpConfig {
  const mcpServers: Record<string, McpServerConfig> = {};
  const mcpToolNames: string[] = [];

  for (const toolName of tenant.allTools) {
    const template = MCP_TEMPLATES[toolName];
    if (!template) continue;

    const env: Record<string, string> = {};

    for (const key of template.envKeys) {
      env[key] = `\${${key}}`;
    }

    if (template.schemaScoped) {
      env['DB_SCHEMA'] = tenant.dbSchema;
    }

    mcpServers[toolName] = {
      command: template.command,
      args: template.args,
      env,
    };

    mcpToolNames.push(toolName);
  }

  const sdkTools = tenant.isCustomerFacing
    ? CUSTOMER_SDK_TOOLS
    : ADMIN_SDK_TOOLS;

  const allowedTools: string[] = [
    ...sdkTools,
    'mcp__nanoclaw__*',
    ...mcpToolNames.map((name) => `mcp__${name}__*`),
  ];

  return { mcpServers, allowedTools };
}

// --- Memory Limit Derivation ---

/**
 * Derive a Docker memory limit string for a tenant's container.
 *
 * - Customer-facing: 256m (lightweight, restricted tools)
 * - <=5 tools: 768m
 * - >5 tools: 1024m
 */
export function deriveMemoryLimit(tenant: ResolvedTenant): string {
  if (tenant.isCustomerFacing) return '2048m';
  if (tenant.allTools.length > 5) return '8192m';
  return '4096m';
}
