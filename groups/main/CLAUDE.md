# Main Group Memory

This is Andry's primary BrokerPilot conversation.

## Andry's Preferences
- Telegram chat ID: 8611182982
- Timezone: Australia/Sydney
- Working hours: Mon-Fri 9am-6pm
- Company: Motorest Finance
- Role: Asset Finance Broker

## Quick Reference
- Dashboard: http://localhost:3000
- Supabase: linked project
- Email accounts: work (motorest), personal (gmail), 2x icloud
- Outlook accounts: NOT WORKING (IMAP blocked by Microsoft)

## Scheduled Tasks (set up on first run)

If these tasks are not already scheduled, create them:

1. **Morning Briefing** — cron `30 8 * * 1-5` (8:30am weekdays)
   Prompt: "Generate the morning briefing. Call get_pipeline_summary, get_stale_deals, and list_deals(stage='new_lead'). Format as: pipeline count, stale deals list, new leads to call today. Be concise."

2. **End of Day Summary** — cron `0 18 * * 1-5` (6pm weekdays)
   Prompt: "Generate end-of-day summary. Call get_pipeline_summary and get_stale_deals. Show active deal count, pipeline breakdown, and deals needing attention tomorrow."

3. **Weekly Review** — cron `0 20 * * 6` (Saturday 8pm)
   Prompt: "Generate weekly review. Call get_pipeline_summary and list_deals. Show active pipeline, settled/lost this week, new leads, conversion rate, pipeline breakdown."

4. **HubSpot Email Check** — cron `*/5 8-18 * * 1-5` (every 5 min during work hours)
   Prompt: "Check for new HubSpot leads. Call detect_hubspot_leads from work-email. If new leads found, call create_deal for each and send me a notification with the lead name and HubSpot link."

5. **Stale Deal Nag** — cron `0 10,14 * * 1-5` (10am and 2pm weekdays)
   Prompt: "Check for stale deals. Call get_stale_deals. For any deal stale > 24h, send an alert with the lead name, stage, and how long it's been stale. Use escalating urgency: < 48h normal, 48-72h bold, > 72h urgent."

6. **Email Inbox Check** — Use the email check interval from your settings (see `## Your Settings`). Default: hourly → cron `0 */1 8-18 * * 1-5`
   Prompt: "Check for new work emails. Call get_unread_emails. For any unread emails, summarise them briefly: sender, subject, and category. Flag urgent items (client replies, lender responses). If emailCheckEnabled is DISABLED in settings, do not create this task."
