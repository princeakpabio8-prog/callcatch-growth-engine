const { sendEmail, parseEmail } = require("./emailAdapter");
const { normalizePhone, sendSms } = require("./smsAdapter");
const { outreachAssets } = require("./prospectIntelligence");
const { scanWebsite } = require("./websiteScanner");
const { newId } = require("./dataStore");
const { outreachDisabled } = require("./manualProspect");

const DEFAULT_LIMITS = {
  maxPerHour: 20,
  maxPerDay: 100,
  minDelaySeconds: 45,
  maxDelaySeconds: 180
};

const MEETING_WORDS = ["let's talk", "lets talk", "interested", "can we schedule", "call me", "book", "demo", "calendar", "meeting"];
const SEQUENCE_STEPS = [
  { key: "followup-1", title: "Follow-up #1", waitDays: 3 },
  { key: "final-followup", title: "Final Follow-up", waitDays: 4 }
];

function nowIso() {
  return new Date().toISOString();
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function hourKey(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

function addTimeline(lead, text, at = nowIso()) {
  lead.timeline = lead.timeline || [];
  lead.timeline.unshift({ at, text });
}

function sendingState(state) {
  state.sending = state.sending || {};
  state.sending.limits = { ...DEFAULT_LIMITS, ...(state.sending.limits || {}) };
  state.sending.counts = state.sending.counts || { byDay: {}, byHour: {} };
  state.sending.metrics = state.sending.metrics || {
    sent: 0,
    failed: 0,
    opened: 0,
    clicked: 0,
    replies: 0,
    meetingsBooked: 0,
    followUpsGenerated: 0
  };
  state.sending.variantStats = state.sending.variantStats || {};
  state.scheduledJobs = state.scheduledJobs || [];
  return state.sending;
}

function canSendMore(state, date = new Date()) {
  const sending = sendingState(state);
  const day = todayKey(date);
  const hour = hourKey(date);
  const dayCount = sending.counts.byDay[day] || 0;
  const hourCount = sending.counts.byHour[hour] || 0;
  const hourResetAt = new Date(date);
  hourResetAt.setUTCMinutes(0, 0, 0);
  hourResetAt.setUTCHours(hourResetAt.getUTCHours() + 1);
  const dayResetAt = new Date(date);
  dayResetAt.setUTCHours(24, 0, 0, 0);
  return {
    allowed: dayCount < sending.limits.maxPerDay && hourCount < sending.limits.maxPerHour,
    dayCount,
    hourCount,
    remainingToday: Math.max(0, sending.limits.maxPerDay - dayCount),
    remainingThisHour: Math.max(0, sending.limits.maxPerHour - hourCount),
    maxPerHour: sending.limits.maxPerHour,
    maxPerDay: sending.limits.maxPerDay,
    resetHourAt: hourResetAt.toISOString(),
    resetDayAt: dayResetAt.toISOString()
  };
}

function recordSendCount(state, date = new Date()) {
  const sending = sendingState(state);
  const day = todayKey(date);
  const hour = hourKey(date);
  sending.counts.byDay[day] = (sending.counts.byDay[day] || 0) + 1;
  sending.counts.byHour[hour] = (sending.counts.byHour[hour] || 0) + 1;
  sending.metrics.sent += 1;
}

function variantBucket(state, lead, task) {
  const sending = sendingState(state);
  const trade = lead.trade || "Unknown";
  const variant = task.emailVariant || "A";
  sending.variantStats[trade] = sending.variantStats[trade] || {};
  sending.variantStats[trade][variant] = sending.variantStats[trade][variant] || {
    sent: 0,
    opened: 0,
    replies: 0,
    meetings: 0
  };
  return sending.variantStats[trade][variant];
}

function recordVariantSent(state, lead, task) {
  if (task.channel !== "email") return;
  variantBucket(state, lead, task).sent += 1;
}

function recordVariantReply(state, lead, task, meetingIntent) {
  if (!task || task.channel !== "email") return;
  const bucket = variantBucket(state, lead, task);
  bucket.replies += 1;
  if (meetingIntent) bucket.meetings += 1;
}

function randomDelaySeconds(state) {
  const limits = sendingState(state).limits;
  const min = Math.max(0, Number(limits.minDelaySeconds) || 0);
  const max = Math.max(min, Number(limits.maxDelaySeconds) || min);
  return Math.round(min + Math.random() * (max - min));
}

function parseSchedule(label) {
  const lower = String(label || "").toLowerCase().trim();
  const date = new Date();
  if (!lower) return date;

  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let hours = 9;
  let minutes = 0;
  if (timeMatch) {
    hours = Number(timeMatch[1]);
    minutes = Number(timeMatch[2] || 0);
    const suffix = timeMatch[3];
    if (suffix === "pm" && hours < 12) hours += 12;
    if (suffix === "am" && hours === 12) hours = 0;
  }
  date.setHours(hours, minutes, 0, 0);

  if (lower.includes("tomorrow")) date.setDate(date.getDate() + 1);
  if (lower.includes("next monday")) {
    const day = date.getDay();
    const daysUntilMonday = ((8 - day) % 7) || 7;
    date.setDate(date.getDate() + daysUntilMonday);
  }
  if (lower.includes("today") && date < new Date()) date.setDate(date.getDate() + 1);
  return date;
}

function approvedSendableTasks(state) {
  return (state.approvalQueue || []).filter(task => ["email", "sms"].includes(task.channel) && /^approved/i.test(task.status || ""));
}

function findLead(state, task) {
  return (state.leads || []).find(lead => lead.id === task.leadId) || {};
}

function hasLeadReply(lead) {
  return (lead.replies || []).length > 0 || ["Interested", "Demo Scheduled", "Trial Started", "Customer", "Lost"].includes(lead.stage);
}

function isInitialEmail(task = {}) {
  const title = String(task.title || "").toLowerCase();
  return task.channel === "email" && task.status === "Sent" && !title.includes("follow-up") && !title.includes("followup") && !task.sequenceStep;
}

function sequenceEmailBody(lead, stepKey) {
  const assets = outreachAssets(lead);
  const profile = assets.weakness || {};
  const city = [lead.city, lead.state].filter(Boolean).join(", ") || lead.area || "your area";
  const revenue = Number(lead.revenueOpportunityEstimate || 0);
  const revenueLine = revenue
    ? `The reason I thought it was worth flagging is that one recovered missed call every few days could represent roughly $${revenue.toLocaleString()}/month in booked work for a business like yours.`
    : `The reason I thought it was worth flagging is that even a few recovered missed callers each month can matter.`;
  const subject = stepKey === "followup-1"
    ? `Subject: Quick follow-up for ${lead.business}`
    : `Subject: Closing the loop for ${lead.business}`;
  if (stepKey === "followup-1") {
    return `${subject}\n\nHi ${lead.business} team,\n\nJust following up on my note after looking at ${lead.business} in ${city}.\n\nThe main opportunity I saw was ${profile.weakness || "missed calls"}: ${profile.pain || "new customers often move on when they cannot reach someone quickly"}.\n\n${revenueLine}\n\nWorth a quick 10-minute walkthrough this week?\n\nBest,\n\nPrince Esien\nFounder, CallCatch\nEmail: hello@callcatch.site\nWeb: https://callcatch.site\n\nHelping home service businesses recover missed revenue.`;
  }
  return `${subject}\n\nHi ${lead.business} team,\n\nI will close the loop after this.\n\nMy quick thought was simple: ${profile.proof || "CallCatch texts missed callers instantly and routes the next step back into the CRM"}.\n\nIf ${profile.weakness || "missed calls"} is already handled, no worries. If not, I can show you how the missed-caller response works in less than 10 minutes.\n\nWould Tuesday or Wednesday be a bad time?\n\nBest,\n\nPrince Esien\nFounder, CallCatch\nEmail: hello@callcatch.site\nWeb: https://callcatch.site\n\nHelping home service businesses recover missed revenue.`;
}

function followUpPlanFromTask(task = {}, lead = {}, queue = [], now = new Date()) {
  const hasReply = hasLeadReply(lead);
  const firstDueAt = task.sentAt ? addDaysIso(task.sentAt, SEQUENCE_STEPS[0].waitDays) : "";
  const firstSent = queue.find(item => item.leadId === lead.id && item.sequenceStep === "followup-1" && item.status === "Sent" && item.sentAt);
  const finalDueAt = firstSent?.sentAt ? addDaysIso(firstSent.sentAt, SEQUENCE_STEPS[1].waitDays) : "";
  const nextDueAt = hasReply ? "" : (firstSent ? finalDueAt : firstDueAt);
  const due = nextDueAt ? new Date(nextDueAt) <= now : false;
  return {
    active: !!task.sentAt && !hasReply,
    stopped: hasReply,
    initialSentAt: task.sentAt || "",
    firstFollowUpDueAt: firstDueAt,
    finalFollowUpDueAt: finalDueAt,
    nextDueAt,
    due,
    nextStep: hasReply ? "Stopped - reply received" : firstSent ? "Final follow-up" : "Follow-up #1"
  };
}

function addDaysIso(dateValue, days) {
  return new Date(new Date(dateValue).getTime() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/https?:\/\//, "").replace(/www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function taskStepKey(task = {}) {
  if (task.sequenceStep) return task.sequenceStep;
  if (task.channel === "email" && task.emailVariant) return "initial-email";
  const title = String(task.title || task.channel || "message").toLowerCase();
  if (title.includes("final")) return "final-followup";
  if (title.includes("follow")) return "followup-1";
  if (task.channel === "email" && title.includes("cold email")) return "initial-email";
  if (title.includes("sms")) return "sms-initial";
  return normalizeKey(title) || "initial";
}

function sendFingerprint(lead = {}, task = {}) {
  const company = normalizeKey(lead.website || lead.business || lead.id || task.business || task.leadId);
  return [company, task.channel || "message", taskStepKey(task)].join("|");
}

function duplicateSentTask(state, lead, task) {
  const fingerprint = sendFingerprint(lead, task);
  const duplicate = (state.approvalQueue || []).find(item => item.id !== task.id && /^sent|sending|scheduled/i.test(item.status || "") && (item.sendFingerprint || sendFingerprint(lead, item)) === fingerprint);
  return { fingerprint, duplicate };
}

async function sendTaskNow(state, taskId) {
  const task = (state.approvalQueue || []).find(item => item.id === taskId);
  if (!task) throw new Error("Task not found");
  if (!["email", "sms"].includes(task.channel)) throw new Error("Only email and SMS tasks can be sent");
  if (!/^approved/i.test(task.status || "")) throw new Error("Task must be approved before sending");

  const limit = canSendMore(state);
  if (!limit.allowed) {
    task.status = "Rate Limited";
    task.nextAttemptAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const blockedBy = limit.remainingThisHour <= 0 ? "hourly" : "daily";
    const resetAt = blockedBy === "hourly" ? limit.resetHourAt : limit.resetDayAt;
    task.error = `Sending paused: ${blockedBy} limit reached. Try again after ${resetAt}.`;
    return { sent: false, rateLimited: true, error: task.error, limit, resetAt, task };
  }

  const lead = findLead(state, task);
  if (outreachDisabled(lead)) {
    task.status = "Blocked - Manual Test";
    task.error = "Manual Test prospects cannot send email, SMS, or follow-ups until converted to Real Prospect.";
    addTimeline(lead, "Outbound send blocked because this is a Manual Test prospect.");
    state.auditLog.unshift({ id: newId("audit"), at: nowIso(), action: "manual_test_outreach_blocked", details: { taskId: task.id, leadId: lead.id } });
    return { sent: false, blocked: true, error: task.error, task };
  }
  const duplicate = duplicateSentTask(state, lead, task);
  task.sendFingerprint = duplicate.fingerprint;
  if (duplicate.duplicate) {
    task.status = "Duplicate Blocked";
    task.error = "This message was already sent to this company.";
    task.duplicateOfTaskId = duplicate.duplicate.id;
    addTimeline(lead, `Duplicate send blocked for ${task.title || task.channel}`);
    state.auditLog.unshift({ id: newId("audit"), at: nowIso(), action: "duplicate_send_blocked", details: { taskId: task.id, duplicateTaskId: duplicate.duplicate.id, leadId: lead.id, fingerprint: duplicate.fingerprint } });
    return { sent: false, duplicate: true, error: task.error, task };
  }
  let to = task.channel === "sms"
    ? normalizePhone(task.to || task.recipient || lead.phone)
    : parseEmail(task.to || task.recipient || lead.email);
  if (task.channel === "email" && !to && lead.website) {
    try {
      const scan = await scanWebsite(lead.website);
      const discovered = parseEmail((scan.emails || [])[0]);
      if (discovered) {
        lead.email = discovered;
        task.to = discovered;
        task.recipient = discovered;
        task.emailDiscovery = {
          source: "website-scan",
          at: nowIso(),
          url: scan.url
        };
        addTimeline(lead, `Email discovered from website: ${discovered}`);
        to = discovered;
      }
    } catch {}
  }
  if (!to) {
    task.status = task.channel === "sms" ? "Needs Phone" : "Needs Email";
    addTimeline(lead, `${task.channel === "sms" ? "SMS" : "Email"} send blocked: no recipient ${task.channel === "sms" ? "phone number" : "email"} found`);
    return { sent: false, failed: true, error: `No recipient ${task.channel === "sms" ? "phone number" : "email"} found`, task };
  }

  try {
    task.status = "Sending";
    task.startedAt = nowIso();
    const result = task.channel === "sms"
      ? await sendSms({ to, task, lead })
      : await sendEmail({ to, task, lead });
    task.status = "Sent";
    task.sentAt = result.sentAt;
    task.messageId = result.messageId;
    task.provider = result.provider || "Email";
    task.sendFingerprint = duplicate.fingerprint;
    task.nextFollowUpAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    lead.stage = lead.stage === "New" ? "Contacted" : lead.stage;
    lead.lastContact = result.sentAt.slice(0, 10);
    if (task.channel === "email") {
      lead.sentEmails = lead.sentEmails || [];
      lead.sentEmails.unshift({
        id: newId("sent"),
        taskId: task.id,
        title: task.title || "Outbound email",
        to,
        subject: String(task.body || "").split(/\r?\n/).find(line => /^subject:/i.test(line))?.replace(/^subject:\s*/i, "") || "CallCatch follow-up",
        sentAt: result.sentAt,
        provider: task.provider,
        messageId: task.messageId
      });
      lead.sentEmails = lead.sentEmails.slice(0, 100);
      if (task.sequenceStep === "final-followup") {
        lead.nextFollowUp = "";
        lead.followUpStatus = "Sequence complete";
      } else {
        const waitDays = task.sequenceStep === "followup-1" ? SEQUENCE_STEPS[1].waitDays : SEQUENCE_STEPS[0].waitDays;
        const nextDue = addDaysIso(result.sentAt, waitDays);
        lead.nextFollowUp = nextDue.slice(0, 10);
        lead.followUpStatus = task.sequenceStep === "followup-1" ? "Final follow-up scheduled" : "Follow-up #1 scheduled";
        lead.followUpPlan = {
          nextStep: task.sequenceStep === "followup-1" ? "Final follow-up" : "Follow-up #1",
          nextDueAt: nextDue,
          lastSentTaskId: task.id,
          lastSentAt: result.sentAt
        };
      }
    }
    addTimeline(lead, `Sent ${task.channel === "sms" ? "SMS" : "email"}: ${task.title || "Outbound message"}`, result.sentAt);
    recordSendCount(state);
    recordVariantSent(state, lead, task);
    state.auditLog.unshift({ id: newId("audit"), at: result.sentAt, action: `${task.channel}_sent`, details: { taskId: task.id, leadId: lead.id, to } });
    return { sent: true, task, result };
  } catch (error) {
    task.status = "Send Failed";
    task.error = error.message;
    sendingState(state).metrics.failed += 1;
    state.auditLog.unshift({ id: newId("audit"), at: nowIso(), action: `${task.channel}_send_failed`, details: { taskId: task.id, error: error.message } });
    return { sent: false, failed: true, error: error.message, task };
  }
}

async function sendApprovedBatch(state, { limit, taskIds } = {}) {
  const allowedIds = Array.isArray(taskIds) && taskIds.length ? new Set(taskIds) : null;
  const tasks = approvedSendableTasks(state)
    .filter(task => !allowedIds || allowedIds.has(task.id))
    .slice(0, Number(limit) || 500);
  const total = tasks.length;
  const sent = [];
  const failed = [];
  const skipped = [];

  for (const task of tasks) {
    const result = await sendTaskNow(state, task.id);
    if (result.sent) sent.push(result);
    else if (result.rateLimited) {
      skipped.push(result);
      break;
    } else failed.push(result);
    task.randomizedDelaySeconds = randomDelaySeconds(state);
  }

  return {
    total,
    complete: sent.length + failed.length,
    sent: sent.length,
    failed: failed.length,
    skipped: skipped.length,
    remaining: Math.max(0, total - sent.length - failed.length),
    results: { sent, failed, skipped }
  };
}

function scheduleTask(state, { taskId, when }) {
  const task = (state.approvalQueue || []).find(item => item.id === taskId);
  if (!task) throw new Error("Task not found");
  const runAt = parseSchedule(when).toISOString();
  task.status = "Scheduled";
  task.scheduledAt = runAt;
  const job = {
    id: newId("schedule"),
    taskId,
    runAt,
    status: "Scheduled",
    createdAt: nowIso()
  };
  state.scheduledJobs.push(job);
  state.auditLog.unshift({ id: newId("audit"), at: nowIso(), action: "email_scheduled", details: { taskId, runAt } });
  return job;
}

async function runDueScheduled(state, date = new Date()) {
  const due = (state.scheduledJobs || []).filter(job => job.status === "Scheduled" && new Date(job.runAt) <= date);
  const results = [];
  for (const job of due) {
    const task = (state.approvalQueue || []).find(item => item.id === job.taskId);
    if (task) task.status = "Approved - scheduled send";
    const result = await sendTaskNow(state, job.taskId);
    job.status = result.sent ? "Sent" : "Failed";
    job.completedAt = nowIso();
    results.push({ job, result });
  }
  return results;
}

function generateFollowUps(state, { autoPilot = false, now = new Date() } = {}) {
  const queue = state.approvalQueue || [];
  const generated = [];
  const existingSteps = new Set(queue.map(task => `${task.leadId}|${task.sequenceStep || task.title}`));

  for (const initial of queue.filter(isInitialEmail)) {
    if (!initial.sentAt) continue;
    const lead = findLead(state, initial);
    if (outreachDisabled(lead) || lead.followUpsDisabled) continue;
    if (!lead.id || hasLeadReply(lead)) continue;

    const firstDue = new Date(addDaysIso(initial.sentAt, SEQUENCE_STEPS[0].waitDays));
    if (firstDue <= now && !existingSteps.has(`${lead.id}|followup-1`)) {
      const follow = {
        id: newId("task"),
        leadId: lead.id,
        business: lead.business,
        channel: "email",
        title: "Follow-up #1",
        sequenceStep: "followup-1",
        sequenceParentTaskId: initial.id,
        dueAt: firstDue.toISOString(),
        to: initial.to || initial.recipient || lead.email || "",
        recipient: initial.to || initial.recipient || lead.email || "",
        body: sequenceEmailBody(lead, "followup-1"),
        status: autoPilot ? "Approved - sequence" : "Needs Approval",
        createdAt: nowIso()
      };
      queue.unshift(follow);
      existingSteps.add(`${lead.id}|followup-1`);
      lead.nextFollowUp = firstDue.toISOString().slice(0, 10);
      lead.followUpStatus = "Follow-up #1 ready for approval";
      lead.followUpPlan = { nextStep: "Follow-up #1", nextDueAt: firstDue.toISOString(), taskId: follow.id };
      addTimeline(lead, "Generated Follow-up #1 after 3 days with no reply");
      generated.push(follow);
    }

    const firstSent = queue.find(task => task.leadId === lead.id && task.sequenceStep === "followup-1" && task.status === "Sent" && task.sentAt);
    if (!firstSent || hasLeadReply(lead)) continue;
    const finalDue = new Date(addDaysIso(firstSent.sentAt, SEQUENCE_STEPS[1].waitDays));
    if (finalDue <= now && !existingSteps.has(`${lead.id}|final-followup`)) {
      const final = {
        id: newId("task"),
        leadId: lead.id,
        business: lead.business,
        channel: "email",
        title: "Final Follow-up",
        sequenceStep: "final-followup",
        sequenceParentTaskId: initial.id,
        dueAt: finalDue.toISOString(),
        to: initial.to || initial.recipient || lead.email || "",
        recipient: initial.to || initial.recipient || lead.email || "",
        body: sequenceEmailBody(lead, "final-followup"),
        status: autoPilot ? "Approved - sequence" : "Needs Approval",
        createdAt: nowIso()
      };
      queue.unshift(final);
      existingSteps.add(`${lead.id}|final-followup`);
      lead.nextFollowUp = finalDue.toISOString().slice(0, 10);
      lead.followUpStatus = "Final follow-up ready for approval";
      lead.followUpPlan = { nextStep: "Final follow-up", nextDueAt: finalDue.toISOString(), taskId: final.id };
      addTimeline(lead, "Generated Final Follow-up after 4 more days with no reply");
      generated.push(final);
    }
  }

  state.approvalQueue = queue;
  sendingState(state).metrics.followUpsGenerated += generated.length;
  return generated;
}

async function runSequenceAutomation(state, { autoPilot = false, now = new Date() } = {}) {
  const generated = generateFollowUps(state, { autoPilot, now });
  const scheduled = await runDueScheduled(state, now);
  const sent = [];
  if (autoPilot) {
    for (const task of generated.filter(item => /^approved/i.test(item.status || ""))) {
      const result = await sendTaskNow(state, task.id);
      sent.push(result);
    }
  }
  state.auditLog.unshift({
    id: newId("audit"),
    at: nowIso(),
    action: "sequence_automation_run",
    details: { generated: generated.length, scheduled: scheduled.length, sent: sent.filter(item => item.sent).length, autoPilot }
  });
  return { generated, scheduled, sent };
}

function detectMeetingIntent(text) {
  const lower = String(text || "").toLowerCase();
  return MEETING_WORDS.some(word => lower.includes(word));
}

function suggestedReply(lead, body, meetingIntent) {
  if (meetingIntent) {
    return `Hi, thanks for getting back to us. Happy to schedule a quick walkthrough. What time works best today or tomorrow?`;
  }
  const lower = String(body || "").toLowerCase();
  if (lower.includes("price") || lower.includes("cost")) {
    return `Hi, thanks for replying. Pricing depends on call volume, but the goal is simple: recover enough missed callers to pay for itself quickly. Want me to show the numbers for ${lead.business}?`;
  }
  if (lower.includes("not interested")) {
    return `Thanks for letting me know. I will close the loop here. If missed calls become a priority later, happy to help.`;
  }
  return `Hi, thanks for the reply. The quick version: CallCatch texts missed callers instantly so they do not move on to the next company. Worth a short walkthrough?`;
}

function recordReply(state, { leadId, taskId, from, body, subject, provider, messageId }) {
  const taskById = (state.approvalQueue || []).find(item => item.id === taskId);
  const lead = (state.leads || []).find(item => item.id === leadId)
    || findLead(state, taskById || { leadId })
    || (state.leads || []).find(item => item.email && String(from || "").toLowerCase().includes(String(item.email).toLowerCase()));
  if (!lead || !lead.id) throw new Error("Lead not found");
  const task = taskById;
  const at = nowIso();
  const meetingIntent = detectMeetingIntent(body);
  lead.stage = meetingIntent ? "Demo Scheduled" : "Interested";
  lead.replies = lead.replies || [];
  const duplicateReply = lead.replies.find(item =>
    (messageId && item.messageId === messageId)
    || (String(item.from || "").toLowerCase() === String(from || "").toLowerCase()
      && String(item.body || "").trim() === String(body || "").trim())
  );
  if (duplicateReply) return { lead, reply: duplicateReply, meetingIntent, duplicate: true };
  const reply = {
    id: newId("reply"),
    at,
    from,
    subject: subject || "",
    body,
    provider: provider || "",
    messageId: messageId || "",
    taskId: task ? task.id : "",
    meetingIntent,
    status: "Needs Response",
    suggestedResponse: suggestedReply(lead, body, meetingIntent)
  };
  lead.replies.unshift(reply);
  addTimeline(lead, meetingIntent ? "Reply received with meeting intent" : "Reply received", at);
  addTimeline(lead, `Inbox reply needs response: ${suggestedReply(lead, body, meetingIntent)}`, at);
  if (task) {
    task.replyAt = at;
    task.replyBody = body;
  }
  for (const item of state.approvalQueue || []) {
    if (item.leadId === lead.id && item.status !== "Sent" && item.id !== task?.id) {
      item.status = "Stopped - reply received";
    }
  }
  lead.nextFollowUp = "";
  lead.followUpStatus = meetingIntent ? "Stopped - meeting intent" : "Stopped - reply received";
  lead.followUpPlan = { nextStep: "Reply response", stoppedAt: at, replyId: reply.id };
  const metrics = sendingState(state).metrics;
  metrics.replies += 1;
  if (meetingIntent) metrics.meetingsBooked += 1;
  recordVariantReply(state, lead, task, meetingIntent);
  state.auditLog.unshift({ id: newId("audit"), at, action: meetingIntent ? "meeting_intent_detected" : "reply_received", details: { leadId: lead.id, from } });
  return { lead, reply, meetingIntent };
}

function metrics(state) {
  const sending = sendingState(state);
  const today = todayKey();
  const sentToday = sending.counts.byDay[today] || 0;
  const emailTasks = state.approvalQueue || [];
  const leads = state.leads || [];
  return {
    emailsWaiting: emailTasks.filter(task => task.channel === "email" && /^approved/i.test(task.status || "")).length,
    emailsSentToday: sentToday,
    openRate: sending.metrics.sent ? Math.round((sending.metrics.opened / sending.metrics.sent) * 100) : 0,
    replyRate: sending.metrics.sent ? Math.round((sending.metrics.replies / sending.metrics.sent) * 100) : 0,
    meetingsBooked: sending.metrics.meetingsBooked,
    followUpsDue: emailTasks.filter(task => task.title && task.title.toLowerCase().includes("follow") && task.status === "Needs Approval").length,
    estimatedRevenuePipeline: leads.reduce((sum, lead) => sum + Number(lead.revenueOpportunityEstimate || 0), 0),
    limits: sending.limits,
    variantStats: sending.variantStats,
    remaining: canSendMore(state),
    followUpPlans: emailTasks.filter(isInitialEmail).map(task => followUpPlanFromTask(task, findLead(state, task), emailTasks)).filter(plan => plan.active)
  };
}

module.exports = {
  DEFAULT_LIMITS,
  generateFollowUps,
  metrics,
  recordReply,
  runSequenceAutomation,
  runDueScheduled,
  scheduleTask,
  sendApprovedBatch,
  sendTaskNow
};
