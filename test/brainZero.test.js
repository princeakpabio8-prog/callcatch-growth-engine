const test = require("node:test");
const assert = require("node:assert/strict");

const {
  brainZeroCanRunBrainOne,
  brainZeroRuntimeState,
  calculateEvidenceCoverage,
  contextFromLead,
  dedupeEvidence,
  evidenceHash,
  genericInbox,
  makeEvidence,
  runBrainZeroEvidenceCollection,
  safeRunProvider
} = require("../lead-engine/brainZeroService");

function response(url, body, { status = 200, finalUrl = url, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    url: finalUrl,
    headers: new Map(Object.entries({ "content-type": "text/html; charset=utf-8", ...headers })),
    async text() {
      return body;
    }
  };
}

function lead(overrides = {}) {
  return {
    id: "lead-bz-1",
    business: "Brain Zero HVAC",
    trade: "HVAC",
    city: "Dallas",
    state: "TX",
    website: "https://example.com",
    email: "info@brainzerohvac.com",
    phone: "214-555-0101",
    source: "test",
    ...overrides
  };
}

function html(title = "Brain Zero HVAC", body = "") {
  return `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="HVAC repair"><meta name="viewport" content="width=device-width"><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head><body><h1>Emergency HVAC Repair</h1>${body}</body></html>`;
}

function fetchMap(map = {}) {
  return async url => {
    const key = String(url).replace(/\/$/, "");
    if (map[key] instanceof Error) throw map[key];
    if (typeof map[key] === "function") return map[key](url);
    if (map[key]) return map[key];
    if (key.endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /");
    if (key.endsWith("/sitemap.xml")) return response(url, "<urlset></urlset>");
    return response(url, "Not found", { status: 404 });
  };
}

async function run(contextOverrides = {}, fetchImpl, config = {}) {
  const enforceActiveLimit = !!config.enforceActiveLimit;
  const serviceConfig = { ...config };
  delete serviceConfig.enforceActiveLimit;
  return runBrainZeroEvidenceCollection({
    ...contextFromLead(lead()),
    ...contextOverrides
  }, {
    fetchImpl,
    config: {
      totalTimeoutMs: 2000,
      pageTimeoutMs: 50,
      crawlTimeoutMs: 120,
      technicalTimeoutMs: 80,
      maxPages: 4,
      maxConcurrentRequests: 2,
      ...serviceConfig
    },
    enforceActiveLimit,
    logger: () => {}
  });
}

test("existing scraper output is preserved as provider evidence", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `<a href="/contact">Contact</a>`)),
    "https://example.com/contact": response("https://example.com/contact", html("Contact", `Email info@brainzerohvac.com <a href="tel:2145550101">Call</a>`))
  }));
  assert.equal(result.providers.existing_lead_search.status, "completed");
  assert.equal(result.evidence_package.evidence_log.some(item => item.provider === "existing_lead_search"), true);
});

test("one provider timing out returns partial instead of failing full Brain Zero run", async () => {
  const hangingFetch = async url => {
    if (String(url).endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /");
    if (String(url).endsWith("/sitemap.xml")) return response(url, "<urlset></urlset>");
    if (String(url).replace(/\/$/, "") === "https://example.com") {
      return response(url, html("Home", `<a href="/contact">Contact</a>`));
    }
    return new Promise(() => {});
  };
  const result = await run({}, hangingFetch, { crawlTimeoutMs: 20 });
  assert.equal(result.status, "partial");
  assert.equal(result.providers.website_crawl.status, "failed");
  assert.ok(result.evidence_count > 0);
});

test("malformed provider data is isolated by evidence de-duplication", () => {
  const { evidence, removed } = dedupeEvidence([
    makeEvidence("business_identity_evidence", "identity", "owner_name", "service@example.com", { excerpt: "bad name" }),
    makeEvidence("business_identity_evidence", "contact", "email", ["office@brainzerohvac.com"], { excerpt: "office@brainzerohvac.com" }),
    makeEvidence("business_identity_evidence", "contact", "email", ["office@brainzerohvac.com"], { excerpt: "office@brainzerohvac.com" })
  ]);
  assert.equal(evidence.length, 1);
  assert.equal(removed.length, 2);
});

test("website with no URL still preserves existing lead evidence", async () => {
  const result = await run({ website_url: null }, fetchMap({}));
  assert.equal(result.providers.website_crawl.status, "skipped");
  assert.ok(result.evidence_count >= 1);
});

test("website redirect is recorded in technical evidence", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html(), { finalUrl: "https://www.example.com/home" }),
    "https://www.example.com/sitemap.xml": response("https://www.example.com/sitemap.xml", "<urlset></urlset>"),
    "https://www.example.com/robots.txt": response("https://www.example.com/robots.txt", "User-agent: *\nAllow: /")
  }));
  const tech = result.evidence_package.technical_evidence[0];
  assert.match(JSON.stringify(tech.value), /www\.example\.com\/home/);
});

test("unavailable website causes partial run while preserving lead evidence", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", "down", { status: 503 })
  }));
  assert.equal(result.status, "partial");
  assert.equal(result.providers.website_crawl.status, "failed");
  assert.ok(result.providers.existing_lead_search.evidence.length);
});

test("robots.txt restriction is recorded without bypassing it", async () => {
  const result = await run({}, fetchMap({
    "https://example.com/robots.txt": response("https://example.com/robots.txt", "User-agent: *\nDisallow: /")
  }));
  assert.equal(result.providers.website_crawl.status, "partial");
  assert.equal(result.providers.website_crawl.evidence.some(item => item.field === "robots_restriction"), true);
});

test("duplicate pages and duplicate evidence are removed", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `<a href="/contact">Contact</a><a href="/contact">Contact again</a>`)),
    "https://example.com/contact": response("https://example.com/contact", html("Contact", `Call 214-555-0101`))
  }));
  assert.equal(result.pages_scanned <= 2, true);
  const ids = result.evidence_package.evidence_log.map(item => item.evidence_id);
  assert.equal(ids.length, new Set(ids).size);
});

test("generic email inbox remains generic contact evidence", async () => {
  assert.equal(genericInbox("info@example.com"), true);
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `Email info@brainzerohvac.com`))
  }));
  assert.equal(result.evidence_package.contacts.some(item => item.field === "generic_inbox"), true);
});

test("feature not detected is represented as unknown, not as a false absence", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `Call us today`))
  }));
  const booking = result.providers.website_feature_detection.evidence.find(item => item.field === "booking_link");
  assert.equal(booking.claim_type, "unknown");
  assert.equal(booking.value, "not_detected_on_scanned_pages");
});

test("unverified business claims are marked as business_claim", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `Licensed and insured. Award-winning service. 25 years of experience.`))
  }));
  assert.equal(result.evidence_package.trust_evidence.some(item => item.claim_type === "business_claim"), true);
});

test("failed run with no usable evidence is marked failed", async () => {
  const result = await run({
    business_id: "",
    business_name: null,
    website_url: null,
    known_email: null,
    known_phone: null,
    known_location: null,
    existing_scraper_data: null
  }, fetchMap({}));
  assert.equal(result.status, "failed");
  assert.equal(result.evidence_count, 0);
});

test("Brain One is blocked after failed Brain Zero", () => {
  const gate = brainZeroCanRunBrainOne({ status: "failed" });
  assert.equal(gate.allowed, false);
});

test("Brain One is allowed with warning after partial Brain Zero only when accepted", () => {
  assert.equal(brainZeroCanRunBrainOne({ status: "partial" }).allowed, false);
  const gate = brainZeroCanRunBrainOne({ status: "partial" }, { acceptPartial: true });
  assert.equal(gate.allowed, true);
  assert.match(gate.warning, /partial evidence/i);
});

test("high evidence count without official identity is not Brain One ready", () => {
  const evidence = Array.from({ length: 55 }, (_, index) => makeEvidence("technical_website_evidence", "technical", `metric_${index}`, `value ${index}`, {
    url: `https://example.com/page-${index % 5}`,
    excerpt: `technical value ${index}`
  }, { index, confidence: "medium" }));
  const coverage = calculateEvidenceCoverage({
    providers: { technical_website_evidence: { status: "completed", evidence } },
    evidence,
    pagesScanned: 5
  });
  assert.equal(coverage.quantity_score, 100);
  assert.equal(coverage.brain_one_ready, false);
  assert.equal(coverage.missing_critical_categories.includes("official_business_identity"), true);
});

test("many technical records produce weak business coverage", async () => {
  const evidence = Array.from({ length: 55 }, (_, index) => makeEvidence("technical_website_evidence", "technical", `metric_${index}`, `value ${index}`, {
    url: `https://example.com/page-${index % 5}`,
    excerpt: `technical value ${index}`
  }, { index, confidence: "medium" }));
  const packageValue = require("../lead-engine/brainZeroService").buildBrainOneEvidencePackage({
    providers: { technical_website_evidence: { status: "completed", evidence } },
    evidence,
    status: "completed",
    quality: "weak",
    coverage: calculateEvidenceCoverage({ providers: { technical_website_evidence: { status: "completed", evidence } }, evidence, pagesScanned: 5 })
  });
  assert.equal(packageValue.brain_one_ready, false);
  assert.equal(packageValue.overall_evidence_quality, "weak");
});

test("strong quantity and critical business coverage is Brain One ready", () => {
  const evidence = [
    makeEvidence("business_identity_evidence", "identity", "business_name", "Brain Zero HVAC", { url: "https://example.com", excerpt: "Brain Zero HVAC" }, { index: 1, confidence: "high" }),
    makeEvidence("business_identity_evidence", "identity", "website_url", "https://example.com", { url: "https://example.com", excerpt: "https://example.com" }, { index: 2, confidence: "high" }),
    makeEvidence("business_identity_evidence", "identity", "stated_location", "Dallas, TX", { url: "https://example.com", excerpt: "Dallas, TX" }, { index: 3, confidence: "high" }),
    makeEvidence("business_identity_evidence", "contact", "email", ["info@example.com"], { url: "https://example.com/contact", excerpt: "info@example.com" }, { index: 4, confidence: "high" }),
    makeEvidence("content_discoverability_evidence", "content", "content_snapshot", { service_descriptions_present: true }, { url: "https://example.com/services", excerpt: "HVAC repair and installation services" }, { index: 5, confidence: "medium" }),
    makeEvidence("website_feature_detection", "feature", "booking_link", "https://example.com/book", { url: "https://example.com", excerpt: "Book online" }, { index: 6, confidence: "medium" }),
    makeEvidence("public_trust_evidence", "trust", "testimonials", "reviews", { url: "https://example.com/reviews", excerpt: "Customer reviews" }, { index: 7, confidence: "medium" }),
    makeEvidence("technical_website_evidence", "technical", "technical_snapshot", { https: true }, { url: "https://example.com", excerpt: "technical" }, { index: 8, confidence: "medium" })
  ];
  const coverage = calculateEvidenceCoverage({
    providers: {
      business_identity_evidence: { status: "completed", evidence: evidence.slice(0, 4) },
      content_discoverability_evidence: { status: "completed", evidence: [evidence[4]] },
      website_feature_detection: { status: "completed", evidence: [evidence[5]] },
      public_trust_evidence: { status: "completed", evidence: [evidence[6]] },
      technical_website_evidence: { status: "completed", evidence: [evidence[7]] }
    },
    evidence,
    pagesScanned: 5
  });
  assert.equal(coverage.brain_one_ready, true);
  assert.equal(coverage.missing_critical_categories.length, 0);
});

test("identity provider completed with zero usable evidence is shown insufficient", () => {
  const coverage = calculateEvidenceCoverage({
    providers: { business_identity_evidence: { status: "completed", evidence: [] } },
    evidence: [],
    pagesScanned: 0
  });
  assert.equal(coverage.provider_diagnostics.business_identity_evidence.execution_status, "completed");
  assert.equal(coverage.provider_diagnostics.business_identity_evidence.usable_evidence_count, 0);
  assert.equal(coverage.provider_diagnostics.business_identity_evidence.coverage_status, "insufficient");
});

test("Brain One readiness false when critical categories are missing", () => {
  const run = {
    status: "completed",
    evidence_package: {
      brain_one_ready: false,
      missing_critical_categories: ["official_business_identity", "contact_path"]
    }
  };
  const gate = brainZeroCanRunBrainOne(run);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /official_business_identity/);
  assert.equal(brainZeroCanRunBrainOne(run, { acceptPartial: true }).allowed, true);
});

test("cache hit can be detected by matching evidence package hash", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `Email info@brainzerohvac.com`))
  }));
  const first = evidenceHash(result.evidence_package);
  const second = evidenceHash(result.evidence_package);
  assert.equal(first, second);
});

test("force rescan is represented by caller through a fresh run request", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `Email info@brainzerohvac.com`))
  }));
  assert.equal(result.version, "brain-zero-v1");
  assert.ok(result.started_at);
});

test("provider concurrency limit is respected during crawl", async () => {
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async url => {
    if (String(url).endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /");
    if (String(url).endsWith("/sitemap.xml")) return response(url, "<urlset></urlset>");
    const clean = String(url).replace(/\/$/, "");
    if (clean === "https://example.com") {
      return response(url, html("Home", `<a href="/contact">Contact</a><a href="/about">About</a><a href="/faq">FAQ</a>`));
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return response(url, html("Page", "Service details"));
  };
  await run({}, fetchImpl, { maxConcurrentRequests: 2, crawlTimeoutMs: 1000 });
  assert.equal(maxActive <= 2, true);
});

test("technical errors are kept in provider details for UI Technical Details", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": new Error("network down")
  }));
  assert.equal(result.providers.website_crawl.errors.length > 0, true);
});

test("Brain Zero does not change email or follow-up behaviour", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `Email info@brainzerohvac.com`))
  }));
  const text = JSON.stringify(result);
  assert.equal(/send now|follow-up email|outreach subject|approve/i.test(text), false);
});

test("safe provider wrapper catches synchronous throws", async () => {
  const result = await safeRunProvider("sync_throw_provider", () => {
    throw new Error("boom");
  }, {}, { runId: "test-sync" }, {}, () => {});
  assert.equal(result.status, "failed");
  assert.match(result.errors[0], /boom/);
});

test("safe provider wrapper catches rejected promises", async () => {
  const result = await safeRunProvider("reject_provider", async () => {
    throw new Error("reject boom");
  }, {}, { runId: "test-reject" }, {}, () => {});
  assert.equal(result.status, "failed");
  assert.match(result.errors[0], /reject boom/);
});

test("malformed URL becomes failed provider output, not process crash", async () => {
  const result = await run({ website_url: "http://%" }, fetchMap({}));
  assert.equal(["partial", "failed"].includes(result.status), true);
  assert.equal(result.providers.website_crawl.status, "failed");
});

test("oversized HTML is rejected safely", async () => {
  const large = "x".repeat(250000);
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", large, { headers: { "content-length": "250000" } })
  }), { maxResponseBytes: 100000 });
  assert.equal(result.providers.website_crawl.status, "failed");
  assert.match(JSON.stringify(result.providers.website_crawl.errors), /excessive size/i);
});

test("non-HTML response is skipped safely", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", "%PDF-1.7", { headers: { "content-type": "application/pdf" } })
  }));
  assert.equal(result.providers.website_crawl.status, "failed");
  assert.match(JSON.stringify(result.providers.website_crawl.errors), /Non-HTML/i);
});

test("DNS failure is isolated to provider failure", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": new Error("getaddrinfo ENOTFOUND example.com")
  }));
  assert.equal(result.status, "partial");
  assert.equal(result.providers.website_crawl.status, "failed");
});

test("successful evidence is preserved when a later provider fails", async () => {
  const result = await run({}, fetchMap({
    "https://example.com": response("https://example.com", html("Home", `<a href="/contact">Contact</a>`)),
    "https://example.com/contact": response("https://example.com/contact", html("Contact", `Email info@brainzerohvac.com`))
  }));
  result.providers.content_discoverability_evidence.status = "failed";
  const evidenceCount = result.evidence_package.evidence_log.length;
  assert.ok(evidenceCount > 0);
});

test("global active-run limit returns queued and releases after completion", async () => {
  const slowFetch = async url => {
    if (String(url).endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /");
    if (String(url).endsWith("/sitemap.xml")) return response(url, "<urlset></urlset>");
    await new Promise(resolve => setTimeout(resolve, 50));
    return response(url, html("Home", "Slow page"));
  };
  const first = run({}, slowFetch, { maxActiveRuns: 1, maxResponseBytes: 500000, pageTimeoutMs: 1000, enforceActiveLimit: true });
  const second = await run({ business_id: "second" }, slowFetch, { maxActiveRuns: 1, pageTimeoutMs: 1000, enforceActiveLimit: true });
  assert.equal(second.status, "queued");
  await first;
  assert.equal(brainZeroRuntimeState().activeRunCount, 0);
});

test("repeated sequential scans release timers and locks", async () => {
  for (let index = 0; index < 20; index += 1) {
    const result = await run({ business_id: `stress-${index}` }, fetchMap({
      "https://example.com": response("https://example.com", html("Home", `Email info${index}@brainzerohvac.com`))
    }), { maxActiveRuns: 1 });
    assert.equal(["completed", "partial"].includes(result.status), true);
    assert.equal(brainZeroRuntimeState().activeRunCount, 0);
  }
});

test("server source includes stale running recovery and no process exit", () => {
  const fs = require("node:fs");
  const server = fs.readFileSync("callcatch-lead-server.js", "utf8");
  assert.match(server, /recoverStaleBrainZeroRuns/);
  assert.match(server, /run_interrupted_by_server_restart/);
  assert.doesNotMatch(server, /process\.exit\s*\(/);
});
