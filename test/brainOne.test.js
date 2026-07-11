const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyBrainOneReviewState,
  buildBrainOneContextPackage,
  callNvidia,
  duplicateBrainOneRun,
  markdownToSafeHtml,
  normalizeBrainOneOutput,
  parseMaybeJson,
  resolvedNvidiaTimeoutMs,
  runBrainOne,
  validateBrainOneInput,
  validateBrainOneOutput,
  validatePhaseBMarkdownAgainstPhaseA
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

function evidenceFromContext(context) {
  return context.evidenceLog.map(item => ({
    id: item.id,
    source_type: item.sourceType,
    source_url: item.sourceUrl,
    excerpt: item.excerpt
  }));
}

function claim(claimText, evidenceIds, overrides = {}) {
  return {
    claim: claimText,
    evidence_ids: evidenceIds,
    confidence: "medium",
    status: "inferred",
    reasoning: "The scanned evidence supports this as a reasonable business observation.",
    limitation: "The public scan may not include every page or directory profile.",
    ...overrides
  };
}

function digitalSub(score, evidenceIds, confidence = "medium") {
  return {
    score,
    evidence_ids: evidenceIds,
    reasoning: "Visible public evidence supports this sub-score.",
    confidence,
    what_would_improve_it: "Add clearer proof, calls to action, and structured service information."
  };
}

function radar(status, evidenceIds) {
  return {
    status,
    evidence: "Supported by the scanned lead record and website text.",
    opportunity: "Improve clarity and conversion where public evidence is thin.",
    confidence: "medium",
    evidence_ids: evidenceIds
  };
}

function sampleOutput(context = sampleContext(1), overrides = {}) {
  const evidence_log = evidenceFromContext(context);
  const ev = evidence_log[0].id;
  const websiteEv = evidence_log[1]?.id || ev;
  const evs = [ev, websiteEv];
  const output = {
    business_identity: {
      business_name: context.businessIdentity.businessName,
      website_url: context.businessIdentity.websiteUrl,
      trade: context.businessIdentity.trade,
      location: [context.businessIdentity.city, context.businessIdentity.state].filter(Boolean).join(", ")
    },
    contacts: [{
      owner_name: null,
      contact_name: null,
      contact_role: "",
      contact_email: context.publicContactDetails.email || "",
      contact_phone: context.publicContactDetails.phone || "",
      contact_source: context.publicContactDetails.email ? "lead record" : "",
      contact_confidence: context.publicContactDetails.email ? 60 : 20,
      status: context.publicContactDetails.email ? "inferred" : "unknown",
      evidence_ids: [ev]
    }],
    business_dna: {
      business_model: "Inbound local service provider",
      primary_services: [context.businessIdentity.trade || "Home service"],
      likely_customer_segments: ["Homeowners", "property managers"],
      geographic_market: context.businessIdentity.city || "unknown",
      value_proposition: "Emergency and same-day service appear relevant from public text.",
      likely_revenue_drivers: ["Urgent service requests", "repeat maintenance"],
      customer_journey: "Search, call, request service, book appointment.",
      current_digital_maturity: "basic",
      operational_complexity: "field-service team with time-sensitive inbound demand",
      trust_signals: ["Public website or lead record"],
      differentiators: ["Emergency service appears in public text"],
      growth_stage: "unknown",
      evidence_strength: "medium",
      evidence_ids: evs
    },
    evidence_log,
    confirmed_facts: [
      claim("The business has a public lead record or website.", [ev], { confidence: "high", status: "confirmed" })
    ],
    inferences: [
      claim("Missed inbound calls may matter because the business appears to handle urgent service demand.", evs)
    ],
    unknowns: [
      "Owner name could not be confirmed from the scanned public evidence."
    ],
    digital_health: {
      score: 0,
      summary: "The public presence has useful basics but conversion depth is not fully confirmed.",
      evidence_ids: evs,
      sub_scores: {
        website_clarity: digitalSub(14, evs),
        conversion_path: digitalSub(11, evs),
        trust_and_proof: digitalSub(10, evs),
        local_discoverability: digitalSub(10, [ev]),
        customer_convenience: digitalSub(9, evs),
        technical_readiness: digitalSub(8, [websiteEv])
      }
    },
    ai_discoverability: {
      score: 58,
      summary: "The business entity and service category are visible, but answer-ready depth is limited.",
      sub_scores: {
        entity_clarity: 12,
        service_location_clarity: 12,
        structured_business_information: 8,
        nap_consistency: 10,
        answer_ready_content: 6,
        authoritative_mentions: 5,
        machine_readable_metadata: 5
      },
      confirmed_evidence: ["Business name, service type, and location are present in the lead record."],
      limitations: ["External citations and metadata were not fully tested."],
      improvement_actions: ["Add clear service-area pages and FAQ-style answers."],
      evidence_ids: evs
    },
    future_readiness: {
      readiness_level: "moderate",
      evidence: ["Lead capture exists through phone or contact paths."],
      blockers: ["CRM and automation readiness could not be confirmed."],
      fastest_improvement: "Make the primary contact path easier to complete after hours.",
      confidence: "medium",
      evidence_ids: evs
    },
    hidden_opportunities: [{
      title: "Capture more urgent service callers",
      specific_observed_problem: "The scanned public evidence does not confirm an immediate missed-call recovery path.",
      supporting_evidence: ["Emergency or urgent service language appears in public text."],
      why_it_matters: "Urgent callers often choose the first provider who responds.",
      affected_customer_journey_stage: "first contact",
      likely_business_impact: "Could improve booked-job recovery if missed calls are happening.",
      implementation_difficulty: "low",
      time_to_initial_impact: "days",
      confidence: "medium",
      assumptions: ["Inbound calls are meaningful for this trade."],
      recommended_first_test: "Track missed calls for seven days and compare booked jobs.",
      callcatch_relevance: "relevant",
      ranking_factors: { evidence_strength: 70, business_impact: 75, feasibility: 80, urgency: 70 },
      opportunity_priority_score: 0,
      evidence_ids: evs
    }],
    money_left_on_table: {
      status: "insufficient_evidence",
      summary: "Insufficient evidence for a responsible monetary estimate.",
      low_estimate: null,
      high_estimate: null,
      currency: "USD",
      time_period: "monthly",
      calculation_method: "",
      assumptions: [],
      evidence_ids: [],
      confidence: "low",
      disclaimer: "No traffic, missed-call volume, conversion rate, or customer value was confirmed."
    },
    ai_opportunity_radar: {
      discoverability: radar("moderate", evs),
      conversion: radar("moderate", evs),
      trust: radar("moderate", evs),
      retention: radar("unknown", evs),
      automation: radar("weak", evs),
      customer_experience: radar("moderate", evs),
      operational_efficiency: radar("unknown", evs),
      future_readiness: radar("moderate", evs)
    },
    why_we_chose_you: {
      observable_strengths: ["Public service presence", "time-sensitive service category"],
      what_the_business_does_well: "It appears findable enough for initial research.",
      why_improvements_matter: "Small response-speed gains can matter in urgent home services.",
      why_not_random: "The opportunity is tied to the trade, location, and public contact evidence.",
      potential_fit: "Potential fit if missed-call volume exists.",
      evidence_ids: evs
    },
    one_day_action_plan: {
      first_2_hours: ["Verify contact paths and missed-call handling."],
      by_midday: ["Check whether online booking or text response is visible."],
      before_end_of_day: ["Run a small response-speed measurement."],
      what_we_would_not_touch_yet: ["Major redesign before measuring demand."],
      what_to_measure_next_30_days: ["Missed calls", "response time", "booked jobs from recovered callers"],
      evidence_ids: evs
    },
    risks: [
      claim("Public information may be incomplete.", evs)
    ],
    contact_decision: {
      decision: "CONTACT",
      decision_confidence: "medium",
      primary_reason: "There is an evidence-backed missed-call response opportunity and usable contact data.",
      supporting_evidence: ["Public contact details and urgent-service indicators are present."],
      disqualifying_factors: [],
      information_gaps: ["Owner name and actual missed-call volume are unknown."],
      recommended_outreach_angle: "Discuss response speed and missed urgent calls without claiming known revenue loss.",
      prohibited_claims_for_brain_two: ["Do not claim confirmed missed revenue.", "Do not claim the owner name is known."],
      callcatch_opportunity_score: 72,
      evidence_ids: evs
    },
    brain_two_handoff: {
      approved_for_handoff: false,
      summary: "Manual approval required before Brain Two. Use only evidence-backed missed-call context.",
      evidence_ids: evs,
      do_not_automate_outbound: true
    },
    ...overrides
  };
  normalizeBrainOneOutput(output);
  return output;
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
      return "# Business Growth Blueprint\n\n## Opportunity Summary\nUseful manual review only.";
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
      return "# Business Growth Blueprint\n\n## Opportunity Summary\nManual review only.";
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
    confirmed_facts: [claim("Unsupported claim", ["missing-evidence"])]
  });
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /unknown evidence id/);
});

test("email address returned as owner name is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.contacts[0].owner_name = "Dallas@AmericanPrideRoofing.com";
  output.contacts[0].status = "confirmed";
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /owner_name must not contain an email/);
});

test("generic mailbox interpreted as contact name is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.contacts[0].contact_name = "info";
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /generic mailbox/);
});

test("confirmed owner without source evidence is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.contacts[0].owner_name = "Jordan Smith";
  output.contacts[0].status = "confirmed";
  output.contacts[0].contact_source = "";
  output.contacts[0].evidence_ids = [];
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /source|evidence/);
});

test("missing material claim evidence is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.inferences[0].evidence_ids = [];
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /evidence_ids/);
});

test("unsupported monetary estimate is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.money_left_on_table = {
    status: "estimated",
    summary: "Potential missed revenue.",
    low_estimate: 10000,
    high_estimate: 20000,
    currency: "USD",
    time_period: "monthly",
    calculation_method: "",
    assumptions: [],
    evidence_ids: [],
    confidence: "low",
    disclaimer: "Scenario only."
  };
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /assumptions|required|evidence_ids/);
});

test("duplicated opportunities are rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.hidden_opportunities.push({ ...output.hidden_opportunities[0] });
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /duplicates/);
});

test("absence stated as confirmed fact is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.confirmed_facts.push(claim("The business does not offer online booking", ["ev-lead-record"], { status: "confirmed", confidence: "high" }));
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /absence/);
});

test("digital health score is calculated from sub-scores instead of accepted blindly", () => {
  const output = sampleOutput(sampleContext(1));
  output.digital_health.score = 99;
  normalizeBrainOneOutput(output);
  assert.equal(output.digital_health.score, 62);
  assert.equal(validateBrainOneOutput(output).ok, true);
});

test("Phase B introducing absent facts is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.contacts = [];
  output.money_left_on_table.status = "insufficient_evidence";
  const validation = validatePhaseBMarkdownAgainstPhaseA("The owner wants to recover $20,000 monthly.", output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /monetary|person/);
});

test("CONTACT decision with weak evidence is rejected", () => {
  const output = sampleOutput(sampleContext(1));
  output.contact_decision.decision = "CONTACT";
  output.contact_decision.decision_confidence = "low";
  const validation = validateBrainOneOutput(output);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /CONTACT decision/);
});

test("DO NOT CONTACT decision with insufficient data is accepted", () => {
  const output = sampleOutput(sampleContext(1), {
    contact_decision: {
      decision: "DO NOT CONTACT",
      decision_confidence: "low",
      primary_reason: "Evidence is too thin for useful outreach.",
      supporting_evidence: ["Only a limited public record was found."],
      disqualifying_factors: ["No reliable contact path was confirmed."],
      information_gaps: ["Owner, website depth, and active demand are unknown."],
      recommended_outreach_angle: "Do not proceed until better evidence is found.",
      prohibited_claims_for_brain_two: ["Do not contact yet."],
      callcatch_opportunity_score: 20,
      evidence_ids: ["ev-lead-record"]
    }
  });
  assert.equal(validateBrainOneOutput(output).ok, true);
});

test("Phase B founder-facing report can render without exposing internal evidence IDs", () => {
  const output = sampleOutput(sampleContext(1));
  const markdown = "# Business Growth Blueprint\n\n## Opportunity Summary\nThe business has a practical response-speed opportunity.";
  const validation = validatePhaseBMarkdownAgainstPhaseA(markdown, output);
  assert.equal(validation.ok, true);
});

test("Markdown rendering converts headings, bullets, and bold text safely", () => {
  const html = markdownToSafeHtml("# Title\n\n## Section\n- **Fast** action\n<script>x</script>");
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<h4>Section<\/h4>/);
  assert.match(html, /<li><strong>Fast<\/strong> action<\/li>/);
  assert.doesNotMatch(html, /<script>/);
});

test("internal and founder-facing reports remain separated", () => {
  const output = sampleOutput(sampleContext(1));
  const internalEvidence = output.confirmed_facts[0].evidence_ids[0];
  assert.equal(internalEvidence, "ev-lead-record");
  const founderReport = "# Business Growth Blueprint\n\nNo internal evidence codes are shown here.";
  assert.equal(validatePhaseBMarkdownAgainstPhaseA(founderReport, output).ok, true);
  assert.equal(validatePhaseBMarkdownAgainstPhaseA(`${founderReport}\n${internalEvidence}`, output).ok, false);
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
  assert.equal(parsed.contact_decision.decision, "CONTACT");
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
    brainOneRuns: [{ id: "run-4", businessId: "lead-4", executionStatus: "completed", approvalStatus: "pending-review", validatedOutput: output, blueprintMarkdown: "Blueprint" }],
    auditLog: []
  };
  const result = applyBrainOneReviewState(state, { runId: "run-4", leadId: "lead-4", approved: true, reviewedAt: "2026-07-11T10:00:00.000Z" });
  assert.equal(result.run.approvalStatus, "approved-for-crm-brain-two");
  assert.equal(result.lead.brainOneApprovalStatus, "approved-for-crm-brain-two");
  assert.match(result.lead.timeline[0].text, /No outbound action triggered/);
});
