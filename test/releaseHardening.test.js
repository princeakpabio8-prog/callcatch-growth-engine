const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  assertProductionSecurityReady,
  authenticate,
  originAllowed,
  routeAccess,
  verifyResendWebhook
} = require("../lead-engine/security");
const {
  approveQueuedBrainTwoTask,
  assertAuthorizedSend,
  queueApprovedBrainTwoDraft
} = require("../lead-engine/outboundPipeline");

const OPERATOR = "operator-token-with-more-than-24-chars";
const ADMIN = "administrator-token-with-more-than-24-chars";

function env(overrides = {}) {
  return {
    NODE_ENV: "production",
    EMAIL_PROVIDER: "resend",
    CALLCATCH_OPERATOR_TOKEN: OPERATOR,
    CALLCATCH_ADMIN_TOKEN: ADMIN,
    CALLCATCH_ALLOWED_ORIGINS: "https://app.example.test",
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("webhook-test-secret-value").toString("base64")}`,
    ...overrides
  };
}

function qualityGate() {
  return { passed: true, status: "READY TO REVIEW", quality_score: 92, human_score: 94 };
}

function approvedBrainTwoState() {
  const lead = {
    id: "lead-1",
    business: "Reliable HVAC",
    email: "owner@reliable.test",
    website: "https://reliable.test",
    trade: "HVAC",
    verifiedIndustry: "HVAC",
    industryVerified: true,
    emailSourceUrl: "https://reliable.test/contact",
    identityVerification: {
      status: "Verified",
      verified: true,
      leadId: "lead-1",
      businessName: "Reliable HVAC",
      canonicalWebsite: "https://reliable.test",
      websiteDomain: "reliable.test",
      recipientEmail: "owner@reliable.test",
      emailDomain: "reliable.test",
      emailSourceUrl: "https://reliable.test/contact",
      confirmedIndustry: "HVAC"
    },
    stage: "New",
    timeline: []
  };
  const brainOneRun = {
    id: "brain1-1",
    businessId: lead.id,
    executionStatus: "completed",
    approvalStatus: "approved-for-crm-brain-two",
    inputSnapshot: {
      businessIdentity: { businessId: lead.id, businessName: lead.business, websiteUrl: lead.website, trade: lead.trade },
      evidenceLog: [{ id: "ev-reliable", sourceUrl: lead.emailSourceUrl, excerpt: "Emergency HVAC service" }]
    }
  };
  const run = {
    id: "brain2-1",
    businessId: lead.id,
    brainOneRunId: brainOneRun.id,
    executionStatus: "completed",
    approvalStatus: "approved",
    output: {
      status: "READY",
      first_email: { subject: "One observation", body: "I noticed your emergency service page. Missed callers may move on quickly. Worth a quick look?", evidence_ids: ["ev-reliable"] },
      email_quality_gate: qualityGate(),
      follow_up_emails: [{ step: 1, subject: "A useful thought", body: "One useful idea for handling calls after hours. Happy to show you.", evidence_ids: ["ev-reliable"], quality_gate: qualityGate() }],
      brain_three_handoff: { lead_id: lead.id }
    }
  };
  return { leads: [lead], brainOneRuns: [brainOneRun], brainTwoRuns: [run], approvalQueue: [], outboundApprovals: [], auditLog: [], lead, run };
}
test("route access keeps only health and static files public", () => {
  assert.equal(routeAccess("GET", "/health"), "public");
  assert.equal(routeAccess("GET", "/api/crm"), "operator");
  assert.equal(routeAccess("POST", "/api/sending/send-now"), "operator");
  assert.equal(routeAccess("GET", "/api/audit-log"), "admin");
  assert.equal(routeAccess("POST", "/api/webhooks/resend/inbound"), "webhook");
});

test("operator and administrator permissions are enforced with timing-safe tokens", () => {
  assert.equal(authenticate({ authorization: `Bearer ${OPERATOR}` }, "operator", env()).ok, true);
  assert.equal(authenticate({ authorization: `Bearer ${OPERATOR}` }, "admin", env()).ok, false);
  assert.equal(authenticate({ authorization: `Bearer ${ADMIN}` }, "admin", env()).ok, true);
  assert.equal(authenticate({}, "operator", env()).ok, false);
});

test("production security rejects missing, short, or shared credentials", () => {
  assert.throws(() => assertProductionSecurityReady(env({ CALLCATCH_OPERATOR_TOKEN: "" })), /CALLCATCH_OPERATOR_TOKEN/);
  assert.throws(() => assertProductionSecurityReady(env({ CALLCATCH_ADMIN_TOKEN: OPERATOR })), /must be different/);
  assert.throws(() => assertProductionSecurityReady(env({ CALLCATCH_ALLOWED_ORIGINS: "" })), /CALLCATCH_ALLOWED_ORIGINS/);
});

test("CORS allows only configured production origins", () => {
  assert.equal(originAllowed("https://app.example.test", env()), true);
  assert.equal(originAllowed("https://attacker.example", env()), false);
  assert.equal(originAllowed("", env()), true);
});

test("CORS allows the production backend to serve its own dashboard without widening external origins", () => {
  const backend = "https://callcatch-growth-engine-production.up.railway.app";
  assert.equal(originAllowed(backend, env(), backend), true);
  assert.equal(originAllowed(`${backend}/`, env(), backend), true);
  assert.equal(originAllowed("https://attacker.example", env(), backend), false);
});

test("Resend webhook verification rejects unsigned and forged requests", () => {
  const config = env();
  const rawBody = JSON.stringify({ type: "email.delivered", data: { email_id: "email-1" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = "msg_webhook_1";
  const key = Buffer.from(config.RESEND_WEBHOOK_SECRET.slice(6), "base64");
  const signature = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  assert.equal(verifyResendWebhook({ rawBody, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }, secret: config.RESEND_WEBHOOK_SECRET }).ok, true);
  assert.equal(verifyResendWebhook({ rawBody, headers: {}, secret: config.RESEND_WEBHOOK_SECRET }).code, "WEBHOOK_SIGNATURE_MISSING");
  assert.equal(verifyResendWebhook({ rawBody: `${rawBody} `, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }, secret: config.RESEND_WEBHOOK_SECRET }).code, "WEBHOOK_SIGNATURE_INVALID");
});

test("Brain Two approval creates exactly one immutable authoritative task", () => {
  const state = approvedBrainTwoState();
  const first = queueApprovedBrainTwoDraft(state, { run: state.run, lead: state.lead, reviewer: "Prince" });
  const second = queueApprovedBrainTwoDraft(state, { run: state.run, lead: state.lead, reviewer: "Prince" });
  assert.equal(state.approvalQueue.length, 1);
  assert.equal(state.outboundApprovals.length, 1);
  assert.equal(first.task.source, "brain-two-quality-gate");
  assert.equal(first.task.status, "Approved");
  assert.equal(second.duplicate, true);
  assert.doesNotThrow(() => assertAuthorizedSend(state, first.task));
  first.task.body += " Changed after approval.";
  assert.throws(() => assertAuthorizedSend(state, first.task), /changed after approval/);
});

test("client-created and legacy approved tasks can never pass the send gate", () => {
  const state = approvedBrainTwoState();
  const task = { id: "legacy", leadId: state.lead.id, channel: "email", status: "Approved", to: state.lead.email, body: "Subject: Test\n\nBody" };
  state.approvalQueue.push(task);
  assert.throws(() => assertAuthorizedSend(state, task), /Legacy and client-created drafts/);
});

test("follow-up approval requires the stored Brain Two quality gate", () => {
  const state = approvedBrainTwoState();
  queueApprovedBrainTwoDraft(state, { run: state.run, lead: state.lead, reviewer: "Prince" });
  const task = {
    id: "followup-1",
    leadId: state.lead.id,
    business: state.lead.business,
    channel: "email",
    source: "brain-two-quality-gate",
    brainTwoRunId: state.run.id,
    sequenceStep: "followup-1",
    subject: state.run.output.follow_up_emails[0].subject,
    body: `Subject: ${state.run.output.follow_up_emails[0].subject}\n\n${state.run.output.follow_up_emails[0].body}`,
    to: state.lead.email,
    recipient: state.lead.email,
    status: "Needs Approval"
  };
  state.approvalQueue.push(task);
  const approved = approveQueuedBrainTwoTask(state, { taskId: task.id, reviewer: "Prince" });
  assert.equal(approved.task.status, "Approved");
  assert.doesNotThrow(() => assertAuthorizedSend(state, task));
});

test("server and datastore source preserve manual-only and transactional boundaries", () => {
  const root = path.join(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "callcatch-lead-server.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "lead-engine", "dataStore.js"), "utf8");
  assert.match(server, /Automatic sequence sending is disabled/);
  assert.match(server, /Test sends are disabled/);
  assert.doesNotMatch(server, /requiresApiKey:\s*false/);
  assert.doesNotMatch(server, /setInterval\(runBackgroundAutomation/);
  assert.match(store, /SELECT data FROM callcatch_state WHERE id = \$1 FOR UPDATE/);
  assert.match(store, /writeQueue = pending\.then\(\(\) => undefined, \(\) => undefined\)/);
});
