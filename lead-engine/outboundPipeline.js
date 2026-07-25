const crypto = require("crypto");
const { assertDraftIdentity } = require("./businessIdentity");

const SOURCE = "brain-two-quality-gate";

function clean(value = "") {
  return String(value || "").trim();
}

function newRecordId(prefix = "record") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function draftHash({ subject = "", body = "", recipient = "" } = {}) {
  return crypto.createHash("sha256")
    .update([clean(subject), clean(body), clean(recipient).toLowerCase()].join("\n---\n"))
    .digest("hex");
}

function taskParts(task = {}) {
  const text = String(task.body || "");
  const lines = text.split(/\r?\n/);
  const subjectLine = lines.find(line => /^subject:/i.test(line));
  return {
    subject: clean(task.subject || (subjectLine ? subjectLine.replace(/^subject:\s*/i, "") : task.title)),
    body: clean(subjectLine ? lines.filter(line => line !== subjectLine).join("\n") : text),
    recipient: clean(task.to || task.recipient)
  };
}

function qualityGateReady(output = {}, sequenceStep = "initial-email") {
  if (sequenceStep === "initial-email") {
    const gate = output.email_quality_gate || {};
    return gate.passed === true
      && gate.status === "READY TO REVIEW"
      && Number(gate.quality_score || 0) >= 85
      && Number(gate.human_score || 0) >= 85;
  }
  const followUp = (output.follow_up_emails || []).find(item => String(item.step) === String(sequenceStep).replace("followup-", ""));
  const gate = followUp?.quality_gate || {};
  return Boolean(followUp && gate.passed === true && gate.status === "READY TO REVIEW");
}

function brainTwoDraft(run = {}, sequenceStep = "initial-email") {
  const output = run.output || {};
  if (sequenceStep === "initial-email") return output.first_email || {};
  const step = String(sequenceStep).replace("followup-", "");
  return (output.follow_up_emails || []).find(item => String(item.step) === step) || {};
}

function ensureCollections(state = {}) {
  state.approvalQueue = state.approvalQueue || [];
  state.outboundApprovals = state.outboundApprovals || [];
  state.auditLog = state.auditLog || [];
}

function identityRuns(state = {}, brainTwoRun = {}) {
  const brainOneRun = (state.brainOneRuns || []).find(item => item.id === brainTwoRun.brainOneRunId);
  const brainZeroRun = brainOneRun?.brainZeroRunId
    ? (state.brainZeroRuns || []).find(item => item.run_id === brainOneRun.brainZeroRunId || item.id === brainOneRun.brainZeroRunId)
    : null;
  return { brainOneRun, brainZeroRun };
}

function createApproval(state, { run, lead, task, reviewer, reviewedAt }) {
  const parts = taskParts(task);
  const hash = draftHash(parts);
  const approval = {
    id: newRecordId("approval"),
    taskId: task.id,
    leadId: lead.id,
    brainTwoRunId: run.id,
    sequenceStep: task.sequenceStep,
    draftHash: hash,
    recipient: parts.recipient,
    approvedBy: reviewer,
    approvedAt: reviewedAt,
    identityStatus: lead.identityVerification?.status || "",
    status: "approved",
    consumedAt: ""
  };
  state.outboundApprovals.unshift(approval);
  task.approvalId = approval.id;
  task.approvedAt = reviewedAt;
  task.approvedBy = reviewer;
  task.approvedDraftHash = hash;
  task.sendIdempotencyKey = `callcatch-${approval.id}`.slice(0, 200);
  task.status = "Approved";
  return approval;
}

function queueApprovedBrainTwoDraft(state = {}, { run, lead, reviewer = "CallCatch user", reviewedAt = new Date().toISOString() } = {}) {
  ensureCollections(state);
  if (!run || run.executionStatus !== "completed" || run.approvalStatus !== "approved") throw new Error("Brain Two must be completed and approved before queueing");
  if (!lead?.id) throw new Error("Lead not found");
  if (!qualityGateReady(run.output, "initial-email")) throw new Error("Brain Two Quality Gate did not mark this draft ready for review");
  const existing = state.approvalQueue.find(item => item.brainTwoRunId === run.id && item.sequenceStep === "initial-email");
  if (existing) return { task: existing, approval: state.outboundApprovals.find(item => item.id === existing.approvalId), duplicate: true };
  const draft = brainTwoDraft(run, "initial-email");
  const recipient = clean(lead.email);
  if (!recipient) throw new Error("A verified recipient email is required before Brain Two approval");
  const task = {
    id: newRecordId("task"),
    leadId: lead.id,
    business: lead.business || "",
    channel: "email",
    source: SOURCE,
    brainTwoRunId: run.id,
    brainOneRunId: run.brainOneRunId || "",
    sequenceStep: "initial-email",
    subject: clean(draft.subject),
    title: clean(draft.subject) || "Brain Two outreach",
    body: `Subject: ${clean(draft.subject)}\n\n${clean(draft.body)}`,
    to: recipient,
    recipient,
    status: "Draft",
    createdAt: reviewedAt,
    qualityGate: run.output.email_quality_gate
  };
  const { brainOneRun, brainZeroRun } = identityRuns(state, run);
  task.identityVerification = assertDraftIdentity({
    state,
    lead,
    brainOneRun,
    brainTwoRun: run,
    task,
    draft
  });
  state.approvalQueue.unshift(task);
  const approval = createApproval(state, { run, lead, task, reviewer, reviewedAt });
  state.auditLog.unshift({ id: newRecordId("audit"), at: reviewedAt, action: "outbound_draft_approved", details: { approvalId: approval.id, taskId: task.id, leadId: lead.id, brainTwoRunId: run.id, sequenceStep: task.sequenceStep } });
  return { task, approval, duplicate: false };
}

function approveQueuedBrainTwoTask(state = {}, { taskId, reviewer = "CallCatch user", reviewedAt = new Date().toISOString() } = {}) {
  ensureCollections(state);
  const task = state.approvalQueue.find(item => item.id === taskId);
  if (!task) throw new Error("Task not found");
  if (task.source !== SOURCE || !task.brainTwoRunId) throw new Error("Only Brain Two Quality Gate drafts can be approved");
  if (["Sent", "Delivered", "Opened", "Replied", "Bounced"].includes(task.status)) throw new Error("A completed delivery cannot be approved again");
  const existing = state.outboundApprovals.find(item => item.id === task.approvalId && item.status === "approved");
  if (existing) {
    task.status = "Approved";
    task.error = "";
    return { task, approval: existing, duplicate: true };
  }
  const run = (state.brainTwoRuns || []).find(item => item.id === task.brainTwoRunId);
  const lead = (state.leads || []).find(item => item.id === task.leadId);
  const { brainOneRun, brainZeroRun } = identityRuns(state, run || {});
  if (!run || run.approvalStatus !== "approved") throw new Error("The source Brain Two report is not approved");
  if (!lead) throw new Error("Lead not found");
  if (!qualityGateReady(run.output, task.sequenceStep)) throw new Error("The Quality Gate did not approve this draft");
  task.identityVerification = assertDraftIdentity({ state, lead, brainZeroRun, brainOneRun, brainTwoRun: run, task });
  const approval = createApproval(state, { run, lead, task, reviewer, reviewedAt });
  state.auditLog.unshift({ id: newRecordId("audit"), at: reviewedAt, action: "outbound_draft_approved", details: { approvalId: approval.id, taskId: task.id, leadId: task.leadId, brainTwoRunId: run.id, sequenceStep: task.sequenceStep } });
  return { task, approval, duplicate: false };
}

function queueDueBrainTwoFollowUps(state = {}, { now = new Date() } = {}) {
  ensureCollections(state);
  const generated = [];
  const currentTime = now instanceof Date ? now : new Date(now);
  const runs = state.brainTwoRuns || [];
  for (const run of runs.filter(item => item.executionStatus === "completed" && item.approvalStatus === "approved")) {
    const initial = state.approvalQueue.find(item => item.brainTwoRunId === run.id && item.sequenceStep === "initial-email" && ["Sent", "Delivered", "Opened", "Replied"].includes(item.status));
    if (!initial?.sentAt) continue;
    const lead = (state.leads || []).find(item => item.id === run.businessId);
    if (!lead || (lead.replies || []).length || ["Interested", "Demo Scheduled", "Trial Started", "Customer", "Lost"].includes(lead.stage)) continue;
    const followUps = run.output?.follow_up_emails || [];
    for (let index = 0; index < followUps.length; index += 1) {
      const step = index + 1;
      const sequenceStep = `followup-${step}`;
      const existing = state.approvalQueue.find(item => item.brainTwoRunId === run.id && item.sequenceStep === sequenceStep);
      if (existing) {
        if (!["Sent", "Delivered", "Opened", "Replied"].includes(existing.status)) break;
        continue;
      }
      if (index > 0) {
        const prior = state.approvalQueue.find(item => item.brainTwoRunId === run.id && item.sequenceStep === `followup-${index}`);
        if (!prior || !["Sent", "Delivered", "Opened", "Replied"].includes(prior.status)) break;
      }
      const draft = followUps[index] || {};
      const dueDays = Math.max(1, Number(draft.recommended_delay_days || [3, 7, 10, 14][index]));
      const dueAt = new Date(new Date(initial.sentAt).getTime() + dueDays * 24 * 60 * 60 * 1000);
      if (dueAt > currentTime) break;
      if (!qualityGateReady(run.output, sequenceStep)) break;
      const task = {
        id: newRecordId("task"),
        leadId: lead.id,
        business: lead.business || "",
        channel: "email",
        source: SOURCE,
        brainTwoRunId: run.id,
        brainOneRunId: run.brainOneRunId || "",
        sequenceStep,
        sequenceParentTaskId: initial.id,
        subject: clean(draft.subject),
        title: clean(draft.subject) || `Brain Two follow-up ${step}`,
        body: `Subject: ${clean(draft.subject)}\n\n${clean(draft.body)}`,
        to: initial.to,
        recipient: initial.recipient,
        status: "Needs Approval",
        dueAt: dueAt.toISOString(),
        createdAt: currentTime.toISOString(),
        qualityGate: draft.quality_gate
      };
      const { brainOneRun, brainZeroRun } = identityRuns(state, run);
      task.identityVerification = assertDraftIdentity({ state, lead, brainZeroRun, brainOneRun, brainTwoRun: run, task, draft });
      state.approvalQueue.unshift(task);
      state.auditLog.unshift({ id: newRecordId("audit"), at: currentTime.toISOString(), action: "brain_two_followup_ready", details: { taskId: task.id, leadId: lead.id, brainTwoRunId: run.id, sequenceStep } });
      lead.followUpStatus = `Brain Two follow-up ${step} ready for approval`;
      lead.nextFollowUp = dueAt.toISOString().slice(0, 10);
      generated.push(task);
      break;
    }
  }
  return generated;
}

function assertAuthorizedSend(state = {}, task = {}) {
  ensureCollections(state);
  if (task.channel !== "email") throw new Error("Only approved Brain Two email drafts can be sent");
  if (task.source !== SOURCE || !task.brainTwoRunId) throw new Error("Legacy and client-created drafts are not sendable");
  if (!task.approvalId) throw new Error("A server-side approval is required before sending");
  const approval = state.outboundApprovals.find(item => item.id === task.approvalId);
  if (!approval || approval.status !== "approved") throw new Error("The stored approval is missing or no longer valid");
  if (approval.consumedAt) throw new Error("This approval has already been consumed");
  const parts = taskParts(task);
  if (draftHash(parts) !== approval.draftHash || task.approvedDraftHash !== approval.draftHash) throw new Error("The draft changed after approval and must be reviewed again");
  const run = (state.brainTwoRuns || []).find(item => item.id === task.brainTwoRunId);
  const lead = (state.leads || []).find(item => item.id === task.leadId);
  const { brainOneRun, brainZeroRun } = identityRuns(state, run || {});
  if (!run || run.approvalStatus !== "approved") throw new Error("The source Brain Two report is not approved");
  if (!lead) throw new Error("Lead not found");
  if (!qualityGateReady(run.output, task.sequenceStep)) throw new Error("The Quality Gate no longer authorizes this draft");
  const identityVerification = assertDraftIdentity({ state, lead, brainZeroRun, brainOneRun, brainTwoRun: run, task, approval });
  return { approval, run, lead, parts, identityVerification };
}

function consumeApproval(approval, at = new Date().toISOString()) {
  approval.consumedAt = at;
  approval.status = "consumed";
}

module.exports = {
  SOURCE,
  approveQueuedBrainTwoTask,
  assertAuthorizedSend,
  brainTwoDraft,
  consumeApproval,
  draftHash,
  qualityGateReady,
  queueDueBrainTwoFollowUps,
  queueApprovedBrainTwoDraft,
  taskParts
};
