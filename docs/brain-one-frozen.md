# CallCatch Brain One - Opportunity Intelligence v1.0 (Frozen)

Status: frozen production baseline.

Frozen tag: `brain-one-v1.0-frozen`

Brain Two rollback tag: `brain-two-before-v1.0`

Frozen production commit:

`a51894206f5d0d4eac3171eaba6d636869751533`

## Freeze Rule

Brain One may only be modified for a verified production bug.

Do not change Brain One prompts, schemas, scoring, evidence validation, evidence collection handoff, manual approval behavior, CRM behavior, sending behavior, or follow-up behavior while building Brain Two.

Brain Two must consume Brain One as a frozen upstream contract. It may read approved Brain One output, but it must never recalculate or overwrite Brain One scores, decisions, evidence, opportunities, money estimates, or contact decisions.

## Frozen Responsibility

Brain One analyzes a business and produces an evidence-backed Opportunity Intelligence report.

Brain One does not:

- write outreach as an operational sending artifact
- send email
- queue email
- schedule follow-ups
- trigger automation
- approve itself
- start Brain Two automatically

Brain One runs manually after evidence collection and requires manual approval before any downstream brain may use its output.

## Frozen Input Contract

Brain One receives a structured context package containing:

- business identity
- website URL
- website/public text
- public contact details
- public social or directory evidence
- scraper evidence
- source URLs
- analysis timestamp
- Brain Zero evidence package metadata when available

No API keys, SMTP secrets, inbox credentials, private email content, or sender credentials are included.

## Frozen Output Contract

Brain One uses the modular Phase A / Phase B architecture.

Phase A stores validated JSON with independent module outputs:

- Foundation
- Business DNA
- Digital Health
- AI Discoverability
- Future Readiness
- Trust
- Opportunity Radar
- Hidden Opportunities
- Money Left on the Table
- Why We Chose You
- One-Day Action Plan
- Contact Decision
- Decision Engine
- Brain Two handoff context

Each module owns its own evidence, confidence, score, diagnostics, and explanation. A weak Contactability score must not downgrade Business Foundation, Business DNA, Trust, Digital Health, AI Discoverability, Future Readiness, or Business Quality.

Phase B stores a founder-facing Business Growth Blueprint rendered from validated Phase A output only.

## Frozen Score Contract

Brain One exposes the following validated score source:

`validatedOutput.score_metadata.module_scores`

Required visible scores:

- `business_foundation`
- `business_dna`
- `trust`
- `digital_health`
- `ai_discoverability`
- `future_readiness`
- `opportunity`
- `contactability`

Business Quality is exposed at:

`validatedOutput.decision_engine.business_quality_score`

The UI must render Brain One scores from these validated fields, not from raw model-only sections.

## Frozen Evidence Standard

Every material claim must be tied to evidence IDs from the approved Brain One evidence package or clearly marked as an inference.

Confirmed facts require direct evidence.

Inferences require evidence plus reasoning.

Monetary estimates require assumptions, evidence, confidence, and a disclaimer.

If monetary estimation is unsupported, Brain One returns the safe insufficient-evidence object instead of inventing values.

Unknown information remains unknown.

## Frozen Validation and Safety Rules

Brain One rejects or safely fails dangerous output, including:

- owner names containing email addresses
- generic inboxes treated as people
- unsupported confirmed claims
- fabricated monetary estimates
- weak CONTACT decisions
- malformed core business identity
- Phase B introducing facts absent from Phase A

Brain One may normalize non-dangerous missing fields only when the raw response is preserved and normalization metadata is stored.

## Live Verification Results

Live Render application:

`https://callcatch-growth-engine.onrender.com`

Verification performed against production Brain Zero and Brain One runs for Stripe, HubSpot, Shopify, and Microsoft.

| Business | Foundation | DNA | Trust | Digital | AI Discoverability | Future Readiness | Opportunity Radar | Business Quality | Contactability | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Stripe | 100 | 100 | 69 | 95 | 95 | 88 | 47 | 91 | 0 | DO NOT CONTACT |
| HubSpot | 100 | 100 | 69 | 95 | 92 | 79 | 45 | 89 | 0 | DO NOT CONTACT |
| Shopify | 90 | 100 | 77 | 95 | 95 | 95 | 95 | 92 | 0 | DO NOT CONTACT |
| Microsoft | 100 | 100 | 69 | 95 | 95 | 95 | 95 | 92 | 0 | DO NOT CONTACT |

Result:

- all four production runs completed
- all required score values were present
- saved blueprint reports contained no `Not scored` marker for required sections
- Contactability remained independent from Business Quality

## Passing Tests

Frozen local test result:

`122/122` passing

Command:

`npm.cmd test`

Syntax check:

`node --check lead-engine\brainOneService.js`

## Rollback Instructions

Rollback Brain One to the frozen production state:

```powershell
git fetch --tags
git checkout brain-one-v1.0-frozen
```

Rollback Brain Two work while keeping Brain One frozen:

```powershell
git fetch --tags
git checkout brain-two-before-v1.0
```

To restore `main` to the frozen Brain One commit, use a normal revert or reset workflow only after confirming the production rollback plan:

```powershell
git checkout main
git revert <brain-two-commit-range>
git push origin main
```

Do not rewrite production history unless there is a confirmed deployment emergency.
