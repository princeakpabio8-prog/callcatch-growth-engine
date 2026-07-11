const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyBrainOneReviewState,
  buildBrainOneContextPackage,
  callNvidia,
  duplicateBrainOneRun,
  parseMaybeJson,
  resolvedNvidiaTimeoutMs,
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
  const evidence = context.evidenceLog.map(item => ({
    id: item.id,
    source_type: item.sourceType,
    source_url: item.sourceUrl,
    excerpt: item.excerpt
  }));
  const ev = evidence[0].id;
  const websiteEv = evidence[1]?.id || ev;
  return {
    business_identity: {
      business_name: context.businessIdentity.businessName,
      website_url: context.businessIdentity.websiteUrl,
      trade: context.businessIdentity.trade,
      location: [context.businessIdentity.city, context.businessIdentity.state].filter(Boolean).join(", ")
    },
    business_dna: {
      positioning: "Local home service provider",
      likely_customer_base: "Homeowners and property managers",
      service_model: "Inbound service requests",
      evidence_ids: [ev]
    },
    evidence,
    confirmed_facts: [{ claim: "The business has a public website or lead record.", evidence_ids: [ev] }],
    inferences: [{ inference: "Missed calls may matter for this business.", reasoning: "Service businesses rely on inbound requests.", confidence: 70, evidence_ids: [ev] }],
    unknowns: ["Owner name is unknown unless listed in public evidence."],
    digital_health: { score: 62, summary: "Basic digital presence found.", strengths: ["Public business record"], gaps: ["Booking depth unknown"], evidence_ids: [ev, websiteEv] },
    ai_discoverability: { score: 58, summary: "Some discoverability signals exist.", strengths: ["Indexed website evidence"], gaps: ["Structured AI visibility unknown"], evidence_ids: [websiteEv] },
    hidden_opportunities: [{ opportunity: "Recover missed service callers", why_it_matters: "Urgent callers often move to the next provider.", evidence_ids: [ev] }],
    risks: [{ risk: "Public information may be incomplete.", severity: "medium", evidence_ids: [ev] }],
    priority: { level: "medium", score: 67, reason: "Useful fit with incomplete evidence.", evidence_ids: [ev] },
    contact_confidence: { owner_name: "", confidence: 20, contact_paths: [context.publicContactDetails.email || context.publicContactDetails.phone || "website"], evidence_ids: [ev] },
    brain_two_handoff: { approved_for_handoff: false, summary: "Manual approval required before Brain Two.", evidence_ids: [ev], do_not_automate_outbound: true },
    ...overrides
  };
}

function compactJson(context = sampleContext(1), overrides = {}) {
  return JSON.stringify(sampleOutput(context, overrides));
}

async function runWithFirstResponse(firstResponse, context = sampleContext(1)) {
  const valid = compactJson(context);
  let calls = 0;
  const result = await runBrainOne(context, {
    model: "test-model",
    callModel: async () => {
      calls += 1;
      if (calls === 1) return firstResponse;
      if (calls === 2) return valid;
      return "# Business Growth Blueprint\n\nManual review only.";
    }
  });
  return { result, calls };
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
  let calls = 0;
  const result = await runBrainOne(context, {
    model: "test-model",
    callModel: async () => {
      calls += 1;
      if (calls === 1) return "{ bad json";
      if (calls === 2) return compactJson(context);
      return "# Business Growth Blueprint\n\nManual review only.";
    }
  });
  assert.equal(calls, 3);
  assert.equal(result.repaired, true);
  assert.equal(result.output.business_identity.business_name, context.businessIdentity.businessName);
  assert.match(result.blueprintMarkdown, /Business Growth Blueprint/);
});

test("missing evidence references reject model output", () => {
  const context = sampleContext(2);
  const output = sampleOutput(context, {
    confirmed_facts: [{ claim: "Unsupported claim", evidence_ids: ["missing-evidence"] }]
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
        text: async () => JSON.stringify({ error: { message: "upstream failed" } })
      })
    }),
    /upstream failed/
  );
});

test("NVIDIA timeout resolver reads configured environment value", () => {
  assert.equal(resolvedNvidiaTimeoutMs("180000"), 180000);
  assert.equal(resolvedNvidiaTimeoutMs(""), 180000);
});

test("NVIDIA request uses compact non-streaming production parameters", async () => {
  let requestBody = null;
  const result = await callNvidia([{ role: "user", content: "test" }], {
    apiKey: "secret-test-key",
    model: "meta/llama-3.1-8b-instruct",
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }] })
      };
    }
  });
  assert.equal(result.content, "{\"ok\":true}");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.structuredResponseModeAccepted, true);
  assert.equal(requestBody.model, "meta/llama-3.1-8b-instruct");
  assert.equal(requestBody.temperature, 0.1);
  assert.equal(requestBody.max_tokens, 3500);
  assert.equal(requestBody.stream, false);
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
});

test("JSON extractor accepts Markdown code fences", () => {
  const parsed = parseMaybeJson(`\`\`\`json\n${compactJson()}\n\`\`\``);
  assert.equal(parsed.business_identity.business_name, sampleContext(1).businessIdentity.businessName);
});

test("JSON extractor accepts text before JSON", () => {
  const parsed = parseMaybeJson(`Here is the report:\n${compactJson()}`);
  assert.equal(parsed.priority.level, "medium");
});

test("JSON extractor ignores commentary after a complete JSON object", () => {
  const parsed = parseMaybeJson(`${compactJson()}\nDone.`);
  assert.equal(parsed.brain_two_handoff.do_not_automate_outbound, true);
});

test("missing comma JSON is repaired once", async () => {
  const { result, calls } = await runWithFirstResponse(`{"business_identity":{"business_name":"Broken" "website_url":"https://x.test"}}`);
  assert.equal(calls, 3);
  assert.equal(result.repaired, true);
});

test("unescaped quotation mark JSON is repaired once", async () => {
  const { result, calls } = await runWithFirstResponse(`{"business_identity":{"business_name":"Bob's "Best" HVAC","website_url":"https://x.test"}}`);
  assert.equal(calls, 3);
  assert.equal(result.repaired, true);
});

test("trailing comma JSON is repaired once", async () => {
  const { result, calls } = await runWithFirstResponse(`{"business_identity":{"business_name":"Broken","website_url":"https://x.test",}}`);
  assert.equal(calls, 3);
  assert.equal(result.repaired, true);
});

test("truncated JSON is repaired once", async () => {
  const { result, calls } = await runWithFirstResponse(compactJson().slice(0, 600));
  assert.equal(calls, 3);
  assert.equal(result.repaired, true);
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
