const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

  assert.match(source, /providerRequestMax:\s*60/);
  assert.match(source, /openStreetMapElementMax:\s*120/);
  assert.match(source, /serperTermsMax:\s*3/);
  assert.match(source, /bravePerQueryMax:\s*20/);
  assert.match(source, /deepResearchMax:\s*12/);
  assert.match(dailyGrowth, /maxSearchesPerRun:\s*8/);
  assert.match(report, /not exhausting businesses/i);
});

