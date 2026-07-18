const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildBraveDiscoveryQueries, countryForBrave } = require("../lead-engine/providers/braveSearch");
const { __test: searchTest } = require("../lead-engine/searchEngine");

const repoRoot = path.join(__dirname, "..");

function readRepoFile(file) {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

test("lead discovery returns funnel diagnostics for bottleneck tracing", () => {
  const source = readRepoFile("lead-engine/searchEngine.js");

  assert.match(source, /diagnostics:\s*\{/);
  assert.match(source, /funnel:\s*\{/);
  assert.match(source, /rawProviderLeads/);
  assert.match(source, /afterProviderDedupe/);
  assert.match(source, /afterRatingReviewFilters/);
  assert.match(source, /skippedExisting/);
  assert.match(source, /afterExistingFilter/);
  assert.match(source, /websiteEnrichmentLimit/);
  assert.match(source, /finalEmailReady/);
  assert.match(source, /likelyBottlenecks/);
});

test("discovery investigation documents the known search caps", () => {
  const source = readRepoFile("lead-engine/searchEngine.js");
  const dailyGrowth = readRepoFile("lead-engine/dailyGrowth.js");
  const report = readRepoFile("docs/discovery-investigation.md");

  assert.match(source, /providerRequestMax:\s*DISCOVERY_LIMITS\.providerRequestMax/);
  assert.match(source, /openStreetMapElementMax:\s*120/);
  assert.match(source, /serperTermsMax:\s*3/);
  assert.match(source, /bravePerQueryMax:\s*20/);
  assert.match(source, /deepResearchMax:\s*DISCOVERY_LIMITS\.deepResearchMax/);
  assert.match(dailyGrowth, /emailReadyTarget:\s*25/);
  assert.match(dailyGrowth, /maxSearchesPerRun:\s*24/);
  assert.match(report, /not exhausting businesses/i);
});

test("Brave is selected before map fallback when configured", () => {
  const source = readRepoFile("lead-engine/searchEngine.js");
  assert.ok(source.indexOf("if (braveConfigured())") < source.indexOf("if (location.bbox)"));
  assert.match(source, /reducedCapacityMode:\s*!braveConfigured\(\)/);
  assert.match(source, /fallbackUsed/);
});

test("Brave discovery builds multiple natural query variations", () => {
  const queries = buildBraveDiscoveryQueries({
    trade: "HVAC",
    location: { city: "Dallas", state: "TX", countryCode: "US" },
    maxQueries: 8
  });
  assert.equal(queries.length, 8);
  assert.ok(queries.some(query => /contact email/i.test(query)));
  assert.ok(queries.some(query => /emergency/i.test(query)));
  assert.ok(queries.some(query => /Fort Worth|Arlington|Plano|Irving/i.test(query)));
});

test("Brave adapter includes pagination and country-aware search", () => {
  const source = readRepoFile("lead-engine/providers/braveSearch.js");
  assert.equal(countryForBrave({ countryCode: "CA" }), "CA");
  assert.equal(countryForBrave({ countryCode: "GB" }), "GB");
  assert.equal(countryForBrave({ countryCode: "DE" }), "DE");
  assert.equal(countryForBrave({ countryCode: "AU" }), "AU");
  assert.match(source, /url\.searchParams\.set\("offset"/);
  assert.match(source, /maxPages/);
});

test("country normalization does not silently convert unsupported countries to USA", () => {
  assert.equal(searchTest.normalizeCountry("Australia"), "AU");
  assert.equal(searchTest.normalizeCountry("Germany"), "DE");
  assert.equal(searchTest.normalizeCountry("Atlantis"), "UNSUPPORTED");
});

test("usable business email validation accepts role inboxes and rejects bad addresses", () => {
  assert.equal(searchTest.isUsableBusinessEmail("info@realhvac.com"), true);
  assert.equal(searchTest.isUsableBusinessEmail("service@realhvac.com"), true);
  assert.equal(searchTest.isUsableBusinessEmail("noreply@realhvac.com"), false);
  assert.equal(searchTest.isUsableBusinessEmail("test@example.com"), false);
  assert.equal(searchTest.isUsableBusinessEmail("lead@yelp.com"), false);
  assert.equal(searchTest.preferredEmail(["owner@realhvac.com", "info@realhvac.com"]), "info@realhvac.com");
});

test("outreach-ready discovery excludes no-email businesses from final results", () => {
  const source = readRepoFile("lead-engine/searchEngine.js");
  assert.match(source, /emailReadyOnly:\s*true/);
  assert.match(source, /finalNeedsEmail:\s*0/);
  assert.match(source, /collectOutreachReadyLeads/);
  assert.match(source, /No usable business emails were found/);
});

test("Daily Growth targets email-ready leads instead of fixed tiny search count", () => {
  const source = readRepoFile("lead-engine/dailyGrowth.js");
  assert.match(source, /emailReadyTarget:\s*25/);
  assert.match(source, /if \(discovered\.length >= target\) break/);
  assert.match(source, /targetReached/);
  assert.match(source, /stoppedReason/);
  assert.match(source, /noEmailDiscarded/);
});

