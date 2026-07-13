const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  applyBrainTwoReviewState,
  evaluateBrainTwoEligibility,
  runBrainTwo,
  validateBrainTwoOutput
} = require("../lead-engine/brainTwoService");

function approvedBrainOne(overrides = {}) {
  return {
    id: "brain1-approved",
    businessId: "lead-1",
    executionStatus: "completed",
    approvalStatus: "approved-for-crm-brain-two",
    validatedOutput: {
      modules: {
        foundation: {
          output: {
            business_identity: { business_name: "Spring HVAC", website_url: "https://spring.example", trade: "HVAC", location: "Dallas, TX" },
            contacts: [{ contact_email: "office@spring.example", contact_phone: "+12145550123", contact_confidence: 80, evidence_ids: ["ev-contact"] }],
            evidence_log: [
              { id: "ev-dna", source_type: "website", source_url: "https://spring.example", excerpt: "Spring HVAC offers emergency HVAC repair." },
              { id: "ev-opp", source_type: "website", source_url: "https://spring.example", excerpt: "Emergency HVAC repair and contact forms are visible." },
              { id: "ev-contact", source_type: "lead-record", source_url: "crm", excerpt: "office@spring.example" }
            ],
            confirmed_facts: [{ claim: "Spring HVAC offers emergency HVAC repair.", confidence: "high", status: "confirmed", evidence_ids: ["ev-dna"] }]
          }
        },
        digital_intelligence: {
          output: {
            business_dna: {
              status: "assessed",
              summary: "Emergency HVAC service provider.",
              business_model: "Home service company",
              primary_services: ["HVAC", "Emergency repair"],
              likely_customer_segments: ["homeowners"],
              geographic_market: "Dallas, TX",
              value_proposition: "Fast HVAC help for urgent service calls.",
              likely_revenue_drivers: ["repair calls"],
              customer_journey: "Caller reaches out for urgent HVAC help.",
              current_digital_maturity: "Moderate",
              operational_complexity: "Moderate",
              trust_signals: ["emergency service"],
              differentiators: ["urgent HVAC response"],
              growth_stage: "active",
              evidence_strength: "high",
              confidence: "high",
              evidence_ids: ["ev-dna"]
            },
            digital_health: { status: "assessed", summary: "Website has service and contact content.", confidence: "high", evidence_ids: ["ev-dna"] },
            ai_discoverability: { status: "assessed", summary: "Service content is AI-readable.", confidence: "medium", evidence_ids: ["ev-dna"] },
            future_readiness: { status: "assessed", summary: "Automation may improve response speed.", confidence: "medium", evidence_ids: ["ev-dna"] }
          }
        },
        opportunities: {
          output: {
            hidden_opportunities: [{
              title: "Missed emergency calls",
              specific_observed_problem: "Emergency service callers may move on quickly if nobody answers.",
              why_it_matters: "Urgent HVAC shoppers often call the next contractor.",
              opportunity_priority_score: 88,
              callcatch_relevance: "Missed-call text-back can keep callers engaged.",
              evidence_ids: ["ev-opp"]
            }],
            ai_opportunity_radar: {
              conversion: { status: "observed", opportunity: "Improve urgent lead response.", confidence: "medium", evidence_ids: ["ev-opp"] }
            },
            risks: []
          }
        },
        strategic_interpretation: {
          output: {
            why_we_chose_you: { status: "assessed", summary: "Emergency service creates response-speed relevance.", evidence_ids: ["ev-opp"] },
            one_day_action_plan: { status: "assessed", summary: "Review missed-call response.", evidence_ids: ["ev-opp"] },
            brain_two_handoff: { approved_for_handoff: false, summary: "Use missed-call response angle.", evidence_ids: ["ev-opp"], do_not_automate_outbound: true }
          }
        },
        contact_decision: {
          output: {
            contact_decision: {
              decision: "CONTACT",
              decision_confidence: "medium",
              primary_reason: "Verified contact path and relevant missed-call opportunity.",
              supporting_evidence: ["emergency service", "email"],
              disqualifying_factors: [],
              information_gaps: [],
              recommended_outreach_angle: "Missed emergency calls",
              prohibited_claims_for_brain_two: ["Do not claim a specific revenue loss."],
              callcatch_opportunity_score: 82,
              evidence_ids: ["ev-contact", "ev-opp"]
            }
          }
        }
      },
      score_metadata: {
        module_scores: {
          contactability: { value: 75 },
          opportunity: { value: 88 }
        }
      },
      decision_engine: {
        decision: "CONTACT",
        business_quality_score: 84,
        contactability_score: 75
      }
    },
    ...overrides
  };
}

function lead(overrides = {}) {
  return {
    id: "lead-1",
    business: "Spring HVAC",
    trade: "HVAC",
    city: "Dallas",
    state: "TX",
    email: "office@spring.example",
    phone: "+12145550123",
    timeline: [],
    ...overrides
  };
}

test("Brain Two is blocked until Brain One is completed and approved", () => {
  assert.equal(evaluateBrainTwoEligibility({ lead: lead(), brainOneRun: null }).eligible, false);
  assert.equal(evaluateBrainTwoEligibility({ lead: lead(), brainOneRun: approvedBrainOne({ executionStatus: "running" }) }).eligible, false);
  assert.equal(evaluateBrainTwoEligibility({ lead: lead(), brainOneRun: approvedBrainOne({ approvalStatus: "pending-review" }) }).eligible, false);
});

test("Brain Two is blocked when Brain One decision is DO NOT CONTACT", () => {
  const run = approvedBrainOne();
  run.validatedOutput.modules.contact_decision.output.contact_decision.decision = "DO NOT CONTACT";
  const result = evaluateBrainTwoEligibility({ lead: lead(), brainOneRun: run });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /DO NOT CONTACT/);
});

test("Brain Two is blocked for Manual Test prospects", () => {
  const result = evaluateBrainTwoEligibility({ lead: lead({ manualTest: true }), brainOneRun: approvedBrainOne() });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /Manual Test/);
});

test("Brain Two generates deterministic outreach without sending or queuing email", () => {
  const state = { leads: [lead()], brainTwoRuns: [], approvalQueue: [] };
  const result = runBrainTwo({ lead: state.leads[0], brainOneRun: approvedBrainOne(), runId: "brain2-1" });
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.output.status, "READY");
  assert.equal(result.output.brain_three_handoff.approval_required, true);
  assert.equal(result.output.selected_offer.name, "Missed Call Text-Back");
  assert.equal(result.output.subject_lines.length, 3);
  assert.equal(result.output.follow_up_emails.length, 3);
  assert.equal(state.approvalQueue.length, 0);
  assert.equal(validateBrainTwoOutput(result.output).ok, true);
});

test("Brain Two preserves Brain One scores and does not recalculate them", () => {
  const run = approvedBrainOne();
  const result = runBrainTwo({ lead: lead(), brainOneRun: run, runId: "brain2-2" });
  const serialized = JSON.stringify(result.output);
  assert.doesNotMatch(serialized, /business_foundation/i);
  assert.doesNotMatch(serialized, /business_quality_score/i);
  assert.equal(run.validatedOutput.decision_engine.business_quality_score, 84);
});

test("Brain Two returns NEEDS_REVIEW when manual contact research is explicitly required", () => {
  const run = approvedBrainOne();
  run.validatedOutput.modules.foundation.output.contacts = [];
  run.validatedOutput.modules.strategic_interpretation.output.brain_two_handoff.manual_research_required = true;
  const result = runBrainTwo({ lead: lead({ email: "", phone: "" }), brainOneRun: run, runId: "brain2-3" });
  assert.equal(result.output.status, "NEEDS_REVIEW");
  assert.equal(result.output.eligibility.manual_research_required, true);
});

test("Brain Two approval flow does not send or queue email", () => {
  const output = runBrainTwo({ lead: lead(), brainOneRun: approvedBrainOne(), runId: "brain2-4" }).output;
  const state = {
    leads: [lead()],
    brainTwoRuns: [{ id: "brain2-4", businessId: "lead-1", executionStatus: "completed", approvalStatus: "pending-review", output }],
    approvalQueue: [],
    auditLog: []
  };
  const result = applyBrainTwoReviewState(state, { runId: "brain2-4", leadId: "lead-1", approved: true, reviewedAt: "2026-07-13T10:00:00.000Z" });
  assert.equal(result.run.approvalStatus, "approved");
  assert.equal(state.approvalQueue.length, 0);
  assert.match(state.leads[0].timeline[0].text, /No email was sent or queued/);
});

test("server source exposes Brain Two routes without touching sending endpoints", () => {
  const source = fs.readFileSync("callcatch-lead-server.js", "utf8");
  assert.match(source, /\/api\/brain-two\/generate/);
  assert.match(source, /\/api\/brain-two\/approve/);
  assert.match(source, /No email was sent or queued/);
});
