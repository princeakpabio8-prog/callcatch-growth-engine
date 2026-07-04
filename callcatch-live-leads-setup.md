# CallCatch AI Prospect Intelligence CRM

This is the local v2 sales workspace for CallCatch outbound growth. It keeps the existing lead-search API working while adding CRM, scoring, website intelligence, approval queues, exports, and analytics.

## Start

Open PowerShell in this folder:

```powershell
cd C:\Users\hp\Documents\Codex\2026-07-03\i\outputs
node .\callcatch-lead-server.js
```

Then open:

```text
http://127.0.0.1:8787/
```

Use the server URL above instead of opening the HTML file directly. This keeps the dashboard and API on the same local origin and avoids browser `Failed to fetch` errors.

## What Works Now

- `POST /api/leads` is preserved.
- Free public discovery through Nominatim and OpenStreetMap/Overpass.
- Searches by trade, city, state, ZIP input, radius input, and count.
- Expanded service trades.
- CRM records with stage, notes, owner, timeline, next follow-up, and assigned team member.
- CallCatch Fit Score, revenue estimate, opportunity level, response priority, insights, and sales angle.
- Website scanning endpoint for public website signals.
- Approval queue for email, SMS, LinkedIn, and call scripts.
- Saved searches, campaign enrollment, and server-side audit log.
- Start Daily Growth automation for daily prospect discovery, enrichment, scoring, and outreach queue generation.
- Automation levels: Manual, Assisted, and Auto Pilot.
- Local JSON CRM storage at `outputs/data/callcatch-crm.json`.
- Drag-and-drop pipeline.
- Daily assistant view.
- Analytics and territory views.
- CSV, Excel-compatible, JSON, clipboard, and PDF report exports.
- Dark mode.

## Safety

The system generates outreach but does not send it. Messages stay in the approval queue until a human copies or approves them.

## Connect Email Sending

The easiest option is to edit:

```text
email-settings.env
```

It is already set to use `hello@callcatch.site` as the mailbox. Fill in the SMTP host and password for the service that hosts that mailbox, then restart the server.

You can also set SMTP variables before starting the server. Example for a secure SMTP provider:

```powershell
$env:SMTP_HOST="smtp.gmail.com"
$env:SMTP_PORT="465"
$env:SMTP_SECURE="true"
$env:SMTP_USER="hello@callcatch.site"
$env:SMTP_PASS="your-mailbox-password-or-app-password"
$env:SMTP_FROM="hello@callcatch.site"
node .\callcatch-lead-server.js
```

For Gmail, use an app password, not your normal account password. Other SMTP providers work too, such as Outlook SMTP, SendGrid SMTP, Mailgun SMTP, or your own mailbox provider.

In the dashboard:

1. Go to `Campaigns`.
2. Click `Check Email`.
3. Send a test email.
4. Mark queued email drafts as approved.
5. Click `Send Approved Emails`.

Only approved email tasks are sent. SMS, LinkedIn, and calendar sending remain adapter-ready but not connected in this build.

Recipient emails are auto-filled when the CRM record already has a public email. If a lead has a website but no email, the sending engine tries a website scan before failing the send. If no public email exists anywhere, the task is marked `Needs Email` instead of guessing.

## Smart Sending Engine

The Campaigns screen supports:

- Send Now for one approved email.
- Send All Approved for approved email tasks only.
- Scheduled send presets: Today 2 PM, Tomorrow 9 AM, Next Monday 8 AM.
- Configurable limits for emails per hour and per day.
- Randomized delay metadata for more natural pacing.
- Follow-up generation after no reply.
- Manual reply recording with meeting intent detection.
- CRM timeline updates for sent, failed, scheduled, replied, and meeting-intent events.

Reply tracking is provider-ready. Until a Gmail API, Microsoft Graph, or mailbox polling adapter is connected, paste replies into the Reply Tracking panel.

Future integrations can be added for Gmail, Outlook, SMTP, calendars, HubSpot, Salesforce, GoHighLevel, Twilio, Slack, Zapier, Make.com, Stripe, and CallCatch.

## Current Free Providers

- Nominatim: city/area lookup.
- OpenStreetMap Overpass API: public business listings and contact tags.

Free public sources may not always include email, phone, ratings, reviews, or full website data.

## API Endpoints

- `GET /health`
- `GET /api/network-check`
- `POST /api/leads`
- `POST /api/scan-website`
- `POST /api/outreach`
- `POST /api/daily-assistant`
- `GET /api/crm`
- `POST /api/crm/leads`
- `POST /api/saved-searches`
- `POST /api/campaigns`
- `POST /api/campaigns/enroll`
- `POST /api/approval-queue`
- `GET /api/audit-log`
- `GET /api/export/json`
- `GET /api/daily-growth`
- `POST /api/daily-growth/settings`
- `POST /api/daily-growth/start`
- `POST /api/daily-growth/run`
- `GET /api/email/status`
- `POST /api/email/send-test`
- `POST /api/email/send-approved`
- `GET /api/sending/metrics`
- `POST /api/sending/settings`
- `POST /api/sending/send-now`
- `POST /api/sending/send-all-approved`
- `POST /api/sending/schedule`
- `POST /api/sending/run-due`
- `POST /api/sending/generate-followups`
- `POST /api/replies/record`

## Automation Levels

- Manual: humans run searches and approve every action.
- Assisted: the AI finds, researches, scores, and drafts outreach into the approval queue.
- Auto Pilot: the AI runs the full workflow automatically, but actual sending still requires a connected email/SMS/calendar adapter.

This local build does not send messages by itself. It prepares and queues them safely.

## Notes

For production scale beyond the local browser build, move records to a database, run discovery and scanning as background jobs, and add provider-specific rate limits per adapter.

## Troubleshooting `fetch failed`

If PowerShell shows `lead_search_failed` with `fetch failed`, the local server started correctly, but Node could not reach one of the free public data providers.

Open this in your browser while the server is running:

```text
http://127.0.0.1:8787/api/network-check
```

If the check fails, try:

- Make sure the computer has internet access.
- Turn off VPN/proxy/firewall rules that block OpenStreetMap or Nominatim.
- Try another network.
- Search a supported major market such as `Dallas, TX`; the app has local city fallback for common U.S. markets, but business discovery still needs public provider access.
