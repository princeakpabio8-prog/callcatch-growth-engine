const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildManualLead,
  convertManualProspectToReal,
  findDuplicateManualLead,
  normalizeManualWebsiteUrl,
  outreachDisabled,
  validateManualProspectInput
} = require("../lead-engine/manualProspect");
const { sendTaskNow, generateFollowUps } = require("../lead-engine/sendingEngine");

test("manual prospect accepts company name only", () => {
  const input = validateManualProspectInput({ companyName: "Microsoft", mode: "test" });
  assert.equal(input.companyName, "Microsoft");
  assert.equal(input.websiteUrl, "");
  assert.equal(input.testProspect, true);
});

test("manual prospect accepts website only and normalizes missing scheme", () => {
  const input = validateManualProspectInput({ websiteUrl: "www.microsoft.com/?utm_source=x&gclid=abc" });
  assert.equal(input.websiteUrl, "https://www.microsoft.com/");
  assert.equal(input.canonicalDomain, "microsoft.com");
});

test("manual prospect accepts company name and website", () => {
  const input = validateManualProspectInput({ companyName: "HubSpot", websiteUrl: "https://hubspot.com", industry: "SaaS" });
  assert.equal(input.companyName, "HubSpot");
  assert.equal(input.industry, "SaaS");
  assert.equal(input.canonicalDomain, "hubspot.com");
});

test("manual prospect rejects missing company and website", () => {
  assert.throws(() => validateManualProspectInput({ notes: "research" }), /company name or website/i);
});

test("manual prospect rejects malformed and unsafe URLs", () => {
  assert.throws(() => normalizeManualWebsiteUrl("https://"), /malformed/i);
  assert.throws(() => normalizeManualWebsiteUrl("javascript:alert(1)"), /protocol/i);
  assert.throws(() => normalizeManualWebsiteUrl("http://localhost:8787"), /blocked/i);
  assert.throws(() => normalizeManualWebsiteUrl("http://127.0.0.1/admin"), /blocked/i);
  assert.throws(() => normalizeManualWebsiteUrl("http://192.168.1.25"), /blocked/i);
  assert.throws(() => normalizeManualWebsiteUrl("http://[::1]/"), /blocked/i);
});

test("duplicate domain detection opens existing lead instead of overwriting", () => {
  const existing = { id: "lead-1", business: "Microsoft", website: "https://www.microsoft.com/en-us" };
  const duplicate = findDuplicateManualLead([existing], "microsoft.com");
  assert.equal(duplicate.id, "lead-1");
});

test("separate test copy keeps manual test safeguards", () => {
  const input = validateManualProspectInput({ companyName: "Shopify", websiteUrl: "shopify.com" });
  const lead = buildManualLead(input, { id: "lead-copy", testCopy: true });
  assert.equal(lead.testProspect, true);
  assert.equal(lead.outreachDisabled, true);
  assert.equal(lead.tags.includes("Separate Test Copy"), true);
});

test("test prospect cannot send email", async () => {
  const lead = buildManualLead(validateManualProspectInput({ companyName: "Acme HVAC", websiteUrl: "acme.example" }), { id: "lead-test" });
  const task = { id: "task-1", leadId: lead.id, business: lead.business, channel: "email", status: "Approved - not sent", to: "owner@example.com", body: "Subject: Test\n\nHi" };
  const state = { leads: [lead], approvalQueue: [task], auditLog: [] };
  const result = await sendTaskNow(state, task.id);
  assert.equal(result.sent, false);
  assert.equal(result.blocked, true);
  assert.equal(task.status, "Blocked - Manual Test");
});

test("test prospect cannot start follow-ups", () => {
  const lead = buildManualLead(validateManualProspectInput({ companyName: "Manual HVAC", websiteUrl: "manual.example" }), { id: "lead-follow" });
  const sentAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const state = {
    leads: [lead],
    approvalQueue: [{ id: "task-sent", leadId: lead.id, business: lead.business, channel: "email", title: "Cold Email", status: "Sent", sentAt }],
    sending: { metrics: { followUpsGenerated: 0 } }
  };
  const generated = generateFollowUps(state, { now: new Date() });
  assert.equal(generated.length, 0);
});

test("conversion to real prospect requires confirmation", () => {
  const lead = buildManualLead(validateManualProspectInput({ companyName: "Real Later", websiteUrl: "real.example" }), { id: "lead-real" });
  assert.throws(() => convertManualProspectToReal(lead, { confirmed: false }), /confirmation/i);
  convertManualProspectToReal(lead, { confirmed: true });
  assert.equal(outreachDisabled(lead), false);
  assert.equal(lead.analysis_mode, "manual_real");
});

test("website-first identity is preserved for submitted official website", () => {
  const input = validateManualProspectInput({ companyName: "Microsoft", websiteUrl: "https://www.microsoft.com", notes: "Do not use Reddit as official website" });
  const lead = buildManualLead(input, { id: "lead-web-first" });
  assert.equal(lead.website, "https://www.microsoft.com/");
  assert.equal(lead.source_type, "manual");
  assert.notEqual(lead.website, "https://reddit.com/r/microsoft");
});
