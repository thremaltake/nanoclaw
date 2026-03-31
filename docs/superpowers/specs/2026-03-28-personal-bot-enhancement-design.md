# Personal Bot Enhancement — Design Spec

**Date:** 2026-03-28
**Status:** Approved
**Scope:** Enhance NanoClaw Personal bot (@AndryPersonalBot) with receipt scanning, expense automation, life management features

## Context

The Personal bot runs on NanoClaw as tenant `personal`, using Claude Max via OAuth. It already has 5 MCP modules: personal-finance, personal-email, calendar, document-store, bank-statement. All data lives in the `personal` Supabase schema.

Claude is multimodal — it can read images natively. No external OCR service needed.

## Changes

### 1. File Download Pipeline (telegram.ts)

**Problem:** Photos/documents sent in Telegram are stored as `[Photo]` placeholder text. The actual file never reaches the Claude agent.

**Solution:** Download files from Telegram API, save to group attachments directory, include the file path in the message content.

**Flow:**
1. `message:photo` handler calls `bot.api.getFile(fileId)` to get file metadata including `file_size`
2. Reject files > 20MB (Telegram Bot API download limit) with a user-facing message
3. Only accept safe file types: images (jpg, png, webp, heic) and documents (pdf). Reject others.
4. Downloads file via `https://api.telegram.org/file/bot{token}/{filePath}` — download URL must NEVER be logged (contains bot token)
5. **Sanitize filename:** strip directory separators (`/`, `\`, `..`), limit to alphanumeric + dash + dot. Prevents path traversal.
6. `mkdirSync` the attachments directory if it doesn't exist: `groups/{groupFolder}/attachments/`
7. Saves to `groups/{groupFolder}/attachments/{msgId}-{sanitizedName}`
8. Stores message as `[Photo: attachments/{msgId}-{name}] {caption}` (relative to group dir)
9. Same flow for `message:document` (PDFs, images sent as files)
10. **On download failure:** fall back to `[Photo] {caption}` placeholder so the message is not lost. Log the error at warn level.

**Async refactor:** The `storeNonText` function and photo/document handlers must be made `async` to support the download await. This is a small but necessary change to the existing handler pattern.

**Mount:** The group directory is already mounted at `/workspace/group` in containers. Attachments subdirectory is automatically accessible. No changes to `container-runner.ts` needed.

**Cleanup:** Startup hook + daily NanoClaw scheduled task deletes attachment files older than 7 days using `fs.readdirSync` + `fs.lstatSync` (do not follow symlinks) + `fs.unlinkSync`. Permanent copies are referenced in Supabase (document-store saves the path).

### 2. personal-finance Module Enhancements

**New table:** `personal.vendor_categories`
```sql
CREATE TABLE personal.vendor_categories (
  vendor_pattern TEXT PRIMARY KEY,  -- normalized vendor name (lowercase, trimmed)
  category TEXT NOT NULL,
  times_seen INTEGER DEFAULT 1,
  last_seen DATE,
  is_recurring BOOLEAN DEFAULT false,
  typical_amount NUMERIC(10,2),
  typical_interval_days INTEGER  -- null if not recurring
);
```

**New tools:**

- `learn_vendor_category(vendor, category)` — Upsert vendor-to-category mapping. Increments `times_seen`. Called automatically after each expense entry.

- `get_vendor_category(vendor)` — Look up learned category for a vendor. Returns null if unknown. Claude checks this before asking the user to categorize.

- `get_recurring_expenses(months?)` — Query transactions grouped by vendor where similar amounts appear 2+ times in the period. Returns vendor, avg amount, frequency, last charge date. Flags potential subscriptions.

- `get_spending_velocity(category?, period?)` — Returns spending rate for current month vs budget. "You've spent $X of $Y budget with Z days remaining." If no budget set, just returns total.

- `detect_bill_from_transaction(vendor, amount, date)` — Check if this vendor+amount pattern matches a known recurring expense. If yes, return the expected next date. Used by the receipt scanner to auto-create reminders.

**Enhancement to `log_transaction`:** After inserting the transaction, the tool handler internally calls the vendor learning upsert (same module, direct function call — not a separate MCP tool call). This keeps it atomic and avoids relying on Claude to chain two tool calls every time.

**Index:** Add `CREATE INDEX idx_vendor_cat_category ON personal.vendor_categories(category);` for query performance.

### 3. document-store Module Enhancements

**Schema change to `personal.tax_invoices`:**
- Reuse existing `local_path` column for receipt attachment paths (already exists, same purpose as proposed `attachment_path` — no new column needed)
- Add column: `source TEXT DEFAULT 'manual'` — how the invoice was captured: 'photo', 'email', 'pdf', 'manual'
- Add column: `financial_year TEXT` — Postgres generated column: `GENERATED ALWAYS AS (CASE WHEN EXTRACT(MONTH FROM invoice_date) >= 7 THEN 'FY' || EXTRACT(YEAR FROM invoice_date)::TEXT || '-' || (EXTRACT(YEAR FROM invoice_date) + 1)::TEXT ELSE 'FY' || (EXTRACT(YEAR FROM invoice_date) - 1)::TEXT || '-' || EXTRACT(YEAR FROM invoice_date)::TEXT END) STORED`

**New tool:**

- `generate_fy_report(fy?)` — Generate a financial year tax report grouped by ATO deduction categories. Internally calls `getTaxSummary` (existing function) for invoice aggregation, then cross-references `personal.transactions` table for missing-receipt detection (both tables live in the same Supabase schema, so this cross-module query is safe). Returns:
  - Total expenses by category
  - Total GST paid (claimable)
  - Deductible vs non-deductible breakdown
  - Count of receipts per category
  - Missing receipt warnings (transactions without matching invoices)
  - Default: current FY. Accepts FY string like 'FY2025-26'.

### 4. Personal Bot CLAUDE.md Rewrite

Complete rewrite of `/home/nanoclaw/nanoclaw/groups/personal/CLAUDE.md` to define all behaviors:

**Identity & Tone:**
- Name: "Personal" (not BrokerPilot)
- Casual, friendly, Australian English
- Brief responses unless detail requested
- No broker/work language

**Receipt Scanning Behavior:**
- When user sends a photo or document: read the image, extract vendor/date/amount/GST/line items
- Call `save_tax_invoice` with extracted data + `attachment_path` + `source: 'photo'`
- Call `log_transaction` with amount (negative), vendor as description, learned or inferred category
- Check `detect_bill_from_transaction` — if recurring, offer to create a reminder via `create_task`
- Respond with a brief confirmation: "Saved: Woolworths $85.20 (Groceries, GST $7.75)"

**Natural Language Expense Entry:**
- Short messages matching pattern like "coffee 4.50", "uber $35", "lunch with dave 22" → treat as expense
- Check `get_vendor_category` for auto-categorization
- If unknown vendor, ask category once, then learn it
- Confirm with one line: "Logged: Coffee $4.50 (Dining)"

**Email Receipt Detection (scheduled task behavior):**
- When running email check task: call `get_personal_unread(category: 'bills')`
- For each bill email: extract receipt data, present to user for confirmation
- On confirmation: save invoice + log transaction + create reminder if recurring

**Morning Briefing Format:**
```
Good morning! Here's your day:

Calendar: 2 events (9am Dentist, 2pm Call with Dave)
Bills due: Telstra $89 (due tomorrow)
Emails: 5 unread (2 bills, 1 personal, 2 newsletters)
Budget: Groceries 65% used ($195/$300), Dining 40% ($80/$200)
```

**Weekly Summary Format:**
```
Week ending 28 Mar:

Total spent: $620
  Groceries    $210 (34%)
  Transport    $95 (15%)
  Dining       $85 (14%)
  Subscriptions $45 (7%)
  Other        $185 (30%)

vs last week: +$45 (+8%)
Budget status: On track for Groceries, Over for Dining
```

**Shopping List:** Use Google Tasks. Prefix task titles with "Shopping: ". When user says "add X to shopping list" → `create_task("Shopping: X")`. When asked "what's on my list" → query tasks with Shopping prefix.

**Health/Medication Reminders:** Use NanoClaw scheduled tasks. "Remind me to take vitamins at 8am daily" → create a cron scheduled task.

**Subscription Tracking:** When asked, run `get_recurring_expenses` and present a table of detected subscriptions with amounts and last charge dates.

**BAS/Tax Awareness:**
- Australian FY: July 1 - June 30
- Track GST on all invoices
- BAS quarter deadlines: Q1 Oct 28, Q2 Feb 28, Q3 Apr 28, Q4 Jul 28
- When asked for tax summary: call `generate_fy_report`
- GST-free items to know: basic groceries, medical, bank fees, government charges, wages/super

### 5. Scheduled Tasks (configured post-deployment)

Created via NanoClaw IPC or direct DB insert:

| Task | Schedule | Prompt |
|------|----------|--------|
| Morning briefing | `0 8 * * 1-5` (8am weekdays AEST) | "Generate morning briefing: check calendar, pending bills, budget status, unread emails" |
| Weekly summary | `0 18 * * 0` (6pm Sunday AEST) | "Generate weekly spending summary with category breakdown and budget comparison" |
| Email receipt scan | `0 12 * * *` (noon daily) | "Check personal emails for new bills and shopping receipts. Present any found for confirmation." |
| BAS Q1 reminder | `0 9 14 10 *` (Oct 14) | "BAS Q1 (Jul-Sep) due in 14 days. Generate GST summary for the quarter." |
| BAS Q2 reminder | `0 9 14 2 *` (Feb 14) | "BAS Q2 (Oct-Dec) due in 14 days. Generate GST summary for the quarter." |
| BAS Q3 reminder | `0 9 14 4 *` (Apr 14) | "BAS Q3 (Jan-Mar) due in 14 days. Generate GST summary for the quarter." |
| BAS Q4 reminder | `0 9 14 7 *` (Jul 14) | "BAS Q4 (Apr-Jun) due in 14 days. Generate GST summary for the quarter." |

### 6. Reliability Improvements (from issue A)

While we're touching NanoClaw:

- **Container memory:** Personal bot containers should use less memory than BrokerPilot (fewer MCP tools). Set memory limit appropriately in `mcp-config-generator.ts`.
- **Attachment cleanup:** Add a cron or startup task to prune attachments older than 7 days from all group directories.

## What We're NOT Building

- External OCR service integration (Claude vision is sufficient)
- Voice message transcription (Telegram voice → text requires Whisper or similar; defer to later)
- Mobile app or web dashboard (Telegram is the interface)
- Savings goal tracking (can be done via CLAUDE.md prompt later if wanted)
- Travel expense grouping (can be done via CLAUDE.md prompt later if wanted)

## File Change Summary

| File | Change Type | Size |
|------|-------------|------|
| `nanoclaw/src/channels/telegram.ts` | Modify — async file download for photos/documents, filename sanitization, size/type checks | ~70 lines |
| `brokerpilot/modules/personal-finance/src/tools.ts` | Modify — add 5 new tools, enhance log_transaction with vendor learning | ~180 lines |
| `brokerpilot/modules/personal-finance/src/db.ts` or inline | New vendor_categories types + queries | ~80 lines |
| `brokerpilot/modules/document-store/src/tools.ts` | Modify — add source column, generate_fy_report with cross-table query | ~120 lines |
| `nanoclaw/groups/personal/CLAUDE.md` | Rewrite — full behavior specification | ~200 lines |
| Supabase migration | New table + alter columns + indexes + generated column | ~40 lines SQL |
| Scheduled tasks | Post-deployment config | 7 task inserts |

**Total new/modified code:** ~690 lines across 5 files + 1 migration

## Dependencies

- NanoClaw must be rebuilt after telegram.ts changes (`npm run build` + `systemctl restart`)
- BrokerPilot modules rebuild after tool changes (`npm run build` in each module dir)
- Supabase migration must run before module changes go live
- CLAUDE.md takes effect immediately (read on each container spawn)
- Scheduled tasks created after everything else is deployed

## Testing

1. Send a receipt photo to @AndryPersonalBot → should extract and save
2. Type "coffee 4.50" → should log as expense
3. Check `get_tax_summary` → should include the new entries
4. Wait for morning briefing scheduled task → should fire at 8am
5. Forward a bill email to personal email → email scan task should detect it
