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
- One repair attempt is allowed. If repair fails, the run is stored as failed.

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

Brain One returns JSON only, matching `/schemas/brain-one-output.json`.

Required sections:

- business identity
- business DNA
- evidence log
- confirmed facts
- inferences
- unknowns
- digital health assessment
- AI discoverability assessment
- hidden opportunities
- revenue opportunity estimates with assumptions
- risks
- recommended priority
- owner/contact confidence
- Business Growth Blueprint
- Brain Two handoff context

## Evidence Standard

Evidence IDs in the output must match evidence IDs from `evidenceLog`.

Confirmed facts require direct evidence. Inferences require evidence plus reasoning. Revenue estimates require clear assumptions. If evidence is weak or missing, the output must say unknown rather than guessing.

## Persistence

Every run is logged with:

- business ID
- input snapshot
- model name
- raw response
- validated output
- execution status
- execution duration
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
