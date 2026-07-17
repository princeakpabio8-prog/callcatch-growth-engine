# CallCatch AI Growth Engine

Internal outbound sales platform for CallCatch. It discovers prospects, scores them, manages a CRM pipeline, generates approval-first outreach, and supports SMTP email sending.

## Features

- AI prospect discovery using free public data providers.
- CRM records with stages, notes, timeline, follow-up date, and assigned team member.
- CallCatch Fit Score, revenue opportunity estimate, website quality score, digital presence score, and response priority.
- Website scanner for public emails, phone numbers, contact forms, booking/chat signals, social links, emergency messaging, and financing language.
- Optional Serper website finder to discover official business websites before email scanning.
- Campaign approval queue.
- Smart sending engine with send-now, send-all-approved, scheduled sends, rate limits, follow-up generation, reply tracking, and meeting-intent detection.
- SMTP email adapter.
- CSV, Excel-compatible, JSON, clipboard, and PDF exports.
- Production storage with Render Postgres support and local JSON fallback.

## Local Setup

Install Node.js 20 or newer.

From this folder:

```powershell
npm start
```

Or run the required start command directly:

```powershell
node callcatch-lead-server.js
```

Open:

```text
http://127.0.0.1:8787/
```

Health check:

```text
http://127.0.0.1:8787/health
```

Network check:

```text
http://127.0.0.1:8787/api/network-check
```

## Production Storage

For Render, add a Render Postgres database and set `DATABASE_URL` to the database Internal Database URL. CallCatch will automatically use Postgres when `DATABASE_URL` is present. If `DATABASE_URL` is blank, it falls back to the local JSON file.

Check storage mode at:

```text
/health
```

## Email Sending

Do not commit real email API keys or SMTP passwords.

For local use, create `email-settings.env` from `.env.example` or set environment variables before starting the server.

Recommended Render email setup:

```env
EMAIL_PROVIDER=auto
RESEND_API_KEY=
SMTP_FROM=hello@callcatch.site
SMTP_FROM_NAME=CallCatch
SMTP_REPLY_TO=hello@callcatch.site
```

With `EMAIL_PROVIDER=auto`, CallCatch uses Resend first when `RESEND_API_KEY` is present, Brevo second when `BREVO_API_KEY` is present, then SMTP as a fallback.

For Resend inbound replies, point Resend inbound routing/webhooks to:

```text
https://your-render-app.onrender.com/api/webhooks/resend/inbound
```

Replies are stored on the lead timeline, stop remaining follow-ups, and appear in the CallCatch reply inbox.

Optional Brevo setup:

```env
EMAIL_PROVIDER=brevo
BREVO_API_KEY=
SMTP_FROM=hello@callcatch.site
SMTP_FROM_NAME=CallCatch
SMTP_REPLY_TO=hello@callcatch.site
```

SMTP fallback variables:

```env
EMAIL_PROVIDER=smtp
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
SMTP_FROM_NAME=CallCatch
SMTP_REPLY_TO=
SMTP_TIMEOUT_MS=15000
```

Twilio SMS setup:

```env
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
TWILIO_MESSAGING_SERVICE_SID=
TWILIO_TIMEOUT_MS=15000
```

SMS sending uses the same approval queue as email. A text message is not sent until the task is approved and the user clicks `Send Now` or `Send All Approved`.

For a Twilio trial account, recipient phone numbers usually must be verified in Twilio before SMS can be delivered. Use E.164 phone format such as `+12145550123`.

## Follow-up Sequence Automation

CallCatch automatically manages the standard outreach sequence:

- Email #1 is sent from an approved email task.
- After 3 days with no reply, CallCatch creates `Follow-up #1`.
- After `Follow-up #1` is sent, CallCatch waits 4 more days.
- If there is still no reply, CallCatch creates `Final Follow-up`.
- Any reply stops the remaining follow-up tasks for that lead.

In `Assisted` mode, follow-ups are generated into the Approval Queue for review. In `Auto Pilot` mode, due sequence emails can be approved and sent automatically by the server background runner.

On Render, add these in the service Environment tab.

## Render Deployment

Create a new Render Web Service from this repository.

Recommended settings:

- Runtime: Node
- Build Command: leave blank or use `npm install`
- Start Command: `node callcatch-lead-server.js`
- Node version: Node 20+

Render provides `PORT` automatically. The server binds to `0.0.0.0` on Render.

### Important Production Note

This local build stores CRM data in `data/callcatch-crm.json`. Render disks are ephemeral unless you attach a persistent disk. For serious production use, move storage to a database such as Postgres.

## Environment Variables

Copy `.env.example` into your Render environment variables. Do not commit real values.

No Google Cloud or paid lead API key is required for the public-source discovery engine.

Optional lead enrichment:

```env
SERPER_API_KEY=
```

When `SERPER_API_KEY` is set, CallCatch uses Serper to find official business websites and then scans those sites for public emails.

## GitHub Push Commands

From this folder:

```powershell
git init
git add .
git commit -m "Initial CallCatch Growth Engine production setup"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_PRIVATE_REPO.git
git push -u origin main
```

For a private repo, create the repository as private on GitHub first, then replace the remote URL above.

## Safety

- Email sending requires SMTP configuration.
- Only approved email tasks are sent.
- SMS, LinkedIn, and calendar integrations are adapter-ready but not connected in this build.
- Secrets are excluded by `.gitignore`.
## Built with GPT-5.6 and Codex

CallCatch was developed during OpenAI Build Week using GPT-5.6 and Codex as collaborative engineering tools throughout the project.

GPT-5.6 was used to:
- Design the multi-brain AI architecture.
- Refine Brain Zero, Brain One and Brain Two responsibilities.
- Improve prompt engineering and deterministic reasoning.
- Review the overall system design and product decisions.

Codex was used to:
- Generate production-ready JavaScript and Node.js code.
- Build new services and API endpoints.
- Refactor modules into a modular architecture.
- Debug runtime errors and validation failures.
- Create and improve automated tests.
- Fix production bugs discovered during development.
- Improve reliability while preserving deterministic behavior.

Rather than generating a single application from one prompt, GPT-5.6 and Codex were used iteratively throughout the engineering process to design, implement, test and refine CallCatch into a working AI Prospect Intelligence platform.
