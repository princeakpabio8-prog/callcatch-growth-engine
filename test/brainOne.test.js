const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  applyBrainOneReviewState,
  buildBrainOneContextPackage,
  callNvidia,
  duplicateBrainOneRun,
  flattenCombinedOutput,
  markdownToSafeHtml,
  normalizeBrainOneOutput,
  parseMaybeJson,
  resolvedNvidiaTimeoutMs,
  runBrainOne,
  validateBrainOneInput,
  validateBrainOneOutput,
  validateModuleOutput,
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

function enterpriseEvidenceContext(name, website, trade = "Technology Platform") {
  const capturedAt = new Date().toISOString();
  const ev = (id, provider, category, field, value, excerpt) => ({
    id,
    sourceType: provider,
    sourceProvider: provider,
    sourceCategory: category,
    category,
    field,
    value,
    sourceUrl: website,
    excerpt,
    capturedAt
  });
  const evidenceLog = [
    ev("ev-enterprise-identity-001", "business_identity_evidence", "identity", "business_name", name, `${name} official business identity and platform website.`),
    ev("ev-enterprise-website-001", "website_crawl", "website_page", "page_text", { title: `${name} platform`, url: website }, `${name} public site includes product pages, platform positioning, customer resources, guides, and navigation.`),
    ev("ev-enterprise-technical-001", "technical_website_evidence", "technical", "technical_snapshot", { https: true, final_url: website, robots_accessible: true, status: 200 }, "HTTPS, robots access, metadata, and successful crawl were observed."),
    ev("ev-enterprise-features-001", "website_feature_detection", "feature", "website_feature_snapshot", { navigation: true, responsive: true, contact_form: true, structured_content: true }, "Responsive navigation, contact forms, structured content, and conversion paths are visible."),
    ev("ev-enterprise-content-001", "content_discoverability_evidence", "content", "content_snapshot", { headings_present: true, faq_signals: true, schema_signals: true, service_descriptions_present: true }, "Semantic headings, FAQ-style explanations, structured metadata, and service descriptions are present."),
    ev("ev-enterprise-docs-001", "content_discoverability_evidence", "content", "developer_documentation", ["API documentation", "developer docs", "integrations", "guides"], `${name} has API documentation, developer documentation, integrations, and public guides.`),
    ev("ev-enterprise-future-001", "content_discoverability_evidence", "content", "innovation_signals", ["AI", "automation", "cloud platform", "developer ecosystem", "roadmap"], `${name} references AI, automation, cloud platform capabilities, developer ecosystem, and innovation signals.`),
    ev("ev-enterprise-trust-001", "public_trust_evidence", "trust", "trust_snapshot", ["enterprise customers", "partners", "case studies", "security"], `${name} shows enterprise trust, partners, customer proof, case studies, and security signals.`)
  ];
  return {
    businessIdentity: {
      businessId: `enterprise-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      businessName: name,
      trade,
      city: "",
      state: "",
      country: "US",
      websiteUrl: website,
      source: "test-brain-zero-fixture"
    },
    websitePublicText: evidenceLog.map(item => item.excerpt).join("\n"),
    publicContactDetails: { phone: "", email: "", address: "", owner: "" },
    publicSocialOrDirectoryEvidence: evidenceLog.filter(item => ["identity", "trust"].includes(item.category)),
    scraperEvidence: evidenceLog,
    sourceUrls: [website],
    analysisTimestamp: capturedAt,
    evidenceLog,
    brainZero: {
      runId: `brain0-${name.toLowerCase()}`,
      status: "completed",
      evidenceQuality: "strong",
      brainOneReady: true,
      missingCriticalCategories: [],
      evidenceCoverage: {
        coverage_score: 100,
        evidence_counts_by_category: { identity: 1, website_page: 1, technical: 1, feature: 1, content: 3, trust: 1 },
        evidence_counts_by_confidence: { medium: 8 },
        evidence_with_valid_id: evidenceLog.length
      }
    }
  };
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
      low_estimate: null,
      high_estimate: null,
      currency: null,
      time_period: null,
      calculation_method: null,
      assumptions: [],
      evidence_ids: [],
      confidence: "low",
      disclaimer: "Insufficient evidence for a responsible monetary estimate."
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

function moduleOutput(context = sampleContext(1), moduleKey, overrides = {}) {
  const full = sampleOutput(context);
  const modules = {
    foundation: {
      business_identity: {
        name: full.business_identity.business_name,
        website: full.business_identity.website_url,
        industry: full.business_identity.trade,
        location: full.business_identity.location,
        summary: "Public business foundation is available."
      },
      contacts: full.contacts,
      evidence_log: full.evidence_log,
      confirmed_facts: full.confirmed_facts,
      inferences: full.inferences,
      unknowns: full.unknowns
    },
    digital_intelligence: {
      business_dna: { status: "assessed", summary: "Inbound local service provider.", evidence_ids: ["ev-lead-record"], confidence: "medium" },
      digital_health: { status: "insufficient_evidence", summary: "Insufficient public evidence was available for a reliable assessment.", evidence_ids: [], confidence: "low", sub_scores: null, total_score: null },
      ai_discoverability: { status: "assessed", summary: "Basic entity clarity exists.", evidence_ids: ["ev-lead-record"], confidence: "medium" },
      future_readiness: { status: "assessed", summary: "Some response-readiness opportunity exists.", evidence_ids: ["ev-lead-record"], confidence: "medium" }
    },
    opportunities: {
      hidden_opportunities: full.hidden_opportunities,
      money_left_on_table: full.money_left_on_table,
      ai_opportunity_radar: { discoverability: full.ai_opportunity_radar.discoverability },
      risks: full.risks
    },
    strategic_interpretation: {
      why_we_chose_you: { status: "complete", summary: "The business has relevant public service signals.", evidence_ids: ["ev-lead-record"] },
      one_day_action_plan: { status: "complete", summary: "Start with response-path verification.", evidence_ids: ["ev-lead-record"] }
    },
    contact_decision: {
      contact_decision: full.contact_decision,
      brain_two_handoff: full.brain_two_handoff
    }
  };
  return { ...modules[moduleKey], ...overrides };
}

function moduleJson(context, moduleKey, overrides = {}) {
  return JSON.stringify(moduleOutput(context, moduleKey, overrides));
}

async function runWithFirstResponse(firstResponse, context = sampleContext(1)) {
  const order = ["foundation", "digital_intelligence", "opportunities", "strategic_interpretation", "contact_decision"];
  let calls = 0;
  const result = await runBrainOne(context, {
    model: "test-model",
    callModel: async () => {
      calls += 1;
      if (calls === 1) return firstResponse;
      if (calls === 2) return moduleJson(context, "foundation");
      if (calls <= 6) return moduleJson(context, order[calls - 2]);
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
  const order = ["foundation", "digital_intelligence", "opportunities", "strategic_interpretation", "contact_decision"];
  let calls = 0;
  const result = await runBrainOne(context, {
    model: "test-model",
    callModel: async () => {
      calls += 1;
      if (calls === 1) return "{ bad json";
      if (calls === 2) return moduleJson(context, "foundation");
      if (calls <= 6) return moduleJson(context, order[calls - 2]);
      return "# Business Growth Blueprint\n\n## Opportunity Summary\nManual review only.";
    }
  });
  assert.equal(calls, 7);
  assert.equal(result.repaired, true);
  assert.equal(result.output.modules.foundation.output.business_identity.name, context.businessIdentity.businessName);
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

test("money_left_on_table omitted entirely is normalized to safe fallback", () => {
  const output = sampleOutput(sampleContext(1));
  delete output.money_left_on_table;
  const meta = { normalization_applied: false, normalized_fields: [] };
  const validation = validateBrainOneOutput(output, { normalizationMeta: meta });
  assert.equal(validation.ok, true);
  assert.equal(output.money_left_on_table.status, "insufficient_evidence");
  assert.equal(output.money_left_on_table.low_estimate, null);
  assert.equal(meta.normalization_applied, true);
  assert.deepEqual(meta.normalized_fields, ["money_left_on_table"]);
});

test("money_left_on_table returned as null is normalized to safe fallback", () => {
  const output = sampleOutput(sampleContext(1));
  output.money_left_on_table = null;
  const meta = { normalization_applied: false, normalized_fields: [] };
  const validation = validateBrainOneOutput(output, { normalizationMeta: meta });
  assert.equal(validation.ok, true);
  assert.equal(output.money_left_on_table.disclaimer, "Insufficient evidence for a responsible monetary estimate.");
  assert.equal(meta.normalized_fields.includes("money_left_on_table"), true);
});

test("safe fallback money_left_on_table object is accepted", () => {
  const output = sampleOutput(sampleContext(1));
  output.money_left_on_table = {
    status: "insufficient_evidence",
    low_estimate: null,
    high_estimate: null,
    currency: null,
    time_period: null,
    calculation_method: null,
    assumptions: [],
    evidence_ids: [],
    confidence: "low",
    disclaimer: "Insufficient evidence for a responsible monetary estimate."
  };
  assert.equal(validateBrainOneOutput(output).ok, true);
});

test("valid estimated money_left_on_table object is accepted", () => {
  const output = sampleOutput(sampleContext(1));
  output.money_left_on_table = {
    status: "estimated",
    low_estimate: 3000,
    high_estimate: 9000,
    currency: "USD",
    time_period: "monthly",
    calculation_method: "scenario: recovered calls x assumed close rate x assumed ticket value",
    assumptions: ["One to three recovered calls", "Scenario values are not confirmed revenue"],
    evidence_ids: ["ev-lead-record"],
    confidence: "low",
    disclaimer: "Scenario estimate only, not confirmed revenue loss."
  };
  assert.equal(validateBrainOneOutput(output).ok, true);
});

test("missing contacts normalize to empty array", () => {
  const output = sampleOutput(sampleContext(1));
  delete output.contacts;
  const meta = { normalization_applied: false, normalized_fields: [] };
  const validation = validateBrainOneOutput(output, { normalizationMeta: meta });
  assert.equal(validation.ok, true);
  assert.deepEqual(output.contacts, []);
  assert.equal(meta.normalized_fields.includes("contacts"), true);
});

test("missing hidden opportunities normalize to empty array", () => {
  const output = sampleOutput(sampleContext(1));
  delete output.hidden_opportunities;
  const meta = { normalization_applied: false, normalized_fields: [] };
  const validation = validateBrainOneOutput(output, { normalizationMeta: meta });
  assert.equal(validation.ok, true);
  assert.deepEqual(output.hidden_opportunities, []);
  assert.equal(meta.normalized_fields.includes("hidden_opportunities"), true);
});

test("normalization metadata and raw response are preserved during run", async () => {
  const context = sampleContext(1);
  const raw = moduleJson(context, "opportunities", { money_left_on_table: null });
  const order = ["foundation", "digital_intelligence", "opportunities", "strategic_interpretation", "contact_decision"];
  let calls = 0;
  const result = await runBrainOne(context, {
    model: "test-model",
    callModel: async () => {
      calls += 1;
      if (calls <= 5) return calls === 3 ? raw : moduleJson(context, order[calls - 1]);
      return "# Business Growth Blueprint\n\n## Money Left on the Table\nInsufficient public evidence was available to produce a responsible monetary estimate.";
    }
  });
  assert.match(result.rawResponse, /opportunities/);
  assert.equal(result.normalization_applied, true);
  assert.equal(result.normalized_fields.includes("opportunities.money_left_on_table"), true);
  assert.equal(result.phaseAOutput.modules.opportunities.output.money_left_on_table.status, "insufficient_evidence");
});

test("founder-facing Blueprint displays insufficient-evidence money statement", () => {
  const html = markdownToSafeHtml("## Money Left on the Table\nInsufficient public evidence was available to produce a responsible monetary estimate.");
  assert.match(html, /Insufficient public evidence was available to produce a responsible monetary estimate/);
  assert.doesNotMatch(html, /\$0|£0|zero loss/i);
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

test("one module missing nested fields becomes partial without discarding successful modules", async () => {
  const context = sampleContext(1);
  const order = ["foundation", "digital_intelligence", "opportunities", "strategic_interpretation", "contact_decision"];
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      if (calls === 2) return JSON.stringify({ business_dna: {}, digital_health: { status: "assessed" } });
      if (calls <= 6) return moduleJson(context, order[calls - 1]);
      return "# Business Growth Blueprint\n\nPartial but useful.";
    }
  });
  assert.equal(result.output.overall_status, "partial");
  assert.equal(result.output.modules.foundation.status, "completed");
  assert.equal(result.output.modules.digital_intelligence.status, "partial");
});

test("one malformed module retries only that failed module", async () => {
  const context = sampleContext(1);
  const order = ["foundation", "digital_intelligence", "opportunities", "strategic_interpretation", "contact_decision"];
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      if (calls === 3) return "{ malformed";
      if (calls === 4) return moduleJson(context, "opportunities");
      if (calls <= 6) return moduleJson(context, order[calls - 1 > 2 ? calls - 2 : calls - 1]);
      return "# Business Growth Blueprint\n\nRecovered.";
    }
  });
  assert.equal(result.output.modules.opportunities.repaired, true);
  assert.equal(result.output.modules.foundation.status, "completed");
});

test("email returned as contact_name is moved to contact_email before validation", () => {
  const context = sampleContext(1);
  const output = moduleOutput(context, "foundation");
  output.contacts[0].contact_name = "info@example.com";
  output.contacts[0].contact_email = "";
  const meta = { normalization_applied: false, normalized_fields: [] };
  const validation = validateModuleOutput("foundation", output, context, {}, meta);
  assert.equal(validation.ok, true);
  assert.equal(output.contacts[0].contact_name, null);
  assert.equal(output.contacts[0].contact_email, "info@example.com");
  assert.equal(meta.normalization_applied, true);
});

test("missing business location is valid for foundation", () => {
  const context = sampleContext(1);
  const output = moduleOutput(context, "foundation");
  output.business_identity.location = null;
  const validation = validateModuleOutput("foundation", output, context, {}, { normalized_fields: [] });
  assert.equal(validation.ok, true);
});

test("missing Digital Health sub-scores are accepted with insufficient evidence status", () => {
  const context = sampleContext(1);
  const foundation = { foundation: { output: moduleOutput(context, "foundation") } };
  const output = moduleOutput(context, "digital_intelligence");
  output.digital_health = {
    status: "insufficient_evidence",
    summary: "Insufficient public evidence was available for a reliable assessment.",
    evidence_ids: [],
    confidence: "low",
    sub_scores: null,
    total_score: null
  };
  const validation = validateModuleOutput("digital_intelligence", output, context, foundation, { normalized_fields: [] });
  assert.equal(validation.ok, true);
});

test("missing radar dimensions are accepted when available dimensions are unknown", () => {
  const context = sampleContext(1);
  const foundation = { foundation: { output: moduleOutput(context, "foundation") } };
  const output = moduleOutput(context, "opportunities");
  output.ai_opportunity_radar = { conversion: { status: "unknown", evidence_ids: [], opportunity: null, confidence: "low" } };
  const validation = validateModuleOutput("opportunities", output, context, foundation, { normalized_fields: [] });
  assert.equal(validation.ok, true);
});

test("Digital Intelligence validates Brain Zero website evidence IDs outside Foundation output", () => {
  const context = sampleContext(1);
  context.evidenceLog.push({
    id: "ev-website-feature-detection-booking-001",
    sourceType: "website_feature_detection",
    sourceProvider: "website_feature_detection",
    sourceCategory: "feature",
    category: "feature",
    field: "booking_link",
    sourceUrl: "https://example1.com",
    excerpt: "Book online",
    capturedAt: "2026-07-12T00:00:00.000Z"
  });
  const foundationOutput = moduleOutput(context, "foundation");
  foundationOutput.evidence_log = foundationOutput.evidence_log.filter(item => item.id !== "ev-website-feature-detection-booking-001");
  const priorModules = { foundation: { output: foundationOutput } };
  const output = moduleOutput(context, "digital_intelligence", {
    digital_health: {
      status: "assessed",
      summary: "Website evidence supports a conversion-path assessment.",
      evidence_ids: ["ev-website-feature-detection-booking-001"],
      confidence: "medium",
      sub_scores: {
        website_clarity: digitalSub(10, ["ev-website-feature-detection-booking-001"]),
        conversion_path: digitalSub(10, ["ev-website-feature-detection-booking-001"]),
        trust_and_proof: digitalSub(8, ["ev-website-feature-detection-booking-001"]),
        local_discoverability: digitalSub(8, ["ev-website-feature-detection-booking-001"]),
        customer_convenience: digitalSub(8, ["ev-website-feature-detection-booking-001"]),
        technical_readiness: digitalSub(8, ["ev-website-feature-detection-booking-001"])
      }
    }
  });
  const validation = validateModuleOutput("digital_intelligence", output, context, priorModules, { normalized_fields: [] });
  assert.equal(validation.ok, true);
});

test("failed strategic interpretation still allows safe contact decision module", async () => {
  const context = sampleContext(1);
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      if (calls === 1) return moduleJson(context, "foundation");
      if (calls === 2) return moduleJson(context, "digital_intelligence");
      if (calls === 3) return moduleJson(context, "opportunities");
      if (calls === 4 || calls === 5) return "{ bad strategy";
      if (calls === 6) return moduleJson(context, "contact_decision", {
        contact_decision: { ...moduleOutput(context, "contact_decision").contact_decision, decision: "DO NOT CONTACT", decision_confidence: "low", evidence_ids: ["ev-lead-record"] }
      });
      return "# Business Growth Blueprint\n\nStrategic section had insufficient evidence.";
    }
  });
  assert.equal(result.output.modules.strategic_interpretation.status, "failed");
  assert.equal(result.output.modules.contact_decision.output.contact_decision.decision, "DO NOT CONTACT");
});

test("CONTACT is blocked when opportunity evidence is weak", () => {
  const context = sampleContext(1);
  const priorModules = {
    foundation: { output: moduleOutput(context, "foundation") },
    opportunities: { output: { hidden_opportunities: [] } }
  };
  const output = moduleOutput(context, "contact_decision");
  const validation = validateModuleOutput("contact_decision", output, context, priorModules, { normalized_fields: [] });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /CONTACT decision requires/);
});

test("Phase B validates against flattened combined output only", () => {
  const context = sampleContext(1);
  const combined = {
    modules: {
      foundation: { output: moduleOutput(context, "foundation") },
      opportunities: { output: moduleOutput(context, "opportunities") }
    }
  };
  const flattened = flattenCombinedOutput(combined);
  assert.equal(validatePhaseBMarkdownAgainstPhaseA("Owner says $20,000 is missing.", flattened).ok, false);
});

test("technical errors are hidden behind Technical Details in UI", () => {
  const html = fs.readFileSync("callcatch-lead-dashboard.html", "utf8");
  assert.match(html, /Technical Details/);
  assert.doesNotMatch(html, /hundreds of raw validation errors/i);
});

test("successful modules are preserved when another module fails", async () => {
  const context = sampleContext(1);
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      if (calls === 1) return moduleJson(context, "foundation");
      if (calls === 2 || calls === 3) return "{ bad digital";
      if (calls === 4) return moduleJson(context, "opportunities");
      if (calls === 5) return moduleJson(context, "strategic_interpretation");
      if (calls === 6) return moduleJson(context, "contact_decision");
      return "# Business Growth Blueprint\n\nPartial.";
    }
  });
  assert.equal(result.output.modules.foundation.status, "completed");
  assert.equal(result.output.modules.digital_intelligence.status, "failed");
  assert.equal(result.output.modules.opportunities.status, "partial");
});

test("module normalization converts numeric strings and deduplicates evidence ids", () => {
  const context = sampleContext(1);
  const priorModules = { foundation: { output: moduleOutput(context, "foundation") } };
  const output = moduleOutput(context, "digital_intelligence");
  output.digital_health = {
    status: "assessed",
    summary: "Visible public website information supports a partial digital assessment.",
    evidence_ids: ["ev-lead-record", "ev-lead-record"],
    confidence: "moderate",
    sub_scores: {
      website_clarity: digitalSub("12", ["ev-lead-record", "ev-lead-record"], "moderate"),
      conversion_path: digitalSub("10", ["ev-lead-record"], "medium"),
      trust_and_proof: digitalSub("8", ["ev-lead-record"], "medium"),
      local_discoverability: digitalSub("9", ["ev-lead-record"], "medium"),
      customer_convenience: digitalSub("7", ["ev-lead-record"], "medium"),
      technical_readiness: digitalSub("6", ["ev-lead-record"], "medium")
    }
  };
  const meta = { normalization_applied: false, normalized_fields: [] };
  const validation = validateModuleOutput("digital_intelligence", output, context, priorModules, meta);
  assert.equal(validation.ok, true);
  assert.equal(output.digital_health.total_score, 52);
  assert.deepEqual(output.digital_health.evidence_ids, ["ev-lead-record"]);
  assert.equal(output.digital_health.confidence, "medium");
});

test("unsupported module monetary estimate is normalized to insufficient evidence", () => {
  const context = sampleContext(1);
  const priorModules = { foundation: { output: moduleOutput(context, "foundation") } };
  const output = moduleOutput(context, "opportunities", {
    money_left_on_table: {
      status: "estimated",
      low_estimate: "12000",
      high_estimate: "",
      currency: "USD",
      time_period: "monthly",
      calculation_method: "",
      assumptions: [],
      evidence_ids: [],
      confidence: "high",
      disclaimer: "Estimate"
    }
  });
  const meta = { normalization_applied: false, normalized_fields: [] };
  const validation = validateModuleOutput("opportunities", output, context, priorModules, meta);
  assert.equal(validation.ok, true);
  assert.equal(output.money_left_on_table.status, "insufficient_evidence");
  assert.equal(output.money_left_on_table.low_estimate, null);
  assert.equal(meta.normalized_fields.includes("money_left_on_table"), true);
});

test("unknown scores stay null while measured zero is preserved", async () => {
  const context = sampleContext(1);
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      if (calls === 1) return moduleJson(context, "foundation");
      if (calls === 2) return moduleJson(context, "digital_intelligence", {
        digital_health: { status: "insufficient_evidence", summary: "Not enough website evidence.", evidence_ids: [], confidence: "low", sub_scores: null, total_score: null }
      });
      if (calls === 3) return moduleJson(context, "opportunities", {
        hidden_opportunities: [{
          ...moduleOutput(context, "opportunities").hidden_opportunities[0],
          ranking_factors: { evidence_strength: 0, business_impact: 80, feasibility: 90, urgency: 75 },
          opportunity_priority_score: 0
        }]
      });
      if (calls === 4) return moduleJson(context, "strategic_interpretation");
      if (calls === 5) return moduleJson(context, "contact_decision", {
        contact_decision: {
          ...moduleOutput(context, "contact_decision").contact_decision,
          decision: "DO NOT CONTACT",
          decision_confidence: "low",
          callcatch_opportunity_score: null,
          evidence_ids: []
        }
      });
      return "# Business Growth Blueprint\n\nManual review only.";
    }
  });
  assert.equal(result.output.score_metadata.digital_health.value, null);
  assert.equal(result.output.score_metadata.opportunity_priority.value, 0);
  assert.equal(result.output.score_metadata.callcatch_opportunity.value, null);
});

test("non-dangerous module validation error is salvaged as partial", async () => {
  const context = sampleContext(1);
  const badOpportunity = moduleOutput(context, "opportunities", {
    ai_opportunity_radar: {
      custom_dimension: { status: "unsupported", evidence_ids: [], opportunity: "Unknown", confidence: "low" }
    }
  });
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      if (calls === 1) return moduleJson(context, "foundation");
      if (calls === 2) return moduleJson(context, "digital_intelligence");
      if (calls === 3 || calls === 4) return JSON.stringify(badOpportunity);
      if (calls === 5) return moduleJson(context, "strategic_interpretation");
      if (calls === 6) return moduleJson(context, "contact_decision");
      return "# Business Growth Blueprint\n\nPartial module preserved.";
    }
  });
  assert.equal(result.output.modules.opportunities.status, "partial");
  assert.equal(result.output.failed_modules.includes("opportunities"), false);
});

test("Spring HVAC style Brain Zero replay keeps strong evidence as usable Brain One output", async () => {
  const lead = sampleLead(1, {
    id: "spring-hvac",
    business: "Spring HVAC",
    website: "https://springhvac.example",
    city: "Spring",
    state: "TX",
    email: "service@springhvac.example",
    aiInsights: [
      "Brain Zero collected 57 evidence records across 9 sources.",
      "Website crawl was partial but identity, trust, content, feature, and technical evidence completed."
    ]
  });
  const context = buildBrainOneContextPackage(lead, {
    ok: true,
    url: lead.website,
    text: "Spring HVAC advertises heating and cooling service, emergency repairs, phone contact, service-area pages, customer reviews, and financing information."
  });
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      const order = ["foundation", "digital_intelligence", "opportunities", "strategic_interpretation", "contact_decision"];
      if (calls <= 5) return moduleJson(context, order[calls - 1]);
      return "# Business Growth Blueprint\n\nPublic evidence supports a manual opportunity review.";
    }
  });
  assert.equal(result.output.failed_modules.length, 0);
  assert.equal(result.output.modules.foundation.output.evidence_log.length >= 2, true);
  assert.notEqual(result.output.score_metadata.opportunity_priority.status, "failed");
});

test("Blueprint synthesizes assessed modules instead of defaulting downstream sections to insufficient evidence", async () => {
  const context = sampleContext(1);
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      const order = ["foundation", "digital_intelligence", "opportunities", "strategic_interpretation", "contact_decision"];
      const full = sampleOutput(context);
      if (calls === 2) return moduleJson(context, "digital_intelligence", {
        business_dna: full.business_dna,
        digital_health: full.digital_health,
        ai_discoverability: full.ai_discoverability,
        future_readiness: full.future_readiness
      });
      if (calls <= 5) return moduleJson(context, order[calls - 1]);
      return "# Business Growth Blueprint\n\n## Opportunity Summary\nInsufficient public evidence.\n\n## Hidden Opportunities\nInsufficient public evidence.\n\n## AI Opportunity Radar\nInsufficient public evidence.\n\n## Why This Business Deserves Attention\nInsufficient public evidence.\n\n## If CallCatch Owned This Business For One Day\nInsufficient public evidence.";
    }
  });
  assert.match(result.blueprintMarkdown, /Inbound local service provider|Core services include/i);
  assert.match(result.blueprintMarkdown, /Capture more urgent service callers/i);
  assert.match(result.blueprintMarkdown, /AI Opportunity Radar/);
  assert.match(result.blueprintMarkdown, /Why This Business Deserves Attention/);
  assert.match(result.blueprintMarkdown, /Start with response-path verification/i);
  assert.doesNotMatch(result.blueprintMarkdown, /## Hidden Opportunities\n- Insufficient public evidence/i);
  assert.doesNotMatch(result.blueprintMarkdown, /## Why This Business Deserves Attention\n- Insufficient public evidence/i);
});

test("independent module scores preserve strong business quality when contactability is poor", async () => {
  const context = sampleContext(1);
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      const full = sampleOutput(context);
      if (calls === 1) return moduleJson(context, "foundation", { contacts: [] });
      if (calls === 2) return moduleJson(context, "digital_intelligence", {
        business_dna: full.business_dna,
        digital_health: full.digital_health,
        ai_discoverability: full.ai_discoverability,
        future_readiness: full.future_readiness
      });
      if (calls === 3) return moduleJson(context, "opportunities");
      if (calls === 4) return moduleJson(context, "strategic_interpretation");
      if (calls === 5) return moduleJson(context, "contact_decision", {
        contact_decision: {
          ...full.contact_decision,
          decision: "DO NOT CONTACT",
          decision_confidence: "low",
          primary_reason: "Excellent company, but no verified contact path.",
          callcatch_opportunity_score: null,
          evidence_ids: ["ev-lead-record"]
        }
      });
      return "# Business Growth Blueprint\n\nGeneric render.";
    }
  });
  const scores = result.output.score_metadata.module_scores;
  assert.ok(scores.business_foundation.value >= 80);
  assert.ok(scores.business_dna.value >= 80);
  assert.ok(scores.digital_health.value >= 50);
  assert.ok(scores.ai_discoverability.value >= 50);
  assert.equal(scores.contactability.value, 0);
  assert.equal(result.output.decision_engine.decision, "DO NOT CONTACT");
  assert.match(result.blueprintMarkdown, /Business Foundation: \d+\/100/);
  assert.match(result.blueprintMarkdown, /Contactability: 0\/100/);
  assert.doesNotMatch(result.blueprintMarkdown, /Business Foundation: Not scored|Business Foundation: Failed/i);
});

test("Brain Zero evidence powers digital, AI, and future scores for enterprise validation fixtures", async () => {
  const fixtures = [
    ["Stripe", "https://stripe.com"],
    ["HubSpot", "https://hubspot.com"],
    ["Microsoft", "https://microsoft.com"],
    ["Shopify", "https://shopify.com"]
  ];
  for (const [name, website] of fixtures) {
    const context = enterpriseEvidenceContext(name, website);
    assert.equal(validateBrainOneInput(context).ok, true);
    let calls = 0;
    const result = await runBrainOne(context, {
      model: "test-model",
      callModel: async () => {
        calls += 1;
        const full = sampleOutput(context);
        const richDna = {
          ...full.business_dna,
          business_model: "B2B platform business",
          primary_services: ["software platform", "APIs", "developer tools", "business operations"],
          likely_customer_segments: ["businesses", "developers", "enterprise teams"],
          geographic_market: "global",
          value_proposition: `${name} provides a public platform with strong product, developer, and trust signals.`,
          likely_revenue_drivers: ["platform usage", "subscriptions", "enterprise adoption", "integrations"],
          customer_journey: "Research online, compare platform capability, review documentation, evaluate trust, then contact sales or self-serve.",
          current_digital_maturity: "advanced",
          operational_complexity: "high",
          trust_signals: ["enterprise customers", "partners", "case studies", "security"],
          differentiators: ["developer ecosystem", "platform depth", "public documentation"],
          growth_stage: "mature",
          confidence: "high",
          evidence_ids: context.evidenceLog.map(item => item.id)
        };
        if (calls === 1) return JSON.stringify({ ...moduleOutput(context, "foundation"), contacts: [] });
        if (calls === 2) return JSON.stringify({
          business_dna: richDna,
          digital_health: { status: "insufficient_evidence", summary: "Model did not produce a digital score.", evidence_ids: [], confidence: "low", sub_scores: null, total_score: null },
          ai_discoverability: { status: "insufficient_evidence", summary: "Model did not produce an AI discoverability score.", evidence_ids: [], confidence: "low" },
          future_readiness: { status: "insufficient_evidence", summary: "Model did not produce a future readiness score.", evidence_ids: [], confidence: "low" }
        });
        if (calls === 3) return moduleJson(context, "opportunities", { hidden_opportunities: [] });
        if (calls === 4) return moduleJson(context, "strategic_interpretation");
        if (calls === 5) return JSON.stringify({
          contact_decision: {
            ...full.contact_decision,
            decision: "DO NOT CONTACT",
            decision_confidence: "low",
            primary_reason: "Excellent company quality, but no verified outbound contact path was provided in the evidence package.",
            supporting_evidence: [],
            disqualifying_factors: ["No verified contact path."],
            information_gaps: ["No verified email or phone."],
            callcatch_opportunity_score: null,
            evidence_ids: []
          },
          brain_two_handoff: full.brain_two_handoff
        });
        return "# Business Growth Blueprint\n\n## Opportunity Summary\nUse deterministic rendering.";
      }
    });
    const scores = result.output.score_metadata.module_scores;
    assert.ok(scores.business_foundation.value >= 90, `${name} foundation`);
    assert.ok(scores.business_dna.value >= 90, `${name} DNA`);
    assert.ok(scores.trust.value >= 80, `${name} trust`);
    assert.ok(result.output.decision_engine.business_quality_score >= 80, `${name} quality`);
    assert.ok(scores.digital_health.value >= 80, `${name} digital`);
    assert.ok(scores.ai_discoverability.value >= 80, `${name} AI`);
    assert.ok(scores.future_readiness.value >= 80, `${name} future`);
    assert.equal(scores.contactability.value, 0, `${name} contactability`);
    assert.equal(result.output.decision_engine.decision, "DO NOT CONTACT", `${name} decision`);
    assert.ok(scores.digital_health.diagnostics.evidence_actually_used > 0, `${name} digital diagnostics`);
    assert.ok(scores.ai_discoverability.diagnostics.evidence_actually_used > 0, `${name} AI diagnostics`);
    assert.ok(scores.future_readiness.diagnostics.evidence_actually_used > 0, `${name} future diagnostics`);
    assert.match(result.blueprintMarkdown, /Digital Health: \d+\/100/);
    assert.match(result.blueprintMarkdown, /AI Discoverability: \d+\/100/);
    assert.match(result.blueprintMarkdown, /Future Readiness: \d+\/100/);
    assert.doesNotMatch(result.blueprintMarkdown, /Digital Health: Not scored|AI Discoverability: Not scored|Future Readiness: Not scored/i);
  }
});

test("weak forum-only evidence stays needs review instead of forced contact", async () => {
  const context = buildBrainOneContextPackage(sampleLead(2, {
    business: "Forum Mention Plumbing",
    website: "",
    email: "",
    source: "forum-public-mention",
    aiInsights: ["A forum mention referenced the business name, but no official website or confirmed contact was found."]
  }), null);
  let calls = 0;
  const result = await runBrainOne(context, {
    callModel: async () => {
      calls += 1;
      if (calls === 1) return moduleJson(context, "foundation", { contacts: [] });
      if (calls === 2) return moduleJson(context, "digital_intelligence", {
        digital_health: { status: "insufficient_evidence", summary: "Only weak public evidence was available.", evidence_ids: [], confidence: "low", sub_scores: null, total_score: null }
      });
      if (calls === 3) return moduleJson(context, "opportunities", { hidden_opportunities: [], money_left_on_table: null });
      if (calls === 4) return moduleJson(context, "strategic_interpretation");
      if (calls === 5) return moduleJson(context, "contact_decision", {
        contact_decision: {
          ...moduleOutput(context, "contact_decision").contact_decision,
          decision: "NEEDS_REVIEW",
          decision_confidence: "low",
          primary_reason: "The evidence is too weak for outreach.",
          callcatch_opportunity_score: null,
          evidence_ids: []
        }
      });
      return "# Business Growth Blueprint\n\nEvidence is too thin for outbound action.";
    }
  });
  assert.equal(result.output.modules.contact_decision.output.contact_decision.decision, "DO NOT CONTACT");
  assert.equal(result.output.modules.contact_decision.output.contact_decision.recommendation_status, "NEEDS_REVIEW");
  assert.equal(result.output.score_metadata.callcatch_opportunity.value, null);
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
  assert.equal(calls, 7);
  assert.equal(result.repaired, true);
});

test("unescaped quotation mark JSON is repaired once", async () => {
  const { result, calls } = await runWithFirstResponse(`{"business_identity":{"business_name":"Bob's "Best" HVAC","website_url":"https://x.test"}}`);
  assert.equal(calls, 7);
  assert.equal(result.repaired, true);
});

test("trailing comma JSON is repaired once", async () => {
  const { result, calls } = await runWithFirstResponse(`{"business_identity":{"business_name":"Broken","website_url":"https://x.test",}}`);
  assert.equal(calls, 7);
  assert.equal(result.repaired, true);
});

test("truncated JSON is repaired once", async () => {
  const { result, calls } = await runWithFirstResponse(compactJson().slice(0, 600));
  assert.equal(calls, 7);
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
