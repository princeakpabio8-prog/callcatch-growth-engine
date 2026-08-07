const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { brainZeroCanRunBrainOne } = require("../lead-engine/brainZeroService");
const { scoreContactability, validateBrainOneInput } = require("../lead-engine/brainOneService");
const {
  brainZeroEvidenceToBrainOneContext,
  latestCompletedResearchRun,
  selectAuthoritativeResearchRun
} = require("../lead-engine/brainOneHandoff");

function verifiedLead(overrides = {}) {
  return {
    id: "lead-houston",
    business: "Houston Heating & Cooling",
    trade: "HVAC",
    city: "Houston",
    state: "TX",
    country: "US",
    website: "https://gohoustonhvac.com/",
    email: "admin@gohoustonhvac.com",
    identityVerification: {
      status: "Verified",
      verified: true,
      canonicalWebsite: "https://gohoustonhvac.com/",
      recipientEmail: "admin@gohoustonhvac.com"
    },
    ...overrides
  };
}

function researchEvidence(count = 46) {
  const base = [
    ["business_name", "Houston Heating & Cooling"],
    ["website_url", "https://gohoustonhvac.com/"],
    ["stated_location", "Houston, TX, US"],
    ["email", ["admin@gohoustonhvac.com"]]
  ];
  return Array.from({ length: count }, (_, index) => {
    const [field, value] = base[index] || [`signal_${index + 1}`, `Public service evidence ${index + 1}`];
    return {
      evidence_id: `research-evidence-${index + 1}`,
      provider: index < 4 ? "business_identity_evidence" : "website_crawl",
      category: index < 4 ? "identity" : "service",
      field,
      value,
      source_url: `https://gohoustonhvac.com/${index < 7 ? `page-${index + 1}` : ""}`,
      source_excerpt: Array.isArray(value) ? JSON.stringify(value) : String(value),
      confidence: "high",
      collected_at: "2026-08-07T10:05:00.000Z"
    };
  });
}

function completedResearchRun({
  id = "research-latest",
  businessId = "lead-houston",
  completedAt = "2026-08-07T10:05:00.000Z",
  evidenceCount = 46,
  status = "completed"
} = {}) {
  const evidence = researchEvidence(evidenceCount);
  return {
    id,
    run_id: id,
    business_id: businessId,
    businessId,
    status,
    started_at: new Date(Date.parse(completedAt) - 60000).toISOString(),
    completed_at: completedAt,
    evidence_count: evidence.length,
    source_count: 8,
    pages_scanned: 7,
    overall_evidence_quality: "strong",
    brain_one_ready: true,
    evidence_package: {
      evidence_log: evidence,
      business_identity_candidates: evidence.slice(0, 3),
      contacts: [evidence[3]],
      website_pages: evidence.slice(4, 11).map(item => ({
        url: item.source_url,
        excerpt: item.source_excerpt,
        evidence_id: item.evidence_id
      })),
      content_evidence: evidence.slice(11, 15),
      trust_evidence: evidence.slice(15, 19),
      source_urls: Array.from({ length: 8 }, (_, index) => `https://gohoustonhvac.com/source-${index + 1}`),
      overall_evidence_quality: "strong",
      brain_one_ready: true,
      evidence_coverage: {
        coverage_score: 100,
        evidence_counts_by_category: { identity: 4, service: 42 },
        evidence_counts_by_confidence: { high: 46 },
        evidence_with_valid_id: 46
      }
    }
  };
}

test("completed Research with 46 evidence items reaches Brain One with the same 46 items", () => {
  const context = brainZeroEvidenceToBrainOneContext(verifiedLead(), completedResearchRun());
  assert.equal(context.evidenceLog.length, 46);
  assert.equal(context.scraperEvidence.length, 46);
  assert.equal(context.brainZero.evidenceCount, 46);
  assert.equal(context.brainZero.sourceCount, 8);
  assert.equal(context.brainZero.pageCount, 7);
  assert.equal(context.brainZero.evidenceQuality, "strong");
  assert.equal(context.brainZero.evidenceCoverage.coverage_score, 100);
});

test("verified lead email survives Research conversion into the Brain One input", () => {
  const lead = verifiedLead();
  const context = brainZeroEvidenceToBrainOneContext(lead, completedResearchRun());
  assert.equal(context.publicContactDetails.email, lead.email);
  assert.equal(context.outreachEligibility.recipientEmail, lead.email);
  assert.equal(context.outreachEligibility.recipientUsable, true);
  assert.equal(context.outreachEligibility.verifiedContactEvidenceId, "research-evidence-4");
  assert.equal(context.outreachEligibility.verifiedContactEvidenceStatus, "confirmed");
  assert.ok(context.evidenceLog.some(item => item.id === "research-evidence-4" && JSON.stringify(item.value).includes(lead.email)));
  const score = scoreContactability({ contacts: [{ contact_email: lead.email, contact_confidence: 90, evidence_ids: ["research-evidence-4"] }] }, context);
  assert.ok(score.value >= 60);
});

test("latest completed Research run is selected for the exact lead", () => {
  const stale = completedResearchRun({ id: "research-stale", completedAt: "2026-08-07T09:00:00.000Z" });
  const latest = completedResearchRun({ id: "research-latest", completedAt: "2026-08-07T10:05:00.000Z" });
  assert.equal(latestCompletedResearchRun([stale, latest], "lead-houston").run_id, "research-latest");
  assert.equal(selectAuthoritativeResearchRun([stale, latest], { leadId: "lead-houston" }).run_id, "research-latest");
});

test("stale requested Research run is rejected instead of overriding the latest run", () => {
  const stale = completedResearchRun({ id: "research-stale", completedAt: "2026-08-07T09:00:00.000Z" });
  const latest = completedResearchRun({ id: "research-latest", completedAt: "2026-08-07T10:05:00.000Z" });
  assert.throws(
    () => selectAuthoritativeResearchRun([stale, latest], { leadId: "lead-houston", requestedRunId: "research-stale" }),
    error => error.code === "STALE_RESEARCH_RUN" && error.details.authoritativeRunId === "research-latest"
  );
});

test("Research from another lead cannot be selected for Analyze Business", () => {
  const foreign = completedResearchRun({ id: "research-foreign", businessId: "lead-other" });
  assert.throws(
    () => selectAuthoritativeResearchRun([foreign], { leadId: "lead-houston", requestedRunId: "research-foreign" }),
    error => error.code === "BUSINESS_IDENTITY_MISMATCH"
  );
});

test("failed server refresh cannot replace authoritative Research with empty browser state", () => {
  for (const file of ["index.html", "callcatch-lead-dashboard.html"]) {
    const html = fs.readFileSync(file, "utf8");
    assert.match(html, /applyServerState\(crm, false\);/);
    assert.match(html, /if \(window\.location\.protocol !== "file:"\) \{\s*leads = \[\];\s*queue = \[\];\s*brainZeroRuns = \[\];/);
    assert.doesNotMatch(html, /catch[\s\S]{0,240}applyServerState\([^,]+, true\)/);
  }
  const server = fs.readFileSync("callcatch-lead-server.js", "utf8");
  const routeStart = server.indexOf('url.pathname === "/api/brain-one/analyze"');
  const routeEnd = server.indexOf('url.pathname === "/api/brain-one/approve"', routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.doesNotMatch(route, /\|\| body\.lead/);
  assert.match(route, /selectAuthoritativeResearchRun/);
});

test("Analyze Business accepts a completed Research run marked Ready for Analysis", () => {
  const run = completedResearchRun();
  const selected = selectAuthoritativeResearchRun([run], {
    leadId: "lead-houston",
    requestedRunId: "research-latest"
  });
  const gate = brainZeroCanRunBrainOne(selected);
  const context = brainZeroEvidenceToBrainOneContext(verifiedLead(), selected);
  assert.equal(gate.allowed, true);
  assert.equal(context.brainZero.brainOneReady, true);
  assert.equal(context.brainZero.runId, "research-latest");
  assert.deepEqual(validateBrainOneInput(context), { ok: true, errors: [] });
});
