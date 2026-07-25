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
