# CallCatch Brain One - Opportunity Intelligence Engine

Status: frozen for Brain One production integration.

Brain One is a manual business analysis engine. It researches one business record at a time and produces an evidence-backed opportunity report for CallCatch. It does not write outreach, send emails, schedule follow-ups, or trigger automation.

## Operating Rules

- Brain One only runs after a user clicks Analyze Business.
- Brain One output never triggers outbound email automatically.
- Approval is manual through Approve for CRM/Brain Two.
- Rejecting a report preserves the audit trail.
- Unknown information remains unknown.
- Every material claim must reference evidence from the input package.
- Estimates must include assumptions and confidence.
- Malformed model output is rejected.
- One repair attempt is allowed. If repair fails, the raw response and parser error are stored and the user sees a clear validation message.

## Input Contract

Brain One receives a structured context package containing:

- business identity
- website/public text
- public contact details
- public social or directory evidence
- scraper evidence
- source URLs
- analysis timestamp

No private inbox content, secret keys, or sender credentials are included.

## Output Contract

Brain One now runs in two phases.

Phase A returns compact JSON only, matching `/schemas/brain-one-output.json`.

Required sections:

- business identity
- contacts with strict owner/contact separation
- business DNA
- evidence log
- confirmed facts
- inferences
- unknowns
- digital health assessment with calculated sub-score total
- AI discoverability assessment
- future readiness
- hidden opportunities
- money left on the table
- AI opportunity radar
- why we chose you
- one-day action plan
- risks
- CONTACT or DO NOT CONTACT decision
- Brain Two handoff context

Phase B renders the long-form Business Growth Blueprint as Markdown using only the validated Phase A JSON as its factual source. Phase B output is stored separately from the Phase A JSON.

## Evidence Standard

Evidence IDs in the output must match evidence IDs from `evidenceLog`.

Confirmed facts require direct evidence. Inferences require evidence plus reasoning. Monetary estimates require clear assumptions and evidence. If evidence is weak or missing, the output must say unknown or insufficient evidence rather than guessing.

Owner names and contact names must never contain email addresses. Generic inboxes are not person names. CONTACT decisions require more than weak evidence.

## Persistence

Every run is logged with:

- business ID
- input snapshot
- model name
- raw Phase A response
- validated Phase A output
- Phase B Markdown blueprint
- execution status
- execution duration
- parser error details when validation fails
- error details
- created timestamp

## Current Scope

Included: Brain One only.

Excluded for now:

- Brain Two
- Brain Three
- Brain Four
- Brain Five
- automatic outbound actions from Brain One
