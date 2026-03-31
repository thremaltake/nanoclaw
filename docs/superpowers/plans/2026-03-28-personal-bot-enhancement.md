# Personal Bot Enhancement Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the NanoClaw Personal bot with receipt scanning, expense automation, vendor learning, financial year reporting, and life management features.

**Architecture:** Photos/documents sent in Telegram are downloaded by NanoClaw and saved to the group attachments directory. Claude reads the images via its multimodal vision capability and extracts receipt data, then saves via existing MCP tools (document-store, personal-finance). New tools add vendor-category learning, recurring expense detection, and FY tax reporting. Behavior is orchestrated via CLAUDE.md prompt engineering.

**Tech Stack:** TypeScript, Grammy (Telegram), Supabase (Postgres), MCP SDK, Claude multimodal vision, NanoClaw container orchestration

---

### Task 0: Supabase Migration

**Goal:** Create the `vendor_categories` table and add new columns to `tax_invoices`.

**Files:**
- Create: `/home/nanoclaw/brokerpilot/supabase/migrations/20260328_personal_bot_enhancement.sql`

**Acceptance Criteria:**
- [ ] `personal.vendor_categories` table exists with correct schema
- [ ] `personal.tax_invoices` has `source` column
- [ ] `personal.tax_invoices` has `financial_year` generated column
- [ ] Index on `vendor_categories.category` exists

**Verify:** Run migration via Supabase MCP tool or `psql`, then query `\d personal.vendor_categories` and `\d personal.tax_invoices`

**Steps:**

- [ ] **Step 1: Write and apply migration SQL**

```sql
-- vendor_categories table
CREATE TABLE IF NOT EXISTS personal.vendor_categories (
  vendor_pattern TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  times_seen INTEGER DEFAULT 1,
  last_seen DATE DEFAULT CURRENT_DATE,
  is_recurring BOOLEAN DEFAULT false,
  typical_amount NUMERIC(10,2),
  typical_interval_days INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vendor_cat_category
  ON personal.vendor_categories(category);

-- Atomic upsert function for vendor learning (increments times_seen)
CREATE OR REPLACE FUNCTION personal.upsert_vendor_category(
  p_vendor TEXT, p_category TEXT, p_amount NUMERIC DEFAULT NULL
) RETURNS VOID AS $$
INSERT INTO personal.vendor_categories (vendor_pattern, category, times_seen, last_seen, typical_amount)
VALUES (p_vendor, p_category, 1, CURRENT_DATE, p_amount)
ON CONFLICT (vendor_pattern) DO UPDATE SET
  category = EXCLUDED.category,
  times_seen = personal.vendor_categories.times_seen + 1,
  last_seen = CURRENT_DATE,
  typical_amount = COALESCE(EXCLUDED.typical_amount, personal.vendor_categories.typical_amount);
$$ LANGUAGE sql;

-- tax_invoices: add source column
ALTER TABLE personal.tax_invoices
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

-- tax_invoices: add financial_year generated column
-- FY runs July 1 to June 30. July+ = current year start, Jan-Jun = previous year start.
ALTER TABLE personal.tax_invoices
  ADD COLUMN IF NOT EXISTS financial_year TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN EXTRACT(MONTH FROM invoice_date) >= 7
      THEN 'FY' || EXTRACT(YEAR FROM invoice_date)::TEXT || '-' || (EXTRACT(YEAR FROM invoice_date)::INTEGER + 1)::TEXT
      ELSE 'FY' || (EXTRACT(YEAR FROM invoice_date)::INTEGER - 1)::TEXT || '-' || EXTRACT(YEAR FROM invoice_date)::TEXT
    END
  ) STORED;
```

- [ ] **Step 2: Verify migration applied**

```bash
# Check table exists
sudo -u nanoclaw psql -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='personal' AND table_name='vendor_categories';"

# Check new columns on tax_invoices
sudo -u nanoclaw psql -c "SELECT column_name, data_type, generation_expression FROM information_schema.columns WHERE table_schema='personal' AND table_name='tax_invoices' AND column_name IN ('source', 'financial_year');"
```

- [ ] **Step 3: Commit**

```bash
cd /home/nanoclaw/brokerpilot
git add supabase/migrations/20260328_personal_bot_enhancement.sql
git commit -m "feat: add vendor_categories table and tax_invoices FY columns

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: File Download Pipeline (telegram.ts)

**Goal:** Download photos and documents from Telegram instead of storing placeholder text, so Claude can read receipt images.

**Files:**
- Modify: `/home/nanoclaw/nanoclaw/src/channels/telegram.ts`

**Acceptance Criteria:**
- [ ] Photos are downloaded and saved to `groups/{groupFolder}/attachments/`
- [ ] Documents (PDF, images sent as files) are downloaded similarly
- [ ] Filenames are sanitized (no path traversal)
- [ ] Files > 20MB are rejected with a message to the user
- [ ] Only safe file types accepted (jpg, png, webp, heic, pdf)
- [ ] Download failures fall back to `[Photo]` placeholder
- [ ] Bot token never appears in logs
- [ ] Attachments directory created on demand

**Verify:** Send a photo to any bot → check `groups/{folder}/attachments/` for the file → check NanoClaw logs for "Telegram message stored" with the file path in content

**Steps:**

- [ ] **Step 1: Add file download helper function**

Add above the `TelegramChannel` class in `telegram.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../config.js';

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf']);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB Telegram Bot API limit

/**
 * Sanitize a filename to prevent path traversal.
 * Strips directory separators and .., limits to safe characters.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, '_')       // replace path separators
    .replace(/\.\./g, '_')        // replace ..
    .replace(/[^a-zA-Z0-9._-]/g, '_')  // only safe chars
    .slice(0, 100);               // limit length
}

/**
 * Get file extension from a filename or Telegram file_path.
 */
function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Download a file from Telegram and save to group attachments directory.
 * Returns the relative path (from group dir) on success, null on failure.
 */
async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  groupFolder: string,
  msgId: string,
  originalName: string,
  log: typeof logger,
): Promise<string | null> {
  try {
    // Get file metadata from Telegram
    const apiUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const metaRes = await fetch(apiUrl);
    const meta = await metaRes.json() as { ok: boolean; result?: { file_path: string; file_size?: number } };

    if (!meta.ok || !meta.result?.file_path) {
      log.warn({ fileId }, 'Telegram getFile failed');
      return null;
    }

    // Check file size
    if (meta.result.file_size && meta.result.file_size > MAX_FILE_SIZE) {
      log.warn({ fileId, size: meta.result.file_size }, 'File too large (>20MB)');
      return null;
    }

    // Determine extension and check allowlist
    const ext = getExtension(originalName) || getExtension(meta.result.file_path);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      log.debug({ fileId, ext }, 'File type not in allowlist, skipping download');
      return null;
    }

    // Download file — URL contains bot token, never log it
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`;
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      log.warn({ fileId, status: fileRes.status }, 'File download failed');
      return null;
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    // Save to attachments directory
    const safeName = sanitizeFilename(originalName || `file.${ext}`);
    const attachDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const filename = `${msgId}-${safeName}`;
    const filepath = path.join(attachDir, filename);
    fs.writeFileSync(filepath, buffer);

    // Return path relative to group directory
    return `attachments/${filename}`;
  } catch (err) {
    log.warn({ fileId, err }, 'File download error');
    return null;
  }
}
```

- [ ] **Step 2: Refactor storeNonText to be async and support file downloads**

Replace the existing `storeNonText` function and its callers inside the `connect()` method:

```typescript
    // Handle non-text messages — download files when possible
    const downloadAndStore = async (
      ctx: any,
      placeholder: string,
      fileId?: string,
      fileName?: string,
    ) => {
      const topicId = ctx.message?.message_thread_id;
      const chatJid = this.buildJid(ctx.chat.id, ctx.chat.type, topicId);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const msgId = ctx.message.message_id.toString();

      // Try to download the file
      let content = `${placeholder}${caption}`;
      if (fileId && group.folder) {
        const relativePath = await downloadTelegramFile(
          this.botToken,
          fileId,
          group.folder,
          msgId,
          fileName || 'file',
          logger,
        );
        if (relativePath) {
          content = `[File: ${relativePath}]${caption}`;
        }
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        topic_id: topicId,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      // Telegram sends multiple sizes — pick the largest
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      await downloadAndStore(ctx, '[Photo]', largest.file_id, 'photo.jpg');
    });

    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const name = doc?.file_name || 'document';
      await downloadAndStore(ctx, `[Document: ${name}]`, doc?.file_id, name);
    });

    // These media types don't need file download (no receipt use case)
    const storeNonText = (ctx: any, placeholder: string) => {
      const topicId = ctx.message?.message_thread_id;
      const chatJid = this.buildJid(ctx.chat.id, ctx.chat.type, topicId);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        topic_id: topicId,
      });
    };

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));
```

- [ ] **Step 3: Add GROUPS_DIR export to config.ts if not already exported**

Check `/home/nanoclaw/nanoclaw/src/config.ts` — `GROUPS_DIR` is already exported. Add import in telegram.ts if needed.

- [ ] **Step 4: Build and test**

```bash
cd /home/nanoclaw/nanoclaw
npm run build
sudo systemctl restart nanoclaw.service
# Send a photo to @AndryPersonalBot
# Check: sudo ls /home/nanoclaw/nanoclaw/groups/personal/attachments/
# Check logs: sudo journalctl -u nanoclaw.service -n 20 --no-pager
```

- [ ] **Step 5: Commit**

```bash
cd /home/nanoclaw/nanoclaw
git add src/channels/telegram.ts
git commit -m "feat: download photos and documents from Telegram for receipt scanning

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Personal Finance — Vendor Learning & Recurring Expense Tools

**Goal:** Add vendor-category learning, recurring expense detection, and spending velocity tools to the personal-finance MCP module.

**Files:**
- Modify: `/home/nanoclaw/brokerpilot/modules/personal-finance/src/db.ts`
- Modify: `/home/nanoclaw/brokerpilot/modules/personal-finance/src/tools.ts`

**Acceptance Criteria:**
- [ ] `learn_vendor_category` tool upserts vendor→category mappings
- [ ] `get_vendor_category` tool looks up a vendor's learned category
- [ ] `get_recurring_expenses` tool detects subscription-like patterns
- [ ] `get_spending_velocity` tool shows budget burn rate
- [ ] `detect_bill_from_transaction` tool checks for recurring patterns and returns next expected date
- [ ] `log_transaction` internally calls vendor learning after insert

**Verify:** Use MCP tools via the Personal bot to log a transaction, then call `get_vendor_category` with the same vendor → should return the learned category

**Steps:**

- [ ] **Step 1: Add vendor learning functions to db.ts**

Append to `/home/nanoclaw/brokerpilot/modules/personal-finance/src/db.ts`:

```typescript
// ── Vendor Category Learning ───────────────────────────────────────

export interface VendorCategory {
  vendor_pattern: string
  category: string
  times_seen: number
  last_seen: string
  is_recurring: boolean
  typical_amount: number | null
  typical_interval_days: number | null
}

/**
 * Normalize a vendor name for consistent matching.
 */
function normalizeVendor(vendor: string): string {
  return vendor.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Upsert a vendor→category mapping. Uses Postgres function to atomically increment times_seen.
 */
export async function learnVendorCategory(
  supabase: SupabaseClient,
  vendor: string,
  category: string,
  amount?: number,
): Promise<void> {
  const pattern = normalizeVendor(vendor)

  const { error } = await supabase.rpc('upsert_vendor_category', {
    p_vendor: pattern,
    p_category: category,
    p_amount: amount ? Math.abs(amount) : null,
  })

  if (error) throw new Error(`Failed to learn vendor category: ${error.message}`)
}

/**
 * Look up the learned category for a vendor.
 */
export async function getVendorCategory(
  supabase: SupabaseClient,
  vendor: string,
): Promise<VendorCategory | null> {
  const pattern = normalizeVendor(vendor)

  const { data, error } = await supabase
    .schema('personal')
    .from('vendor_categories')
    .select('*')
    .eq('vendor_pattern', pattern)
    .maybeSingle()

  if (error) throw new Error(`Failed to get vendor category: ${error.message}`)
  return data as VendorCategory | null
}

/**
 * Detect recurring expenses by finding vendors with 2+ transactions
 * at similar amounts in the given period.
 */
export async function getRecurringExpenses(
  supabase: SupabaseClient,
  months: number = 3,
): Promise<Array<{
  vendor: string
  avg_amount: number
  count: number
  last_date: string
  category: string
}>> {
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - months)
  const start = startDate.toISOString().split('T')[0]

  const { data, error } = await supabase
    .schema('personal')
    .from('transactions')
    .select('description, amount, category, date')
    .lt('amount', 0)
    .gte('date', start)
    .order('date', { ascending: false })

  if (error) throw new Error(`Failed to get transactions: ${error.message}`)

  // Group by normalized description
  const groups = new Map<string, { amounts: number[]; dates: string[]; category: string }>()
  for (const tx of data ?? []) {
    const key = normalizeVendor(tx.description as string)
    const entry = groups.get(key) || { amounts: [], dates: [], category: tx.category as string }
    entry.amounts.push(Math.abs(tx.amount as number))
    entry.dates.push(tx.date as string)
    groups.set(key, entry)
  }

  // Filter to vendors with 2+ transactions
  const recurring: Array<{
    vendor: string
    avg_amount: number
    count: number
    last_date: string
    category: string
  }> = []

  for (const [vendor, { amounts, dates, category }] of groups) {
    if (amounts.length < 2) continue
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length
    recurring.push({
      vendor,
      avg_amount: Math.round(avg * 100) / 100,
      count: amounts.length,
      last_date: dates[0], // already sorted desc
      category,
    })
  }

  return recurring.sort((a, b) => b.count - a.count)
}

/**
 * Get spending velocity: how fast the budget is being consumed this month.
 */
export async function getSpendingVelocity(
  supabase: SupabaseClient,
  category?: string,
): Promise<{
  category: string
  spent: number
  budget: number | null
  days_elapsed: number
  days_remaining: number
  projected_total: number | null
}[]> {
  const now = new Date()
  const month = resolveMonth()
  const { start, end } = monthRange(month)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysElapsed = now.getDate()
  const daysRemaining = daysInMonth - daysElapsed

  // Get expenses for current month
  let query = supabase
    .schema('personal')
    .from('transactions')
    .select('category, amount')
    .gte('date', start)
    .lte('date', end)
    .lt('amount', 0)

  if (category) {
    query = query.ilike('category', category)
  }

  const { data: txs, error: txErr } = await query
  if (txErr) throw new Error(`Failed to get transactions: ${txErr.message}`)

  // Sum by category
  const spentMap = new Map<string, number>()
  for (const tx of txs ?? []) {
    const cat = tx.category as string
    spentMap.set(cat, (spentMap.get(cat) ?? 0) + Math.abs(tx.amount as number))
  }

  // Get budgets
  const { data: budgets, error: budgetErr } = await supabase
    .schema('personal')
    .from('budgets')
    .select('category, monthly_limit')

  if (budgetErr) throw new Error(`Failed to get budgets: ${budgetErr.message}`)

  const budgetMap = new Map<string, number>()
  for (const b of budgets ?? []) {
    budgetMap.set(b.category as string, b.monthly_limit as number)
  }

  // Build result for all categories that have spending or budgets
  const allCategories = new Set([...spentMap.keys(), ...budgetMap.keys()])
  if (category) {
    // Filter to requested category
    for (const cat of allCategories) {
      if (cat.toLowerCase() !== category.toLowerCase()) allCategories.delete(cat)
    }
  }

  const results: {
    category: string
    spent: number
    budget: number | null
    days_elapsed: number
    days_remaining: number
    projected_total: number | null
  }[] = []

  for (const cat of allCategories) {
    const spent = Math.round((spentMap.get(cat) ?? 0) * 100) / 100
    const budget = budgetMap.get(cat) ?? null
    const dailyRate = daysElapsed > 0 ? spent / daysElapsed : 0
    const projected = daysElapsed > 0 ? Math.round(dailyRate * daysInMonth * 100) / 100 : null

    results.push({
      category: cat,
      spent,
      budget,
      days_elapsed: daysElapsed,
      days_remaining: daysRemaining,
      projected_total: projected,
    })
  }

  return results.sort((a, b) => b.spent - a.spent)
}

/**
 * Check if a vendor+amount matches a known recurring expense pattern.
 * Returns the expected next date if it does.
 */
export async function detectBillFromTransaction(
  supabase: SupabaseClient,
  vendor: string,
  amount: number,
  date: string,
): Promise<{ isRecurring: boolean; nextExpectedDate?: string; interval_days?: number } | null> {
  const pattern = normalizeVendor(vendor)
  const absAmount = Math.abs(amount)

  // Check vendor_categories for known recurring
  const vc = await getVendorCategory(supabase, vendor)
  if (vc?.is_recurring && vc.typical_interval_days) {
    const nextDate = new Date(date)
    nextDate.setDate(nextDate.getDate() + vc.typical_interval_days)
    return {
      isRecurring: true,
      nextExpectedDate: nextDate.toISOString().split('T')[0],
      interval_days: vc.typical_interval_days,
    }
  }

  // Check transaction history for this vendor
  const { data, error } = await supabase
    .schema('personal')
    .from('transactions')
    .select('date, amount')
    .ilike('description', `%${pattern}%`)
    .lt('amount', 0)
    .order('date', { ascending: false })
    .limit(10)

  if (error || !data || data.length < 2) return { isRecurring: false }

  // Calculate average interval between transactions
  const dates = data.map((d) => new Date(d.date as string).getTime()).sort((a, b) => b - a)
  let totalInterval = 0
  for (let i = 0; i < dates.length - 1; i++) {
    totalInterval += dates[i] - dates[i + 1]
  }
  const avgIntervalMs = totalInterval / (dates.length - 1)
  const avgIntervalDays = Math.round(avgIntervalMs / (1000 * 60 * 60 * 24))

  // If interval is between 7 and 95 days, likely recurring
  if (avgIntervalDays >= 7 && avgIntervalDays <= 95) {
    // Update vendor_categories with recurring info
    await supabase
      .schema('personal')
      .from('vendor_categories')
      .upsert({
        vendor_pattern: pattern,
        category: vc?.category ?? 'bills',
        is_recurring: true,
        typical_amount: Math.round(absAmount * 100) / 100,
        typical_interval_days: avgIntervalDays,
        last_seen: date,
      }, { onConflict: 'vendor_pattern' })

    const nextDate = new Date(date)
    nextDate.setDate(nextDate.getDate() + avgIntervalDays)
    return {
      isRecurring: true,
      nextExpectedDate: nextDate.toISOString().split('T')[0],
      interval_days: avgIntervalDays,
    }
  }

  return { isRecurring: false }
}
```

- [ ] **Step 2: Update logTransaction to auto-learn vendor categories**

Modify the existing `logTransaction` function in `db.ts`. After the insert, add:

```typescript
  // Auto-learn vendor→category mapping
  try {
    await learnVendorCategory(supabase, tx.description, tx.category, tx.amount)
  } catch {
    // Non-critical — don't fail the transaction if learning fails
  }
```

- [ ] **Step 3: Register new tools in tools.ts**

Add imports and 5 new tool registrations to `/home/nanoclaw/brokerpilot/modules/personal-finance/src/tools.ts`:

```typescript
// Add to imports at top:
import {
  logTransaction,
  getBudgetSummary,
  setBudget,
  getMonthlyReport,
  getVendorCategory,
  learnVendorCategory,
  getRecurringExpenses,
  getSpendingVelocity,
  detectBillFromTransaction,
} from './db.js'

// Add after the existing 4 tools:

  // 5. get_vendor_category
  server.tool(
    'get_vendor_category',
    'Look up the learned category for a vendor/merchant name. Returns null if not yet learned.',
    {
      vendor: z.string().min(1).describe('Vendor/merchant name to look up'),
    },
    async (params) => {
      try {
        const result = await getVendorCategory(supabase, params.vendor)
        return mcpSuccess(result ?? { category: null, message: 'No learned category for this vendor' })
      } catch (error) {
        return mcpError(error)
      }
    },
  )

  // 6. learn_vendor_category
  server.tool(
    'learn_vendor_category',
    'Save or update a vendor-to-category mapping. The system learns which category each vendor belongs to.',
    {
      vendor: z.string().min(1).describe('Vendor/merchant name'),
      category: z.string().min(1).describe('Category to associate with this vendor'),
    },
    async (params) => {
      try {
        await learnVendorCategory(supabase, params.vendor, params.category)
        return mcpSuccess({ learned: true, vendor: params.vendor, category: params.category })
      } catch (error) {
        return mcpError(error)
      }
    },
  )

  // 7. get_recurring_expenses
  server.tool(
    'get_recurring_expenses',
    'Detect subscription-like recurring expenses. Finds vendors with 2+ charges at similar amounts.',
    {
      months: z.number().optional().describe('How many months back to analyze (default 3)'),
    },
    async (params) => {
      try {
        const result = await getRecurringExpenses(supabase, params.months)
        return mcpSuccess({ recurring_expenses: result, count: result.length })
      } catch (error) {
        return mcpError(error)
      }
    },
  )

  // 8. get_spending_velocity
  server.tool(
    'get_spending_velocity',
    'Shows spending rate vs budget for the current month. Includes projected month-end total.',
    {
      category: z.string().optional().describe('Filter to a specific category (optional)'),
    },
    async (params) => {
      try {
        const result = await getSpendingVelocity(supabase, params.category)
        return mcpSuccess({ velocity: result })
      } catch (error) {
        return mcpError(error)
      }
    },
  )

  // 9. detect_bill_from_transaction
  server.tool(
    'detect_bill_from_transaction',
    'Check if a vendor + amount matches a known recurring bill pattern. Returns expected next date if recurring.',
    {
      vendor: z.string().min(1).describe('Vendor/merchant name'),
      amount: z.number().describe('Transaction amount'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Transaction date YYYY-MM-DD'),
    },
    async (params) => {
      try {
        const result = await detectBillFromTransaction(supabase, params.vendor, params.amount, params.date)
        return mcpSuccess(result)
      } catch (error) {
        return mcpError(error)
      }
    },
  )
```

- [ ] **Step 4: Build and test**

```bash
cd /home/nanoclaw/brokerpilot/modules/personal-finance
npm run build
# Restart NanoClaw to pick up module changes
sudo systemctl restart nanoclaw.service
```

- [ ] **Step 5: Commit**

```bash
cd /home/nanoclaw/brokerpilot
git add modules/personal-finance/src/db.ts modules/personal-finance/src/tools.ts
git commit -m "feat(personal-finance): add vendor learning, recurring expense detection, spending velocity

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Document Store — FY Report Tool & Source Column

**Goal:** Add `generate_fy_report` tool and support the `source` column in tax invoices.

**Files:**
- Modify: `/home/nanoclaw/brokerpilot/modules/document-store/src/db.ts`
- Modify: `/home/nanoclaw/brokerpilot/modules/document-store/src/tools.ts`

**Acceptance Criteria:**
- [ ] `save_tax_invoice` tool accepts `source` parameter
- [ ] `generate_fy_report` tool returns category breakdown, GST totals, deductible split, and missing receipt warnings
- [ ] FY defaults to current financial year
- [ ] Cross-references `personal.transactions` for missing receipts

**Verify:** Call `generate_fy_report` via the Personal bot → should return structured report even with empty data

**Steps:**

- [ ] **Step 1: Add generateFyReport function to db.ts**

Append to `/home/nanoclaw/brokerpilot/modules/document-store/src/db.ts`:

```typescript
export interface FyReportResult {
  financial_year: string
  start_date: string
  end_date: string
  total_expenses: number
  total_gst: number
  categories: Array<{
    category: string
    count: number
    total: number
    gst: number
    deductible_total: number
    non_deductible_total: number
  }>
  missing_receipts: Array<{
    description: string
    amount: number
    date: string
    category: string
  }>
}

/**
 * Parse a financial year string like 'FY2025-26' into start/end dates.
 */
function parseFyDates(fy: string): { start: string; end: string } {
  const match = fy.match(/^FY(\d{4})-(\d{2,4})$/)
  if (!match) throw new Error(`Invalid FY format: ${fy}. Use FY2025-26.`)
  const startYear = parseInt(match[1])
  return {
    start: `${startYear}-07-01`,
    end: `${startYear + 1}-06-30`,
  }
}

/**
 * Get the current Australian financial year string.
 */
function currentFy(): string {
  const now = new Date()
  const month = now.getMonth() + 1 // 1-indexed
  const year = now.getFullYear()
  if (month >= 7) {
    return `FY${year}-${String(year + 1).slice(-2)}`
  } else {
    return `FY${year - 1}-${String(year).slice(-2)}`
  }
}

/**
 * Generate a financial year tax report with category breakdown,
 * GST totals, and missing receipt detection.
 */
export async function generateFyReport(
  supabase: SupabaseClient,
  dbSchema: string,
  fy?: string,
): Promise<FyReportResult> {
  const targetFy = fy || currentFy()
  const { start, end } = parseFyDates(targetFy)

  // Get tax invoices for the FY period
  const summary = await getTaxSummary(supabase, dbSchema, start, end)

  // Build category breakdown
  const catMap = new Map<string, {
    count: number; total: number; gst: number;
    deductible_total: number; non_deductible_total: number
  }>()

  for (const inv of summary.invoices ?? []) {
    const cat = inv.category as string
    const entry = catMap.get(cat) || { count: 0, total: 0, gst: 0, deductible_total: 0, non_deductible_total: 0 }
    entry.count++
    entry.total += (inv.total_amount as number) || 0
    entry.gst += (inv.gst_amount as number) || 0
    if (inv.deductible) {
      entry.deductible_total += (inv.total_amount as number) || 0
    } else {
      entry.non_deductible_total += (inv.total_amount as number) || 0
    }
    catMap.set(cat, entry)
  }

  const categories = [...catMap.entries()].map(([category, data]) => ({
    category,
    count: data.count,
    total: Math.round(data.total * 100) / 100,
    gst: Math.round(data.gst * 100) / 100,
    deductible_total: Math.round(data.deductible_total * 100) / 100,
    non_deductible_total: Math.round(data.non_deductible_total * 100) / 100,
  })).sort((a, b) => b.total - a.total)

  // Cross-reference: find transactions without matching invoices
  const { data: transactions, error: txErr } = await supabase
    .schema(dbSchema)
    .from('transactions')
    .select('description, amount, date, category')
    .gte('date', start)
    .lte('date', end)
    .lt('amount', 0)
    .order('date', { ascending: false })

  const missing_receipts: Array<{
    description: string; amount: number; date: string; category: string
  }> = []

  if (!txErr && transactions) {
    // Get all invoice dates+amounts for matching
    const invoiceKeys = new Set(
      (summary.invoices ?? []).map((inv) =>
        `${(inv.invoice_date as string)}:${Math.abs(inv.total_amount as number).toFixed(2)}`
      )
    )

    for (const tx of transactions) {
      const key = `${tx.date}:${Math.abs(tx.amount as number).toFixed(2)}`
      if (!invoiceKeys.has(key)) {
        missing_receipts.push({
          description: tx.description as string,
          amount: Math.abs(tx.amount as number),
          date: tx.date as string,
          category: tx.category as string,
        })
      }
    }
  }

  return {
    financial_year: targetFy,
    start_date: start,
    end_date: end,
    total_expenses: Math.round(categories.reduce((s, c) => s + c.total, 0) * 100) / 100,
    total_gst: Math.round(categories.reduce((s, c) => s + c.gst, 0) * 100) / 100,
    categories,
    missing_receipts: missing_receipts.slice(0, 50), // cap at 50
  }
}
```

- [ ] **Step 2: Add `source` field to TaxInvoiceRecord interface in db.ts**

In `/home/nanoclaw/brokerpilot/modules/document-store/src/db.ts`, add to `TaxInvoiceRecord`:

```typescript
  source?: string;  // 'photo' | 'email' | 'pdf' | 'manual'
```

- [ ] **Step 3: Add source parameter to save_tax_invoice and register generate_fy_report tool**

In `tools.ts`, add `source` to the `save_tax_invoice` schema:

```typescript
      source: z.enum(['photo', 'email', 'pdf', 'manual']).optional().describe('How the invoice was captured'),
```

And add the new tool registration:

```typescript
  server.tool(
    'generate_fy_report',
    'Generate Australian financial year tax report. Shows expenses by category, GST totals, deductible breakdown, and transactions missing receipts.',
    {
      fy: z.string().optional().describe('Financial year e.g. FY2025-26 (defaults to current FY)'),
    },
    async (params) => {
      try {
        const report = await generateFyReport(supabase, dbSchema, params.fy);
        return mcpSuccess(report);
      } catch (err) {
        return mcpError(err);
      }
    },
  );
```

Add import of `generateFyReport` from `'./db.js'`.

- [ ] **Step 4: Build and test**

```bash
cd /home/nanoclaw/brokerpilot/modules/document-store
npm run build
sudo systemctl restart nanoclaw.service
```

- [ ] **Step 5: Commit**

```bash
cd /home/nanoclaw/brokerpilot
git add modules/document-store/src/db.ts modules/document-store/src/tools.ts
git commit -m "feat(document-store): add FY tax report and source column for invoices

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Personal Bot CLAUDE.md Rewrite

**Goal:** Rewrite the Personal bot's system prompt to define all new behaviors: receipt scanning, natural language expenses, briefings, shopping lists, health reminders, BAS awareness.

**Files:**
- Modify: `/home/nanoclaw/nanoclaw/groups/personal/CLAUDE.md`

**Acceptance Criteria:**
- [ ] Bot identifies as "Personal" with casual Australian tone
- [ ] Receipt scanning behavior defined (photo → extract → save → confirm)
- [ ] Natural language expense entry defined
- [ ] Morning briefing and weekly summary formats defined
- [ ] Shopping list behavior defined (Google Tasks)
- [ ] BAS/tax awareness with deadlines
- [ ] All available tools listed with usage guidance

**Verify:** Send a message to @AndryPersonalBot → should respond in casual tone. Send a receipt photo → should extract and save data. Type "coffee 4.50" → should log expense.

**Steps:**

- [ ] **Step 1: Write the complete CLAUDE.md**

Write to `/home/nanoclaw/nanoclaw/groups/personal/CLAUDE.md`:

```markdown
# Personal Assistant

You are Andry's personal AI assistant. Your name is **Personal**. This is a private chat — completely separate from work.

## Personality

- Casual, friendly, Australian English
- Brief and to the point — no corporate speak
- Proactive with suggestions but not pushy
- Use emoji sparingly, only when it adds warmth

## Receipt & Invoice Scanning

When the user sends a **photo or document** (you'll see `[File: attachments/...]` in the message):

1. Read the file using the Read tool at `/workspace/group/{path from message}`
2. Extract: vendor name, date, total amount, GST amount, line items, payment method
3. Call `save_tax_invoice` with extracted data, set `source: 'photo'` and `local_path` to the file path
4. Call `log_transaction` with: date, vendor as description, negative amount, inferred category, account "everyday"
5. Call `detect_bill_from_transaction` to check if this is a recurring bill
6. If recurring: offer to create a Google Task reminder for the next expected date
7. Respond briefly: "Saved: Woolworths $85.20 (Groceries, GST $7.75)"

If you can't read the image clearly, ask the user to retake the photo.

## Natural Language Expense Entry

When the user sends a short message that looks like an expense (e.g., "coffee 4.50", "uber $35", "lunch with dave 22", "woolies 85.20"):

1. Call `get_vendor_category` to check for a learned category
2. If category found: log immediately with `log_transaction` and confirm
3. If category unknown: ask "What category?" — then log and call `learn_vendor_category`
4. Respond: "Logged: Coffee $4.50 (Dining)"

Default account is "everyday" unless the user specifies otherwise.

## Email Receipt Detection

When running the email check scheduled task:

1. Call `get_personal_unread` with `category: 'bills'`
2. For each bill email: extract vendor, amount, date from the email body
3. Present to the user: "Found a bill from Origin Energy for $180.50. Save it?"
4. On confirmation: save invoice + log transaction + check for recurring + create reminder

## Morning Briefing

When prompted for a morning briefing (scheduled task, weekdays 8am):

1. Call `get_today_schedule` for calendar events
2. Call `get_spending_velocity` for budget status
3. Call `get_personal_unread` for email summary
4. Format:

```
Morning! Here's your day:

Calendar: 2 events (9am Dentist, 2pm Call with Dave)
Bills due: Telstra $89 (due tomorrow)
Emails: 5 unread (2 bills, 1 personal, 2 newsletters)
Budget: Groceries 65% ($195/$300), Dining 40% ($80/$200)
```

## Weekly Summary

When prompted for weekly summary (scheduled task, Sunday 6pm):

1. Call `get_monthly_report` for current month data
2. Call `get_spending_velocity` for projections
3. Format spending by category with percentages and budget status

## Shopping List

Use Google Tasks for shopping lists:
- "Add milk to shopping list" → `create_task` with title "Shopping: Milk"
- "What's on my shopping list?" → list tasks matching "Shopping:" prefix
- "Got the milk" → mark the task as complete

## Health & Reminders

For recurring personal reminders (medication, exercise, etc.):
- Use NanoClaw's `schedule_task` tool to create cron-based reminders
- "Remind me to take vitamins at 8am daily" → schedule a daily cron task

## Subscription Tracking

When asked about subscriptions:
1. Call `get_recurring_expenses` to detect patterns
2. Present as a table: Vendor | Amount | Frequency | Last Charge
3. Flag any that seem unused or have changed in amount

## BAS / Tax

- Australian Financial Year: July 1 to June 30
- BAS quarter deadlines: Q1 Oct 28, Q2 Feb 28, Q3 Apr 28, Q4 Jul 28
- GST rate: 10% (1/11th of total for GST-inclusive prices)
- GST-free: basic groceries, medical, bank fees, government charges, wages/super
- When asked for tax summary: call `generate_fy_report`
- When asked about BAS: calculate GST collected vs GST paid for the quarter

## Available MCP Tools

### Personal Finance
- `log_transaction` — Record income/expense (auto-learns vendor category)
- `get_budget_summary` — Budget vs actual for a month
- `set_budget` — Set monthly budget limit
- `get_monthly_report` — Full monthly financial report
- `get_vendor_category` — Look up learned category for a vendor
- `learn_vendor_category` — Teach a vendor→category mapping
- `get_recurring_expenses` — Detect subscription patterns
- `get_spending_velocity` — Budget burn rate with projections
- `detect_bill_from_transaction` — Check if a charge is a recurring bill

### Document Store
- `save_tax_invoice` — Save receipt/invoice with GST tracking
- `save_document` — Save generic document records
- `get_tax_summary` — Tax/BAS summary for date range
- `generate_fy_report` — Full financial year tax report
- `search_documents` — Search stored documents

### Personal Email
- `get_personal_unread` — Unread emails by category
- `search_personal_emails` — Search email by subject/sender/body
- `get_personal_thread` — Full email thread

### Calendar
- `get_today_schedule` — Today's events
- `get_upcoming` — Events for next N days
- `create_event` — Create calendar event
- `create_task` — Create Google Task

### Bank Statement
- `analyse_statement` — Analyse uploaded bank statement PDF

### NanoClaw
- `schedule_task` — Create recurring scheduled tasks
- `send_message` — Send a message to any registered chat

## Data Isolation

All your data is in the **personal** Supabase schema — completely separate from work data. Do NOT access work tools unless explicitly asked.
```

- [ ] **Step 2: Verify it takes effect**

```bash
# CLAUDE.md takes effect on next container spawn — no rebuild needed
# Send a test message to @AndryPersonalBot
# Check response uses casual tone and mentions correct tools
```

- [ ] **Step 3: Commit**

```bash
cd /home/nanoclaw/nanoclaw
git add groups/personal/CLAUDE.md
git commit -m "feat: rewrite Personal bot CLAUDE.md with receipt scanning and life management behaviors

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Create Scheduled Tasks

**Goal:** Configure the morning briefing, weekly summary, email scan, and BAS reminder scheduled tasks.

**Files:**
- Direct SQLite inserts to `/home/nanoclaw/nanoclaw/store/messages.db`

**Acceptance Criteria:**
- [ ] Morning briefing task exists (8am weekdays AEST)
- [ ] Weekly summary task exists (6pm Sunday AEST)
- [ ] Email receipt scan task exists (noon daily)
- [ ] 4 BAS quarter reminder tasks exist
- [ ] All tasks have correct `group_folder: 'personal'` and target the personal DM JID

**Verify:** `sqlite3 messages.db "SELECT id, prompt, schedule_value, status FROM scheduled_tasks WHERE group_folder='personal';"` → 7 rows

**Steps:**

- [ ] **Step 1: Get the personal DM JID**

```bash
sudo sqlite3 /home/nanoclaw/nanoclaw/store/messages.db \
  "SELECT jid FROM registered_groups WHERE tenant_id='personal' AND name LIKE '%DM%';"
```

- [ ] **Step 2: Insert scheduled tasks**

Use the JID from step 1 (expected: `tg:personal:8611182982`):

```bash
sudo sqlite3 /home/nanoclaw/nanoclaw/store/messages.db "
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES
('personal-morning-briefing', 'personal', 'tg:personal:8611182982', 'Generate my morning briefing: check calendar with get_today_schedule, check budget status with get_spending_velocity, check emails with get_personal_unread. Format as the morning briefing template.', 'cron', '0 8 * * 1-5', 'group', NULL, 'active', datetime('now')),
('personal-weekly-summary', 'personal', 'tg:personal:8611182982', 'Generate my weekly spending summary: call get_monthly_report for current month data and get_spending_velocity for projections. Show category breakdown with percentages and budget comparison. Format as the weekly summary template.', 'cron', '0 18 * * 0', 'group', NULL, 'active', datetime('now')),
('personal-email-receipt-scan', 'personal', 'tg:personal:8611182982', 'Check my personal emails for new bills and receipts: call get_personal_unread with category bills. For any bills found, extract the vendor, amount, and date. Present each one and ask if I want to save it.', 'cron', '0 12 * * *', 'group', NULL, 'active', datetime('now')),
('personal-bas-q1', 'personal', 'tg:personal:8611182982', 'BAS Q1 (Jul-Sep) is due on October 28. Generate a GST summary for the quarter using get_tax_summary with dates Jul 1 to Sep 30.', 'cron', '0 9 14 10 *', 'isolated', NULL, 'active', datetime('now')),
('personal-bas-q2', 'personal', 'tg:personal:8611182982', 'BAS Q2 (Oct-Dec) is due on February 28. Generate a GST summary for the quarter using get_tax_summary with dates Oct 1 to Dec 31.', 'cron', '0 9 14 2 *', 'isolated', NULL, 'active', datetime('now')),
('personal-bas-q3', 'personal', 'tg:personal:8611182982', 'BAS Q3 (Jan-Mar) is due on April 28. Generate a GST summary for the quarter using get_tax_summary with dates Jan 1 to Mar 31.', 'cron', '0 9 14 4 *', 'isolated', NULL, 'active', datetime('now')),
('personal-bas-q4', 'personal', 'tg:personal:8611182982', 'BAS Q4 (Apr-Jun) is due on July 28. Generate a GST summary for the quarter using get_tax_summary with dates Apr 1 to Jun 30.', 'cron', '0 9 14 7 *', 'isolated', NULL, 'active', datetime('now'));
"
```

- [ ] **Step 3: Restart NanoClaw to pick up new tasks**

```bash
sudo systemctl restart nanoclaw.service
# Verify tasks loaded:
sudo journalctl -u nanoclaw.service -n 30 --no-pager | grep -i "scheduled\|task"
```

---

### Task 6: Attachment Cleanup & Final Verification

**Goal:** Add attachment cleanup logic and do end-to-end testing of all features.

**Files:**
- Modify: `/home/nanoclaw/nanoclaw/src/index.ts` (add startup cleanup)

**Acceptance Criteria:**
- [ ] Old attachments (>7 days) are cleaned up on NanoClaw startup
- [ ] Receipt photo → extracts and saves to DB
- [ ] "coffee 4.50" → logs expense with auto-category
- [ ] `generate_fy_report` returns structured report
- [ ] Morning briefing format is correct
- [ ] All 4 bots still respond (no regressions)

**Verify:** Full end-to-end test sequence via Telegram

**Steps:**

- [ ] **Step 0: Add GROUPS_DIR to index.ts imports**

In `/home/nanoclaw/nanoclaw/src/index.ts`, add `GROUPS_DIR` to the config import:

```typescript
import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  escapeRegex,
  GROUPS_DIR,      // ← ADD THIS
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
```

- [ ] **Step 1: Add attachment cleanup function to index.ts**

Add near the top of the `main()` function in `/home/nanoclaw/nanoclaw/src/index.ts`, after `loadState()`:

```typescript
  // Clean up old attachments (>7 days) from all group directories
  function cleanupOldAttachments(): void {
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
    const now = Date.now();
    try {
      const groupDirs = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
      for (const dir of groupDirs) {
        if (!dir.isDirectory()) continue;
        const attachDir = path.join(GROUPS_DIR, dir.name, 'attachments');
        if (!fs.existsSync(attachDir)) continue;
        const files = fs.readdirSync(attachDir);
        for (const file of files) {
          const filePath = path.join(attachDir, file);
          const stat = fs.lstatSync(filePath);
          if (stat.isSymbolicLink()) continue; // never follow symlinks
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            logger.debug({ file: filePath }, 'Deleted old attachment');
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Attachment cleanup error');
    }
  }
  cleanupOldAttachments();
```

- [ ] **Step 2: Build and restart**

```bash
cd /home/nanoclaw/nanoclaw
npm run build
sudo systemctl restart nanoclaw.service
```

- [ ] **Step 3: End-to-end test sequence**

1. Send a receipt photo to @AndryPersonalBot → verify extraction + save
2. Type "coffee 4.50" to @AndryPersonalBot → verify expense logged
3. Type "coffee 5.00" again → verify auto-categorized (learned from step 2)
4. Ask "what are my subscriptions?" → verify recurring expense detection
5. Ask "generate my tax report" → verify FY report
6. Send a message to each of the other bots to verify no regressions
7. Check scheduled tasks: `sudo sqlite3 /home/nanoclaw/nanoclaw/store/messages.db "SELECT id, status FROM scheduled_tasks WHERE group_folder='personal';"`

- [ ] **Step 4: Final commits**

```bash
cd /home/nanoclaw/nanoclaw
git add src/index.ts
git commit -m "feat: add attachment cleanup on startup

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
