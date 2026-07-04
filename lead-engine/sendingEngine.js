const { sendEmail, parseEmail } = require("./emailAdapter");
const { outreachAssets } = require("./prospectIntelligence");
const { scanWebsite } = require("./websiteScanner");
const { newId } = require("./dataStore");

const DEFAULT_LIMITS = {
  maxPerHour: 20,
  maxPerDay: 100,
  minDelaySeconds: 45,
  maxDelaySeconds: 180
};

const MEETING_WORDS = ["let's talk", "lets talk", "interested", "can we schedule", "call me", "book", "demo", "calendar", "meeting"];

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
  return {
    allowed: dayCount < sending.limits.maxPerDay && hourCount < sending.limits.maxPerHour,
    dayCount,
    hourCount,
    remainingToday: Math.max(0, sending.limits.maxPerDay - dayCount),
    remainingThisHour: Math.max(0, sending.limits.maxPerHour - hourCount)
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

function approvedEmailTasks(state) {
  return (state.approvalQueue || []).filter(task => task.channel === "email" && /^approved/i.test(task.status || ""));
}

function findLead(state, task) {
  return (state.leads || []).find(lead => lead.id === task.leadId) || {};
}

async function sendTaskNow(state, taskId) {
  const task = (state.approvalQueue || []).find(item => item.id === taskId);
  if (!task) throw new Error("Task not found");
  if (task.channel !== "email") throw new Error("Only email tasks can be sent by the email adapter");
  if (!/^approved/i.test(task.status || "")) throw new Error("Email must be approved before sending");

  const limit = canSendMore(state);
  if (!limit.allowed) {
    task.status = "Rate Limited";
    task.nextAttemptAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return { sent: false, rateLimited: true, task };
  }

  const lead = findLead(state, task);
  let to = parseEmail(task.to || task.recipient || lead.email);
  if (!to && lead.website) {
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
    task.status = "Needs Email";
    addTimeline(lead, "Email send blocked: no public recipient email found");
    return { sent: false, failed: true, error: "No recipient email found", task };
  }

  try {
    task.status = "Sending";
    task.startedAt = nowIso();
    const result = await sendEmail({ to, task, lead });
    task.status = "Sent";
    task.sentAt = result.sentAt;
    task.messageId = result.messageId;
    task.provider = "SMTP";
    task.nextFollowUpAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    lead.stage = lead.stage === "New" ? "Contacted" : lead.stage;
    lead.lastContact = result.sentAt.slice(0, 10);
    addTimeline(lead, `Sent email: ${task.title || "Outbound email"}`, result.sentAt);
    recordSendCount(state);
    recordVariantSent(state, lead, task);
    state.auditLog.unshift({ id: newId("audit"), at: result.sentAt, action: "email_sent", details: { taskId: task.id, leadId: lead.id, to } });
    return { sent: true, task, result };
  } catch (error) {
    task.status = "Send Failed";
    task.error = error.message;
    sendingState(state).metrics.failed += 1;
    state.auditLog.unshift({ id: newId("audit"), at: nowIso(), action: "email_send_failed", details: { taskId: task.id, error: error.message } });
    return { sent: false, failed: true, error: error.message, task };
  }
}

async function sendApprovedBatch(state, { limit } = {}) {
  const tasks = approvedEmailTasks(state).slice(0, Number(limit) || 500);
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

function generateFollowUps(state, { days = 3, autoPilot = false } = {}) {
  const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
  const existingKeys = new Set((state.approvalQueue || []).map(task => `${task.leadId}|${task.title}`));
  const generated = [];
  for (const task of state.approvalQueue || []) {
    if (task.channel !== "email" || task.status !== "Sent" || !task.sentAt || task.replyAt) continue;
    if (new Date(task.sentAt).getTime() > cutoff) continue;
    const lead = findLead(state, task);
    const key = `${lead.id}|Day ${days} Follow-up`;
    if (existingKeys.has(key)) continue;
    const assets = outreachAssets(lead);
    const follow = {
      id: newId("task"),
      leadId: lead.id,
      business: lead.business,
      channel: "email",
      title: `Day ${days} Follow-up`,
      body: assets.email.replace("Quick idea", "Following up on the quick idea"),
      status: autoPilot ? "Approved - follow-up" : "Needs Approval",
      createdAt: nowIso(),
      parentTaskId: task.id
    };
    state.approvalQueue.unshift(follow);
    addTimeline(lead, `Generated ${follow.title}`);
    generated.push(follow);
  }
  sendingState(state).metrics.followUpsGenerated += generated.length;
  return generated;
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

function recordReply(state, { leadId, taskId, from, body }) {
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
  const reply = {
    id: newId("reply"),
    at,
    from,
    body,
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
    if (item.leadId === lead.id && ["Needs Approval", "Approved - not sent", "Scheduled"].includes(item.status)) {
      item.status = "Stopped - reply received";
    }
  }
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
    remaining: canSendMore(state)
  };
}

module.exports = {
  DEFAULT_LIMITS,
  generateFollowUps,
  metrics,
  recordReply,
  runDueScheduled,
  scheduleTask,
  sendApprovedBatch,
  sendTaskNow
};
