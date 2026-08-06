const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  IDENTITY_STATUS,
  assertDraftIdentity,
  auditAndMarkIdentityRecords,
  isIdentityVerified,
  newLeadId,
  validateIdentityChain,
  verifyBusinessIdentity
} = require("../lead-engine/businessIdentity");
const {
  registerLeadForVerification,
  stripClientVerificationClaims
} = require("../lead-engine/leadRegistration");
const {
  approveQueuedBrainTwoTask,
  assertAuthorizedSend,
  draftHash,
  queueApprovedBrainTwoDraft
} = require("../lead-engine/outboundPipeline");
const { applyBrainTwoReviewState, evaluateBrainTwoEligibility } = require("../lead-engine/brainTwoService");

function scan(overrides = {}) {
  return {
    ok: true,
    url: "https://dmmechanical.com",
    pageTitles: ["DM Mechanical | Heating and Air Conditioning"],
    businessNameCandidates: ["DM Mechanical"],
    metaDescriptions: ["DM Mechanical provides HVAC and emergency air conditioning repair."],
    serviceKeywords: ["hvac", "air conditioning", "emergency service"],
    industryEvidence: ["hvac", "air conditioning"],
    emails: ["service@dmmechanical.com"],
    emailEvidence: [{
      email: "service@dmmechanical.com",
      sourceUrl: "https://dmmechanical.com/contact",
      sourceType: "official-website",
      verifiedOfficialProfile: false
    }],
    ...overrides
  };
}

function verifiedLead(overrides = {}) {
  const lead = {
    id: "lead-dm",
    business: "DM Mechanical",
    searchTrade: "HVAC",
    trade: "HVAC",
    verifiedIndustry: "HVAC",
    industryVerified: true,
    website: "https://dmmechanical.com",
    email: "service@dmmechanical.com",
    emailSourceUrl: "https://dmmechanical.com/contact",
    timeline: [],
    ...overrides
  };
  lead.identityVerification = overrides.identityVerification || verifyBusinessIdentity({ lead, scan: scan(), email: lead.email });
  return lead;
}

function brainOne(leadId = "lead-dm") {
  return {
    id: "brain1-dm",
    businessId: leadId,
    executionStatus: "completed",
    approvalStatus: "approved-for-crm-brain-two",
    inputSnapshot: {
      businessIdentity: { businessId: leadId, businessName: "DM Mechanical", websiteUrl: "https://dmmechanical.com", trade: "HVAC" },
      evidenceLog: [{ id: "ev-dm", sourceUrl: "https://dmmechanical.com/contact", excerpt: "HVAC emergency service" }]
    },
    validatedOutput: {
      evidence_log: [{ id: "ev-dm", source_url: "https://dmmechanical.com/contact", excerpt: "HVAC emergency service" }]
    }
  };
}

function brainTwo(leadId = "lead-dm") {
  return {
    id: "brain2-dm",
    businessId: leadId,
    brainOneRunId: "brain1-dm",
    executionStatus: "completed",
    approvalStatus: "approved",
    output: {
      first_email: {
        subject: "Quick question for DM Mechanical",
        body: "Hi DM Mechanical team,\n\nI noticed your emergency air conditioning page. Worth a quick look?",
        evidence_ids: ["ev-dm"]
      },
      email_quality_gate: { passed: true, status: "READY TO REVIEW", quality_score: 94, human_score: 93 },
      follow_up_emails: [],
      brain_three_handoff: { lead_id: leadId }
    }
  };
}

function stateFixture() {
  const lead = verifiedLead();
  const one = brainOne();
  const two = brainTwo();
  return {
    lead,
    one,
    two,
    state: { leads: [lead], brainOneRuns: [one], brainTwoRuns: [two], approvalQueue: [], outboundApprovals: [], auditLog: [] }
  };
}

test("immutable discovery IDs do not depend on array position", () => {
  const candidate = { sourceId: "brave-result-1", business: "DM Mechanical", website: "https://dmmechanical.com", city: "Austin" };
  assert.equal(newLeadId(candidate), newLeadId(candidate));
  assert.match(newLeadId(candidate), /^lead_[a-f0-9]{20}$/);
});

test("official website email is correctly linked", () => {
  const result = verifyBusinessIdentity({ lead: verifiedLead({ identityVerification: null }), scan: scan(), email: "service@dmmechanical.com" });
  assert.equal(result.status, IDENTITY_STATUS.VERIFIED);
  assert.equal(result.emailSourceUrl, "https://dmmechanical.com/contact");
});

test("Houston domain-matching email is verified without requiring a separate page mention", () => {
  const lead = {
    id: "lead-houston",
    business: "Houston Heating & Cooling",
    searchTrade: "HVAC",
    trade: "HVAC",
    website: "https://gohoustonhvac.com/",
    email: "admin@gohoustonhvac.com"
  };
  const websiteScan = scan({
    url: lead.website,
    pageTitles: ["Houston Heating & Cooling | HVAC Services"],
    businessNameCandidates: ["Houston Heating & Cooling"],
    emails: [],
    emailEvidence: []
  });
  const result = verifyBusinessIdentity({ lead, scan: websiteScan, email: lead.email });
  assert.equal(result.status, IDENTITY_STATUS.VERIFIED);
  assert.equal(result.recipientEmail, lead.email);
  assert.equal(result.websiteDomain, "gohoustonhvac.com");
});

test("generic mailbox on the verified business domain is accepted", () => {
  const lead = verifiedLead({ email: "hello@dmmechanical.com", identityVerification: null });
  const result = verifyBusinessIdentity({
    lead,
    scan: scan({ emails: [], emailEvidence: [] }),
    email: lead.email
  });
  assert.equal(result.status, IDENTITY_STATUS.VERIFIED);
});

test("different-domain email is accepted only when the verified website publishes it", () => {
  const lead = verifiedLead({ email: "dispatch@service-office.com", identityVerification: null });
  const unsupported = verifyBusinessIdentity({
    lead,
    scan: scan({ emails: [], emailEvidence: [] }),
    email: lead.email
  });
  const supported = verifyBusinessIdentity({
    lead,
    scan: scan({
      emails: [lead.email],
      emailEvidence: [{ email: lead.email, sourceUrl: "https://dmmechanical.com/contact", sourceType: "official-website" }]
    }),
    email: lead.email
  });
  assert.equal(unsupported.status, IDENTITY_STATUS.NEEDS_REVIEW);
  assert.equal(supported.status, IDENTITY_STATUS.VERIFIED);
});

test("malformed email cannot pass business identity verification", () => {
  const lead = verifiedLead({ email: "admin@dmmechanical", identityVerification: null });
  const result = verifyBusinessIdentity({
    lead,
    scan: scan({ emails: [lead.email], emailEvidence: [] }),
    email: lead.email
  });
  assert.equal(result.status, IDENTITY_STATUS.NEEDS_REVIEW);
  assert.match(result.reasons.join(" "), /malformed/i);
});
test("Gmail address published on the official website is accepted", () => {
  const lead = verifiedLead({ email: "dmmechanical@gmail.com", emailSourceUrl: "https://dmmechanical.com/contact", identityVerification: null });
  const websiteScan = scan({
    emails: [lead.email],
    emailEvidence: [{ email: lead.email, sourceUrl: "https://dmmechanical.com/contact", sourceType: "official-website" }]
  });
  const result = verifyBusinessIdentity({ lead, scan: websiteScan, email: lead.email });
  assert.equal(result.status, IDENTITY_STATUS.VERIFIED_FREE_EMAIL);
  assert.equal(isIdentityVerified(result), true);
});

test("unrelated directory email is rejected", () => {
  const lead = verifiedLead({ email: "listing@yelp.com", identityVerification: null });
  const result = verifyBusinessIdentity({
    lead,
    scan: scan({ emails: [lead.email], emailEvidence: [{ email: lead.email, sourceUrl: "https://yelp.com/biz/dm", sourceType: "directory" }] }),
    email: lead.email
  });
  assert.equal(result.status, IDENTITY_STATUS.REJECTED);
});

test("conflicting custom email domain without supporting evidence needs review", () => {
  const lead = verifiedLead({ email: "luciano@latinotype.com", identityVerification: null });
  const result = verifyBusinessIdentity({ lead, scan: scan(), email: lead.email });
  assert.equal(result.status, IDENTITY_STATUS.NEEDS_REVIEW);
});

test("search snippets cannot establish verified identity alone", () => {
  const lead = verifiedLead({ identityVerification: null });
  const result = verifyBusinessIdentity({ lead, scan: { ok: false, url: lead.website, pageTitles: [lead.business], emails: [lead.email] }, email: lead.email });
  assert.equal(result.status, IDENTITY_STATUS.NEEDS_REVIEW);
});

test("search category does not become verified industry without website evidence", () => {
  const lead = verifiedLead({ identityVerification: null });
  const result = verifyBusinessIdentity({
    lead,
    scan: scan({ pageTitles: ["DM Mechanical | Type Design"], metaDescriptions: ["Fonts and typography"], serviceKeywords: [], industryEvidence: [] }),
    email: lead.email
  });
  assert.equal(result.status, IDENTITY_STATUS.NEEDS_REVIEW);
  assert.equal(result.confirmedIndustry, "");
});

test("website business-name mismatch is rejected", () => {
  const lead = verifiedLead({ identityVerification: null });
  const result = verifyBusinessIdentity({
    lead,
    scan: scan({ url: "https://latinotype.com", pageTitles: ["Latinotype"], businessNameCandidates: ["Latinotype"] }),
    email: "luciano@latinotype.com"
  });
  assert.equal(result.status, IDENTITY_STATUS.REJECTED);
  assert.match(result.reasons.join(" "), /business name/i);
});

test("Brain Two cannot run before website identity verification completes", () => {
  const result = evaluateBrainTwoEligibility({
    lead: verifiedLead({ identityVerification: { status: "Needs Review" }, verifiedIndustry: "", industryVerified: false }),
    brainOneRun: brainOne()
  });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /identity is not verified/i);
});

test("Brain and approval records cannot reference a different leadId", () => {
  const { state } = stateFixture();
  assert.throws(() => validateIdentityChain({ lead: state.leads[0], brainOneRun: brainOne("lead-other") }), /identity mismatch/i);
  assert.throws(() => applyBrainTwoReviewState(state, { runId: "brain2-dm", leadId: "lead-other", approved: true }), /identity mismatch/i);
});

test("outbound identity requires the exact linked Brain Zero run when present", () => {
  const { state, lead, one, two } = stateFixture();
  one.brainZeroRunId = "brain0-dm";
  state.brainZeroRuns = [{ run_id: "brain0-dm", business_id: lead.id, status: "completed" }];
  assert.throws(() => assertDraftIdentity({ state, lead, brainOneRun: one, brainTwoRun: two, draft: two.output.first_email }), /identity mismatch/i);
  assert.throws(() => assertDraftIdentity({
    state,
    lead,
    brainZeroRun: { run_id: "brain0-other", business_id: lead.id, status: "completed" },
    brainOneRun: one,
    brainTwoRun: two,
    draft: two.output.first_email
  }), /identity mismatch/i);
  assert.doesNotThrow(() => assertDraftIdentity({
    state,
    lead,
    brainZeroRun: state.brainZeroRuns[0],
    brainOneRun: one,
    brainTwoRun: two,
    draft: two.output.first_email
  }));
});
test("Quality Gate blocks business-name and industry mismatches", () => {
  const { state, lead, one, two } = stateFixture();
  assert.throws(() => assertDraftIdentity({
    state,
    lead,
    brainOneRun: one,
    brainTwoRun: two,
    task: { leadId: lead.id, business: "Another Company", to: lead.email },
    draft: two.output.first_email
  }), /identity mismatch/i);
  const wrongIndustry = verifiedLead({ trade: "Plumbing" });
  assert.throws(() => assertDraftIdentity({ state: { ...state, leads: [wrongIndustry] }, lead: wrongIndustry, brainOneRun: one, brainTwoRun: two, draft: two.output.first_email }), /identity mismatch/i);
});

test("exact DM Mechanical and latinotype recipient regression blocks approval", () => {
  const { state, lead, two } = stateFixture();
  const task = {
    id: "task-mismatch",
    leadId: lead.id,
    business: "DM Mechanical",
    channel: "email",
    source: "brain-two-quality-gate",
    brainTwoRunId: two.id,
    brainOneRunId: two.brainOneRunId,
    sequenceStep: "initial-email",
    subject: "Quick question for DM Mechanical",
    body: "Subject: Quick question for DM Mechanical\n\nMechanical and emergency-service outreach",
    to: "luciano@latinotype.com",
    recipient: "luciano@latinotype.com",
    status: "Needs Approval"
  };
  state.approvalQueue.push(task);
  assert.throws(() => approveQueuedBrainTwoTask(state, { taskId: task.id }), /identity mismatch/i);
  assert.equal(task.status, "Needs Approval");
});

test("exact DM Mechanical and latinotype recipient regression blocks sending", () => {
  const { state, lead, two } = stateFixture();
  const task = {
    id: "task-send-mismatch",
    leadId: lead.id,
    business: "DM Mechanical",
    channel: "email",
    source: "brain-two-quality-gate",
    brainTwoRunId: two.id,
    brainOneRunId: two.brainOneRunId,
    sequenceStep: "initial-email",
    subject: "Quick question for DM Mechanical",
    body: "Subject: Quick question for DM Mechanical\n\nMechanical and emergency-service outreach",
    to: "luciano@latinotype.com",
    recipient: "luciano@latinotype.com",
    status: "Approved"
  };
  const parts = { subject: task.subject, body: "Mechanical and emergency-service outreach", recipient: task.to };
  const approval = { id: "approval-mismatch", taskId: task.id, leadId: lead.id, brainTwoRunId: two.id, status: "approved", draftHash: draftHash(parts), consumedAt: "" };
  task.approvalId = approval.id;
  task.approvedDraftHash = approval.draftHash;
  state.approvalQueue.push(task);
  state.outboundApprovals.push(approval);
  assert.throws(() => assertAuthorizedSend(state, task), /identity mismatch/i);
});

test("a correctly bound verified Brain Two draft can be queued", () => {
  const { state, lead, two } = stateFixture();
  state.brainOneRuns[0].brainZeroRunId = "brain0-dm";
  state.brainZeroRuns = [{ run_id: "brain0-dm", business_id: lead.id, status: "completed" }];
  const result = queueApprovedBrainTwoDraft(state, { run: two, lead, reviewer: "Tester" });
  assert.equal(result.task.leadId, lead.id);
  assert.equal(result.task.to, lead.email);
  assert.equal(result.task.identityVerification.identity, IDENTITY_STATUS.VERIFIED);
});

test("existing stale drafts and approvals are marked for re-verification", () => {
  const lead = { id: "legacy-lead", business: "Legacy", trade: "HVAC", website: "https://legacy.example", email: "other@example.net" };
  const task = { id: "legacy-task", leadId: lead.id, business: lead.business, to: lead.email, status: "Approved" };
  const approval = { id: "legacy-approval", taskId: task.id, leadId: lead.id, status: "approved", consumedAt: "" };
  const state = { leads: [lead], approvalQueue: [task], outboundApprovals: [approval] };
  const report = auditAndMarkIdentityRecords(state);
  assert.equal(report.leadsMarked, 1);
  assert.equal(task.status, "Needs Re-verification");
  assert.equal(approval.status, "revoked");
});

test("review UI clears content and ignores stale async responses", () => {
  const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
  assert.match(html, /const requestId = \+\+composerRequestId/);
  assert.match(html, /requestId !== composerRequestId \|\| composerTaskId !== taskId/);
  assert.match(html, /composerRecipient"\)\.value = ""/);
  assert.match(html, /setComposerActions\(false\)/);
  assert.match(html, /\/api\/outbound-review\?taskId=/);
});

test("missing discovery lead is registered atomically before website verification", () => {
  const state = { leads: [] };
  const snapshot = {
    id: "lead-race",
    business: "Race HVAC",
    website: "https://race-hvac.example",
    trade: "HVAC",
    email: "service@race-hvac.example",
    identityVerification: { status: IDENTITY_STATUS.VERIFIED, verified: true },
    verifiedIndustry: "HVAC",
    industryVerified: true,
    brainTwoLatestRunId: "forged-run"
  };
  const result = registerLeadForVerification(state, {
    leadId: snapshot.id,
    snapshot,
    now: "2026-07-25T12:00:00.000Z"
  });
  assert.equal(result.created, true);
  assert.equal(result.lead.id, snapshot.id);
  assert.equal(result.lead.identityVerification, null);
  assert.equal(result.lead.identityStatus, "Needs Re-verification");
  assert.equal(result.lead.verifiedIndustry, "");
  assert.equal(result.lead.industryVerified, false);
  assert.equal(result.lead.brainTwoLatestRunId, undefined);
});

test("verification registration reuses an exact immutable lead ID without duplication", () => {
  const existing = { id: "lead-existing", business: "Existing HVAC", website: "https://existing.example" };
  const state = { leads: [existing] };
  const result = registerLeadForVerification(state, {
    leadId: existing.id,
    snapshot: { ...existing, business: "Client Override" }
  });
  assert.equal(result.created, false);
  assert.equal(result.lead, existing);
  assert.equal(state.leads.length, 1);
  assert.equal(existing.business, "Existing HVAC");
});

test("verification registration rejects a different lead ID for the same website", () => {
  const state = { leads: [{ id: "lead-a", business: "Safe HVAC", website: "https://safe.example" }] };
  assert.throws(() => registerLeadForVerification(state, {
    leadId: "lead-b",
    snapshot: { id: "lead-b", business: "Safe HVAC", website: "https://safe.example" }
  }), /identity mismatch/i);
  assert.equal(state.leads.length, 1);
});

test("CRM synchronization cannot import browser-side verification claims", () => {
  const safe = stripClientVerificationClaims({
    id: "lead-client",
    business: "Client HVAC",
    website: "https://client.example",
    identityVerification: { status: IDENTITY_STATUS.VERIFIED, verified: true },
    identityStatus: IDENTITY_STATUS.VERIFIED,
    verifiedIndustry: "HVAC",
    industryVerified: true,
    emailSourceUrl: "https://client.example/contact",
    brainOneLatestRunId: "client-run"
  });
  assert.equal(safe.id, "lead-client");
  assert.equal(safe.business, "Client HVAC");
  assert.equal(safe.identityVerification, undefined);
  assert.equal(safe.identityStatus, undefined);
  assert.equal(safe.verifiedIndustry, undefined);
  assert.equal(safe.industryVerified, undefined);
  assert.equal(safe.emailSourceUrl, undefined);
  assert.equal(safe.brainOneLatestRunId, undefined);
});
test("server verification route registers a missing lead before scanning and strips client claims during CRM sync", () => {
  const server = fs.readFileSync(require.resolve("../callcatch-lead-server.js"), "utf8");
  assert.match(server, /registerLeadForVerification\(state, \{\s*leadId,\s*snapshot: body\.lead/);
  assert.match(server, /const storedLead = registration\.lead;\s*const scan = await scanWebsite\(storedLead\.website\);/);
  assert.match(server, /const safeLead = stripClientVerificationClaims\(\{ \.\.\.lead, id \}\);/);
});
