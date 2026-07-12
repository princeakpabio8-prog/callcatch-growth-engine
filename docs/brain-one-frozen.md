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

Brain One now runs in two phases. Phase A is modular so a weak or malformed section does not discard the whole analysis.

Phase A returns compact JSON only, using these module schemas:

- `/schemas/brain-one-foundation.json`
- `/schemas/brain-one-digital-intelligence.json`
- `/schemas/brain-one-opportunities.json`
- `/schemas/brain-one-strategic-interpretation.json`
- `/schemas/brain-one-contact-decision.json`
- `/schemas/brain-one-combined-output.json`

Required modules:

- Foundation: business identity, contacts with strict owner/contact separation, business DNA, evidence log, confirmed facts, inferences, and unknowns.
- Digital Intelligence: digital health assessment, AI discoverability assessment, and future readiness.
- Opportunities: hidden opportunities, money left on the table, AI opportunity radar, and risks.
- Strategic Interpretation: why we chose you, one-day action plan, and Brain Two handoff context.
- Contact Decision: CONTACT or DO NOT CONTACT decision.

If a module still fails after one repair attempt, Brain One stores a safe failed-module fallback and continues with the remaining modules. The combined report records completed modules, failed modules, module status, parser errors, validation errors, normalization metadata, and the raw model response for audit.

Phase B renders the long-form Business Growth Blueprint as Markdown using only the validated Phase A JSON as its factual source. Phase B output is stored separately from the Phase A JSON.

## Evidence Standard

Evidence IDs in the output must match evidence IDs from the module evidence log.

Confirmed facts require direct evidence. Inferences require evidence plus reasoning. Monetary estimates require clear assumptions and evidence. If evidence is weak or missing, the output must say unknown or insufficient evidence rather than guessing.

Owner names and contact names must never contain email addresses. Generic inboxes are not person names. CONTACT decisions require more than weak evidence.

## Defensive Normalization

Brain One may normalize missing non-dangerous sections before validation. Normalization never creates facts, money, contacts, or outreach intent.

Safe defaults may be inserted for:

- contacts: []
- evidence_log: []
- confirmed_facts: []
- inferences: []
- unknowns: []
- hidden_opportunities: []
- risks: []
- money_left_on_table: insufficient-evidence fallback
- ai_opportunity_radar: unknown-state fallback
- why_we_chose_you: insufficient-evidence fallback
- one_day_action_plan: insufficient-evidence fallback

When normalization happens, the run records `normalization_applied: true` and lists `normalized_fields`. The raw model response is preserved.

Dangerous errors are still rejected, including email addresses as owner names, unsupported confirmed absence claims, fabricated monetary estimates, weak CONTACT decisions, malformed business identity, and Phase B facts absent from Phase A.

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
