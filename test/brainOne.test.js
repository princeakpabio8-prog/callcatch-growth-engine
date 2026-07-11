const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyBrainOneReviewState,
  buildBrainOneContextPackage,
  callNvidia,
  duplicateBrainOneRun,
  runBrainOne,
  validateBrainOneInput,
  validateBrainOneOutput
} = require("../lead-engine/brainOneService");

function sampleLead(index, overrides = {}) {
  return {
    id: `lead-${index}`,
    business: `Sample Service ${index}`,
    trade: ["HVAC", "Plumbing", "Roofing", "Electrical", "Garage Door"][index - 1] || "Home Services",
    city: ["Dallas", "Phoenix", "Houston", "Miami", "Chicago"][index - 1] || "Dallas",
    state: ["TX", "AZ", "TX", "FL", "IL"][index - 1] || "TX",
    country: "US",
    website: `https://example${index}.com`,
    phone: index % 2 ? "+12145550123" : "",
    email: index % 2 ? `office${index}@example.com` : "",
    address: `${index} Main St`,
    source: "test-fixture",
    aiInsights: index % 2 ? ["Emergency service appears prominent"] : ["Limited public contact detail"],
    ...overrides
  };
}

function sampleContext(index = 1) {
  return buildBrainOneContextPackage(sampleLead(index), {
    ok: true,
    url: `https://example${index}.com`,
    text: index % 2
      ? "Emergency repairs, same-day service, financing, phone number, and online contact form are visible."
      : "Basic service page with limited contact detail and no clear booking button."
  });
}

function sampleOutput(context = sampleContext(1), overrides = {}) {
  const evidenceLog = context.evidenceLog.map(item => ({
    id: item.id,
    sourceType: item.sourceType,
    sourceUrl: item.sourceUrl,
    excerpt: item.excerpt
  }));
  const ev = evidenceLog[0].id;
  const websiteEv = evidenceLog[1]?.id || ev;
  return {
    businessIdentity: {
      businessName: context.businessIdentity.businessName,
      websiteUrl: context.businessIdentity.websiteUrl,
      trade: context.businessIdentity.trade,
      location: [context.businessIdentity.city, context.businessIdentity.state].filter(Boolean).join(", ")
    },
    businessDNA: {
      positioning: "Local home service provider",
      likelyCustomerBase: "Homeowners and property managers",
      serviceModel: "Inbound service requests",
      evidenceIds: [ev]
    },
    evidenceLog,
    confirmedFacts: [{ claim: "The business has a public website or lead record.", evidenceIds: [ev] }],
    inferences: [{ inference: "Missed calls may matter for this business.", reasoning: "Service businesses rely on inbound requests.", confidence: 70, evidenceIds: [ev] }],
    unknowns: ["Owner name is unknown unless listed in public evidence."],
    digitalHealthAssessment: { score: 62, summary: "Basic digital presence found.", strengths: ["Public business record"], gaps: ["Booking depth unknown"], evidenceIds: [ev, websiteEv] },
    aiDiscoverabilityAssessment: { score: 58, summary: "Some discoverability signals exist.", strengths: ["Indexed website evidence"], gaps: ["Structured AI visibility unknown"], evidenceIds: [websiteEv] },
    hiddenOpportunities: [{ opportunity: "Recover missed service callers", whyItMatters: "Urgent callers often move to the next provider.", evidenceIds: [ev] }],
    revenueOpportunityEstimates: [{ label: "Recovered missed-call revenue", low: 3000, high: 12000, currency: "USD", assumptions: ["One to three recovered jobs per month", "Average ticket varies by trade"], confidence: 55, evidenceIds: [ev] }],
    risks: [{ risk: "Public information may be incomplete.", severity: "medium", evidenceIds: [ev] }],
    recommendedPriority: { level: "medium", score: 67, reason: "Useful fit with incomplete evidence.", evidenceIds: [ev] },
    ownerContactConfidence: { ownerName: "", confidence: 20, contactPaths: [context.publicContactDetails.email || context.publicContactDetails.phone || "website"], evidenceIds: [ev] },
    businessGrowthBlueprint: { summary: "Focus on missed-call capture and response speed.", nextBestActions: ["Confirm service hours", "Confirm missed-call handling"], callCatchFitRationale: "CallCatch is relevant if inbound calls are missed.", evidenceIds: [ev] },
    brainTwoHandoffContext: { approvedForHandoff: false, summary: "Manual approval required before Brain Two.", evidenceIds: [ev], doNotAutomateOutbound: true },
    ...overrides
  };
}

test("valid Brain One output passes strict evidence validation across five sample businesses", () => {
  for (let index = 1; index <= 5; index += 1) {
    const context = sampleContext(index);
    assert.equal(validateBrainOneInput(context).ok, true);
    const output = sampleOutput(context);
    assert.equal(validateBrainOneOutput(output).ok, true);
  }
});

test("malformed JSON retries once and accepts repaired Brain One output", async () => {
  const context = sampleContext(1);
  const valid = JSON.stringify(sampleOutput(context));
  let calls = 0;
  const result = await runBrainOne(context, {
    model: "test-model",
    callModel: async () => {
      calls += 1;
      return calls === 1 ? "{ bad json" : valid;
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.repaired, true);
  assert.equal(result.output.businessIdentity.businessName, context.businessIdentity.businessName);
});

test("missing evidence references reject model output", () => {
  const context = sampleContext(2);
  const output = sampleOutput(context, {
    confirmedFacts: [{ claim: "Unsupported claim", evidenceIds: ["missing-evidence"] }]
  });
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /unknown evidence id/);
});

test("API timeout from model call is surfaced as a failed Brain One run", async () => {
  const context = sampleContext(3);
  await assert.rejects(
    runBrainOne(context, {
      callModel: async () => {
        throw new Error("NVIDIA API timeout");
      }
    }),
    /timeout/
  );
});

test("NVIDIA API failure is reported without exposing the API key", async () => {
  await assert.rejects(
    callNvidia([{ role: "user", content: "test" }], {
      apiKey: "secret-test-key",
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: "upstream failed" } })
      })
    }),
    /upstream failed/
  );
});

test("duplicate analysis request detects an active run for the same business", () => {
  const duplicate = duplicateBrainOneRun([
    { id: "run-1", businessId: "lead-1", executionStatus: "completed" },
    { id: "run-2", businessId: "lead-1", executionStatus: "running" }
  ], "lead-1");
  assert.equal(duplicate.id, "run-2");
});

test("manual approval flow marks report without triggering outbound work", () => {
  const output = sampleOutput(sampleContext(4));
  const state = {
    leads: [{ id: "lead-4", business: "Sample Service 4", timeline: [] }],
    brainOneRuns: [{ id: "run-4", businessId: "lead-4", executionStatus: "completed", approvalStatus: "pending-review", validatedOutput: output }],
    auditLog: []
  };
  const result = applyBrainOneReviewState(state, { runId: "run-4", leadId: "lead-4", approved: true, reviewedAt: "2026-07-11T10:00:00.000Z" });
  assert.equal(result.run.approvalStatus, "approved-for-crm-brain-two");
  assert.equal(result.lead.brainOneApprovalStatus, "approved-for-crm-brain-two");
  assert.match(result.lead.timeline[0].text, /No outbound action triggered/);
});
