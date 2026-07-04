# CallCatch AI Growth Engine

Internal outbound sales platform for CallCatch. It discovers prospects, scores them, manages a CRM pipeline, generates approval-first outreach, and supports SMTP email sending.

## Features

- AI prospect discovery using free public data providers.
- CRM records with stages, notes, timeline, follow-up date, and assigned team member.
- CallCatch Fit Score, revenue opportunity estimate, website quality score, digital presence score, and response priority.
- Website scanner for public emails, phone numbers, contact forms, booking/chat signals, social links, emergency messaging, and financing language.
- Campaign approval queue.
- Smart sending engine with send-now, send-all-approved, scheduled sends, rate limits, follow-up generation, reply tracking, and meeting-intent detection.
- SMTP email adapter.
- CSV, Excel-compatible, JSON, clipboard, and PDF exports.
- Local JSON storage.

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

## Email Sending

Do not commit real SMTP passwords.

For local use, create `email-settings.env` from `.env.example` or set environment variables before starting the server.

Required SMTP variables:

```env
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
