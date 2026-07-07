const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const { searchLeads } = require("./lead-engine/searchEngine");
const { configured: braveConfigured } = require("./lead-engine/providers/braveSearch");
const { configured: serperConfigured } = require("./lead-engine/providers/serperSearch");
const { fetchJson } = require("./lead-engine/httpClient");
const { scanWebsite } = require("./lead-engine/websiteScanner");
const { enrichProspect, outreachAssets } = require("./lead-engine/prospectIntelligence");
const { audit, mutateStore, newId, readStore, storageMode } = require("./lead-engine/dataStore");
const { buildCampaign, buildSequenceTasks } = require("./lead-engine/campaigns");
const { DEFAULT_DAILY_GROWTH, automationCapabilities, mergeConfig, runDailyGrowth } = require("./lead-engine/dailyGrowth");
const { activeProvider, configured: emailConfigured, emailConfig, parseEmail, sendEmail } = require("./lead-engine/emailAdapter");
const { configured: smsConfigured, normalizePhone, sendSms, smsConfig } = require("./lead-engine/smsAdapter");
const {
  generateFollowUps,
  metrics: sendingMetrics,
  recordReply,
  runSequenceAutomation,
  runDueScheduled,
  scheduleTask,
  sendApprovedBatch,
  sendTaskNow
} = require("./lead-engine/sendingEngine");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = __dirname;
let automationRunning = false;

function normalizeCompanyKey(lead = {}) {
  return String(lead.website || `${lead.business || ""}-${lead.city || ""}-${lead.state || ""}`)
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function mergeUniqueList(a = [], b = []) {
  const seen = new Set();
  return [...a, ...b].filter(item => {
    const key = typeof item === "string" ? item : JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeLeadRecord(existing = {}, incoming = {}) {
  const merged = { ...existing, ...incoming, id: existing.id || incoming.id };
  for (const key of ["business", "trade", "city", "state", "zip", "area", "phone", "website", "email", "owner", "address", "source", "mapsUrl", "osmUrl"]) {
    merged[key] = existing[key] || incoming[key] || "";
  }
  merged.tags = mergeUniqueList(existing.tags || [], incoming.tags || []);
  merged.aiInsights = mergeUniqueList(existing.aiInsights || [], incoming.aiInsights || []);
  merged.timeline = mergeUniqueList(incoming.timeline || [], existing.timeline || []).slice(0, 300);
  merged.sentEmails = mergeUniqueList(existing.sentEmails || [], incoming.sentEmails || []).slice(0, 100);
  merged.replies = mergeUniqueList(existing.replies || [], incoming.replies || []).slice(0, 100);
  merged.callCatchFitScore = Math.max(Number(existing.callCatchFitScore || 0), Number(incoming.callCatchFitScore || 0));
  merged.revenueOpportunityEstimate = Math.max(Number(existing.revenueOpportunityEstimate || 0), Number(incoming.revenueOpportunityEstimate || 0));
  merged.updatedAt = new Date().toISOString();
  return merged;
}

function stripHtml(value = "") {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === lower)?.[1] || "";
}

function normalizeInboundReplyPayload(body = {}, headers = {}) {
  const data = body.data || body.email || body.message || body;
  const from = data.from?.email || data.from || body.from || body.sender || body.replyFrom || "";
  const text = data.text || data.text_body || data.body || body.text || body.body || body.message || "";
  const html = data.html || data.html_body || body.html || "";
  const toValue = Array.isArray(data.to) ? data.to.map(item => item.email || item).join(", ") : (data.to || body.to || "");
  return {
    leadId: body.leadId || data.leadId || "",
    taskId: body.taskId || data.taskId || data.headers?.["X-CallCatch-Task"] || data.headers?.["x-callcatch-task"] || "",
    from,
    to: toValue,
    subject: data.subject || body.subject || "",
    body: text || stripHtml(html),
    provider: body.provider || (urlSafeHeader(headers, "resend-signature") ? "resend" : "inbound"),
    rawType: body.type || data.type || "",
    messageId: data.message_id || data.id || body.id || ""
  };
}

function urlSafeHeader(headers, name) {
  return headerValue(headers, name);
}

function arrayFirst(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function emailReadyLead(lead = {}) {
  return !!String(lead.email || "").trim() || (lead.sentEmails || []).some(item => String(item.to || item.recipient || "").trim());
}

function storableProspect(lead = {}) {
  return emailReadyLead(lead)
    || !!String(lead.business || "").trim()
    || !!String(lead.phone || "").trim()
    || !!String(lead.website || "").trim()
    || !!String(lead.address || "").trim();
}

function queueStepKey(task = {}) {
  if (task.sequenceStep) return task.sequenceStep;
  if (task.channel === "email" && task.emailVariant) return "initial-email";
  const title = String(task.title || task.channel || "message").toLowerCase();
  if (title.includes("final")) return "final-followup";
  if (title.includes("follow")) return "followup-1";
  if (task.channel === "email" && title.includes("cold email")) return "initial-email";
  return title.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "message";
}

function queueFingerprint(task = {}, lead = {}) {
  const company = normalizeCompanyKey(lead.id ? lead : {
    business: task.business,
    website: task.website,
    city: task.city,
    state: task.state
  }) || String(task.leadId || task.business || "").toLowerCase();
  return [company, task.channel || "message", queueStepKey(task)].join("|");
}

function emailIdentity(value = "") {
  return parseEmail(value || "").toLowerCase();
}

function taskRecipientEmail(task = {}, lead = {}) {
  return emailIdentity(task.to || task.recipient || lead.email || "");
}

function initialCampaignEmailTask(task = {}) {
  if (task.channel !== "email") return false;
  const step = queueStepKey(task);
  const title = String(task.title || "").toLowerCase();
  return step === "initial-email" || title.includes("cold email") || title === "email" || title.includes("version a") || title.includes("version b");
}

function contactedKeySet(leads = []) {
  const keys = new Set();
  for (const lead of leads || []) {
    const sent = (lead.sentEmails || []).length > 0;
    const contacted = sent
      || !!lead.lastContact
      || (lead.replies || []).length > 0
      || ["Contacted", "Demo Scheduled", "Trial Started", "Customer"].includes(lead.stage || "");
    if (!contacted) continue;
    if (lead.id) keys.add(`lead:${lead.id}`);
    if (lead.email) keys.add(`email:${emailIdentity(lead.email)}`);
    keys.add(`company:${normalizeCompanyKey(lead)}`);
    for (const sentEmail of lead.sentEmails || []) {
      const recipient = emailIdentity(sentEmail.to || sentEmail.recipient || "");
      if (recipient) keys.add(`email:${recipient}`);
    }
  }
  return keys;
}

function taskMatchesContacted(task = {}, lead = {}, contactedKeys = new Set()) {
  const recipient = taskRecipientEmail(task, lead);
  return !!(
    (lead.id && contactedKeys.has(`lead:${lead.id}`))
    || (recipient && contactedKeys.has(`email:${recipient}`))
    || contactedKeys.has(`company:${normalizeCompanyKey(lead.id ? lead : task)}`)
  );
}

function compactApprovalQueue(items = [], leads = []) {
  const leadById = new Map(leads.map(lead => [lead.id, lead]));
  const contactedKeys = contactedKeySet(leads);
  const sentFingerprints = new Set(items
    .filter(item => item.channel === "email" && /^sent$/i.test(item.status || ""))
    .map(item => item.sendFingerprint || queueFingerprint(item, leadById.get(item.leadId) || {})));
  const draftFingerprints = new Set();
  return items.filter(item => {
    if (item.channel !== "email") return true;
    const lead = leadById.get(item.leadId) || {};
    const fp = item.sendFingerprint || queueFingerprint(item, lead);
    item.sendFingerprint = fp;
    if (/^sent$/i.test(item.status || "")) return true;
    if (initialCampaignEmailTask(item) && taskMatchesContacted(item, lead, contactedKeys)) return false;
    if (sentFingerprints.has(fp)) return false;
    if (draftFingerprints.has(fp)) return false;
    draftFingerprints.add(fp);
    return true;
  });
}

function addDays(dateValue, days) {
  return new Date(new Date(dateValue).getTime() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
}

function emailSubject(body, fallback = "CallCatch follow-up") {
  return String(body || "")
    .split(/\r?\n/)
    .find(line => /^subject:/i.test(line))
    ?.replace(/^subject:\s*/i, "")
    .trim() || fallback;
}

function ensureSentRecord(lead, record) {
  lead.sentEmails = lead.sentEmails || [];
  const key = record.taskId || record.messageId || `${record.subject}|${record.sentAt}|${record.to}`;
  const exists = lead.sentEmails.some(item => (item.taskId || item.messageId || `${item.subject}|${item.sentAt}|${item.to}`) === key);
  if (exists) return false;
  lead.sentEmails.unshift(record);
  lead.sentEmails = lead.sentEmails
    .sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
    .slice(0, 100);
  return true;
}

function recoverLeadFromSentTask(task = {}) {
  const at = task.sentAt || new Date().toISOString();
  const email = parseEmail(task.to || task.recipient || "");
  const lead = {
    id: task.leadId || newId("lead"),
    business: task.business || "Emailed Prospect",
    trade: task.trade || "Home Services",
    city: task.city || "",
    state: task.state || "",
    email,
    phone: task.phone || "",
    website: task.website || "",
    stage: "Contacted",
    source: "Recovered from sent email history",
    callCatchFitScore: Number(task.callCatchFitScore || 60),
    revenueOpportunityEstimate: Number(task.revenueOpportunityEstimate || 0),
    aiOpportunityLevel: "Contacted",
    responsePriority: "Follow up",
    lastContact: at.slice(0, 10),
    nextFollowUp: addDays(at, 3).slice(0, 10),
    followUpStatus: "Follow-up #1 scheduled",
    timeline: [{ at, text: `Recovered pipeline record from sent email: ${task.title || "Outbound email"}` }],
    sentEmails: []
  };
  ensureSentRecord(lead, {
    id: newId("sent"),
    taskId: task.id,
    title: task.title || "Sent email",
    to: email,
    subject: emailSubject(task.body, task.title || "Sent email"),
    body: task.body || "",
    sentAt: at,
    provider: task.provider || "",
    messageId: task.messageId || "",
    recoveredFrom: "sent_task"
  });
  return lead;
}

function hydrateSentEmailHistory(state) {
  state.leads = state.leads || [];
  state.approvalQueue = state.approvalQueue || [];
  state.auditLog = state.auditLog || [];
  const leadById = new Map(state.leads.map(lead => [lead.id, lead]));
  let recovered = 0;

  for (const task of state.approvalQueue) {
    if (task.channel !== "email" || !/^sent$/i.test(task.status || "") || !task.sentAt) continue;
    let lead = leadById.get(task.leadId);
    if (!lead) {
      lead = recoverLeadFromSentTask(task);
      state.leads.unshift(lead);
      leadById.set(lead.id, lead);
      recovered += 1;
      continue;
    }
    if (!lead.email) lead.email = parseEmail(task.to || task.recipient || "");
    const added = ensureSentRecord(lead, {
      id: newId("sent"),
      taskId: task.id,
      title: task.title || "Sent email",
      to: task.to || task.recipient || lead.email || "",
      subject: emailSubject(task.body, task.title || "Sent email"),
      body: task.body || "",
      sentAt: task.sentAt,
      provider: task.provider || "",
      messageId: task.messageId || "",
      recoveredFrom: "approval_queue"
    });
    if (added) recovered += 1;
  }

  for (const entry of state.auditLog) {
    if (entry.action !== "email_sent") continue;
    const lead = leadById.get(entry.details?.leadId);
    if (!lead) continue;
    const task = state.approvalQueue.find(item => item.id === entry.details?.taskId) || {};
    const added = ensureSentRecord(lead, {
      id: newId("sent"),
      taskId: entry.details?.taskId || "",
      title: task.title || "Sent email",
      to: entry.details?.to || task.to || task.recipient || lead.email || "",
      subject: emailSubject(task.body, task.title || "Sent email"),
      body: task.body || "",
      sentAt: entry.at,
      provider: task.provider || "",
      messageId: task.messageId || "",
      recoveredFrom: "audit_log"
    });
    if (added) recovered += 1;
  }

  for (const lead of state.leads) {
    for (const event of lead.timeline || []) {
      if (!/email sent|sent email|sent .*email/i.test(event.text || "")) continue;
      const added = ensureSentRecord(lead, {
        id: newId("sent"),
        taskId: "",
        title: event.text || "Sent email",
        to: lead.email || "",
        subject: event.text || "Sent email",
        body: "",
        sentAt: event.at || new Date().toISOString(),
        provider: "",
        messageId: "",
        recoveredFrom: "timeline"
      });
      if (added) recovered += 1;
    }

    const latest = (lead.sentEmails || [])[0];
    if (latest?.sentAt) {
      if (lead.stage === "New") lead.stage = "Contacted";
      lead.lastContact = lead.lastContact || latest.sentAt.slice(0, 10);
      if (!lead.nextFollowUp && !["Interested", "Demo Scheduled", "Trial Started", "Customer", "Lost"].includes(lead.stage)) {
        lead.nextFollowUp = addDays(latest.sentAt, 3).slice(0, 10);
        lead.followUpStatus = lead.followUpStatus || "Follow-up #1 scheduled";
        lead.followUpPlan = lead.followUpPlan || {
          nextStep: "Follow-up #1",
          nextDueAt: addDays(latest.sentAt, 3),
          recoveredFrom: "sent_history"
        };
      }
    }
  }

  state.approvalQueue = compactApprovalQueue(state.approvalQueue || [], state.leads || []);

  if (recovered) {
    state.auditLog.unshift({
      id: newId("audit"),
      at: new Date().toISOString(),
      action: "sent_history_recovered",
      details: { recovered }
    });
  }
  return recovered;
}

function contactedLeads(state = {}) {
  const terminal = new Set(["Contacted", "Follow-up", "Interested", "Demo Scheduled", "Trial Started", "Customer"]);
  return (state.leads || []).filter(lead =>
    terminal.has(lead.stage)
    || !!lead.lastContact
    || (lead.sentEmails || []).length > 0
    || (lead.replies || []).length > 0
  );
}

function pipelineMemoryReport(state = {}) {
  const sentQueue = (state.approvalQueue || []).filter(task => task.channel === "email" && /^sent$/i.test(task.status || ""));
  const emailSentAudits = (state.auditLog || []).filter(entry => entry.action === "email_sent");
  const contacted = contactedLeads(state);
  return {
    storage: storageMode(),
    leads: (state.leads || []).length,
    approvalQueue: (state.approvalQueue || []).length,
    sentEmailTasks: sentQueue.length,
    leadsWithSentEmails: (state.leads || []).filter(lead => (lead.sentEmails || []).length > 0).length,
    contactedProspects: contacted.length,
    emailSentAudits: emailSentAudits.length,
    canRecover: sentQueue.length > 0 || emailSentAudits.length > 0 || contacted.length > 0,
    message: contacted.length
      ? `${contacted.length} contacted prospect${contacted.length === 1 ? "" : "s"} are saved and should appear in Pipeline.`
      : sentQueue.length || emailSentAudits.length
        ? "Sent-email history exists, but CRM records were missing. CallCatch will recover what it can."
        : "No saved contacted history was found in this app memory. Old sends may have lived only in a browser session, local file, or a Render instance that restarted before Postgres was connected.",
    contacted: contacted.slice(0, 100).map(lead => ({
      id: lead.id,
      business: lead.business,
      trade: lead.trade,
      stage: lead.stage,
      email: lead.email,
      lastContact: lead.lastContact,
      sentEmails: (lead.sentEmails || []).length,
      replies: (lead.replies || []).length
    }))
  };
}

async function resendRequest(pathname, config) {
  if (!config.resendApiKey) throw new Error("RESEND_API_KEY is not configured on Render");
  const response = await fetch(`https://api.resend.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Resend request failed with ${response.status}`);
  }
  return payload;
}

function emailValue(value) {
  if (Array.isArray(value)) return parseEmail(value.map(item => item.email || item).join(", "));
  if (value && typeof value === "object") return parseEmail(value.email || value.address || "");
  return parseEmail(value || "");
}

function businessFromResendEmail(email = {}) {
  const subject = String(email.subject || "").trim();
  const patterns = [
    /quick idea for\s+(.+)$/i,
    /question about\s+(.+)$/i,
    /helping\s+(.+?)\s+capture/i,
    /missed calls at\s+(.+)$/i,
    /follow-up for\s+(.+)$/i,
    /closing the loop for\s+(.+)$/i
  ];
  for (const pattern of patterns) {
    const match = subject.match(pattern);
    if (match?.[1]) return match[1].replace(/[?.!]+$/g, "").trim();
  }
  const to = emailValue(email.to || email.recipient);
  const domain = to.split("@")[1] || "";
  if (domain) {
    return domain.split(".")[0].replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
  }
  return subject || "Recovered Resend Prospect";
}

function resendEmailBody(email = {}) {
  return email.text || email.text_body || stripHtml(email.html || email.html_body || "") || "";
}

function leadFromResendEmail(email = {}) {
  const to = emailValue(email.to || email.recipient);
  const sentAt = email.created_at || email.createdAt || email.sent_at || email.sentAt || new Date().toISOString();
  const subject = email.subject || "Recovered Resend email";
  const business = businessFromResendEmail(email);
  const messageId = email.id || email.message_id || "";
  return {
    id: newId("lead"),
    business,
    trade: "Home Services",
    email: to,
    stage: "Contacted",
    source: "Recovered from Resend history",
    callCatchFitScore: 60,
    revenueOpportunityEstimate: 0,
    aiOpportunityLevel: "Contacted",
    responsePriority: "Follow up",
    lastContact: sentAt.slice(0, 10),
    nextFollowUp: addDays(sentAt, 3).slice(0, 10),
    followUpStatus: "Follow-up #1 scheduled",
    tags: ["resend-recovered"],
    timeline: [{ at: sentAt, text: `Recovered sent email from Resend: ${subject}` }],
    sentEmails: [{
      id: newId("sent"),
      taskId: "",
      title: subject,
      to,
      subject,
      body: resendEmailBody(email),
      sentAt,
      provider: "Resend",
      messageId,
      recoveredFrom: "resend"
    }]
  };
}

async function importResendSentEmails(state, options = {}) {
  const config = emailConfig();
  const limit = Math.min(100, Math.max(1, Number(options.limit || 50)));
  const list = await resendRequest("/emails", config);
  const items = (list.data || list.emails || []).slice(0, limit);
  const detailed = [];
  for (const item of items) {
    if (item.id && options.retrieve !== false) {
      try {
        detailed.push({ ...item, ...(await resendRequest(`/emails/${encodeURIComponent(item.id)}`, config)) });
        continue;
      } catch {}
    }
    detailed.push(item);
  }

  state.leads = state.leads || [];
  const byEmail = new Map(state.leads.filter(lead => lead.email).map(lead => [String(lead.email).toLowerCase(), lead]));
  const byMessage = new Map();
  for (const lead of state.leads) {
    for (const sent of lead.sentEmails || []) {
      if (sent.messageId) byMessage.set(sent.messageId, lead);
    }
  }

  let imported = 0;
  let merged = 0;
  let skipped = 0;
  const importedLeads = [];

  for (const email of detailed) {
    const to = emailValue(email.to || email.recipient);
    const messageId = email.id || email.message_id || "";
    if (!to) {
      skipped += 1;
      continue;
    }
    const recovered = leadFromResendEmail({ ...email, to });
    const existing = (messageId && byMessage.get(messageId)) || byEmail.get(to.toLowerCase());
    if (existing) {
      const before = (existing.sentEmails || []).length;
      Object.assign(existing, mergeLeadRecord(existing, recovered));
      existing.stage = existing.stage === "New" ? "Contacted" : (existing.stage || "Contacted");
      existing.lastContact = existing.lastContact || recovered.lastContact;
      ensureSentRecord(existing, recovered.sentEmails[0]);
      byEmail.set(to.toLowerCase(), existing);
      if (messageId) byMessage.set(messageId, existing);
      merged += (existing.sentEmails || []).length > before ? 1 : 0;
      importedLeads.push(existing);
      continue;
    }
    state.leads.unshift(recovered);
    byEmail.set(to.toLowerCase(), recovered);
    if (messageId) byMessage.set(messageId, recovered);
    imported += 1;
    importedLeads.push(recovered);
  }

  hydrateSentEmailHistory(state);
  state.approvalQueue = compactApprovalQueue(state.approvalQueue || [], state.leads || []);
  state.auditLog.unshift({
    id: newId("audit"),
    at: new Date().toISOString(),
    action: "resend_history_imported",
    details: { found: items.length, imported, merged, skipped }
  });
  return { found: items.length, imported, merged, skipped, leads: importedLeads.slice(0, 50), report: pipelineMemoryReport(state) };
}

async function enrichLeadForOutreach(lead = {}) {
  const researchUrl = lead.website || lead.facebook || "";
  if (!researchUrl || (lead.websiteIntelligence && lead.websiteIntelligence.ok !== false)) {
    return lead;
  }

  try {
    const scan = await scanWebsite(researchUrl);
    const discoveredEmail = scan.emails && scan.emails[0] ? scan.emails[0] : "";
    const discoveredPhone = scan.phones && scan.phones[0] ? scan.phones[0] : "";
    const enriched = enrichProspect({
      ...lead,
      email: lead.email || discoveredEmail,
      phone: lead.phone || discoveredPhone
    }, scan);
    await audit("website_scan_for_outreach", {
      leadId: lead.id,
      business: lead.business,
      website: researchUrl,
      ok: scan.ok,
      emailFound: !!discoveredEmail
    });
    return enriched;
  } catch (error) {
    log("warn", "outreach_website_scan_failed", {
      leadId: lead.id,
      business: lead.business,
      website: researchUrl,
      error: error.message
    });
    return enrichProspect(lead, {
      ok: false,
      error: error.message,
      url: lead.website,
      emails: [],
      phones: [],
      websiteQualityScore: lead.websiteQualityScore || 15
    });
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

async function sendFile(res, filePath, contentType) {
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function log(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...meta
  };
  console.log(JSON.stringify(entry));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function runBackgroundAutomation() {
  if (automationRunning) return;
  automationRunning = true;
  try {
    await mutateStore(state => {
      const config = mergeConfig(state.dailyGrowth || {});
      const autoPilot = config.enabled && config.automationLevel === "Auto Pilot";
      return runSequenceAutomation(state, { autoPilot });
    });
  } catch (error) {
    log("error", "sequence_automation_failed", { error: error.message });
  } finally {
    automationRunning = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 204, {});
  }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && ["/", "/dashboard", "/callcatch-lead-dashboard.html"].includes(url.pathname)) {
    return sendFile(res, path.join(PUBLIC_DIR, "callcatch-lead-dashboard.html"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, {
      ok: true,
      providerEngine: "free-public-sources",
      providers: [
        "nominatim",
        "openstreetmap",
        ...(serperConfigured() ? ["serper"] : []),
        ...(braveConfigured() ? ["brave-search"] : [])
      ],
      modules: ["prospect-intelligence", "website-scanner", "approval-queue"],
      automation: ["daily-growth", "campaign-sequences", "approval-first-autopilot"],
      sendingEngine: ["send-now", "bulk-send", "scheduled-send", "rate-limits", "reply-tracking"],
      storage: storageMode(),
      email: {
        configured: emailConfigured(),
        provider: activeProvider(emailConfig()),
        source: emailConfig().source
      },
      sms: {
        configured: smsConfigured(),
        provider: smsConfig().provider,
        source: smsConfig().source
      },
      requiresApiKey: false,
      cache: "memory"
    });
  }

  if (req.method === "GET" && url.pathname === "/api/network-check") {
    const checks = [];
    for (const target of [
      "https://nominatim.openstreetmap.org/search?q=Dallas,TX,USA&format=jsonv2&limit=1",
      "https://overpass-api.de/api/interpreter"
    ]) {
      try {
        const timeout = AbortSignal.timeout(4000);
        if (target.includes("overpass")) {
          await fetchJson(target, {
            method: "POST",
            signal: timeout,
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: "data=%5Bout%3Ajson%5D%5Btimeout%3A5%5D%3Bnode%2850%2E6%2C7%2E0%2C50%2E8%2C7%2E3%29%5B%22amenity%22%3D%22restaurant%22%5D%3Bout%201%3B"
          }, { retries: 0 });
        } else {
          await fetchJson(target, { signal: timeout }, { retries: 0 });
        }
        checks.push({ target, ok: true });
      } catch (error) {
        checks.push({
          target,
          ok: false,
          error: error.message,
          cause: error.cause && (error.cause.code || error.cause.message) ? (error.cause.code || error.cause.message) : ""
        });
      }
    }
    return send(res, 200, {
      message: checks.every(check => check.ok)
        ? "Public lead sources are reachable."
        : "The local server is running, but one or more public lead sources are blocked or unreachable from this network.",
      ok: checks.every(check => check.ok),
      checks
    });
  }

  if (req.method === "POST" && url.pathname === "/api/leads") {
    try {
      const body = await readJson(req);
      log("info", "lead_search_started", {
        trade: body.trade,
        area: body.area,
        count: body.count
      });

      const result = await searchLeads(body);
      await audit("lead_search", {
        trade: body.trade,
        area: body.area,
        count: body.count,
        returned: result.leads.length
      });
      log("info", "lead_search_finished", {
        count: result.leads.length,
        source: result.source,
        cached: result.cached
      });
      return send(res, 200, result);
    } catch (error) {
      log("error", "lead_search_failed", { error: error.message });
      return send(res, 400, {
        error: error.message,
        leads: [],
        source: "free-public-sources"
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/scan-website") {
    try {
      const body = await readJson(req);
      const scan = await scanWebsite(body.website || body.url);
      const discoveredEmail = scan.emails && scan.emails[0] ? scan.emails[0] : "";
      const lead = body.lead ? enrichProspect({ ...body.lead, email: body.lead.email || discoveredEmail }, scan) : null;
      await audit("website_scan", { website: body.website || body.url, ok: scan.ok });
      return send(res, 200, { scan, lead });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/outreach") {
    try {
      const body = await readJson(req);
      const lead = body.scan === false ? (body.lead || {}) : await enrichLeadForOutreach(body.lead || {});
      return send(res, 200, {
        approvalRequired: true,
        lead,
        assets: outreachAssets(lead)
      });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/daily-assistant") {
    try {
      const body = await readJson(req);
      const leads = Array.isArray(body.leads) ? body.leads : [];
      const sorted = [...leads].sort((a, b) => (b.callCatchFitScore || 0) - (a.callCatchFitScore || 0));
      return send(res, 200, {
        date: new Date().toISOString().slice(0, 10),
        bestProspects: sorted.slice(0, 5),
        followUpsDue: leads.filter(lead => ["Follow-up", "Contacted"].includes(lead.stage)).length,
        newLeads: leads.filter(lead => lead.stage === "New").length,
        demosScheduled: leads.filter(lead => lead.stage === "Demo Scheduled").length,
        customersWon: leads.filter(lead => lead.stage === "Customer").length,
        estimatedPipelineValue: leads.reduce((sum, lead) => sum + Number(lead.revenueOpportunityEstimate || 0), 0),
        recommendations: [
          "Work high-fit urgent-service leads first.",
          "Review queued outreach before sending.",
          "Scan websites for leads missing email or booking signals."
        ]
      });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/crm") {
    const state = await mutateStore(state => {
      hydrateSentEmailHistory(state);
      return state;
    });
    return send(res, 200, state);
  }

  if (req.method === "GET" && url.pathname === "/api/pipeline/contacted") {
    const state = await mutateStore(state => {
      hydrateSentEmailHistory(state);
      return state;
    });
    return send(res, 200, pipelineMemoryReport(state));
  }

  if (req.method === "POST" && url.pathname === "/api/recovery/resend-sent") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => importResendSentEmails(state, body));
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/crm/leads") {
    try {
      const body = await readJson(req);
      const incoming = Array.isArray(body.leads) ? body.leads : [];
      const saved = await mutateStore(state => {
        state.leads = state.leads || [];
        const existing = new Map(state.leads.map(lead => [lead.id, lead]));
        const keyToId = new Map(state.leads.map(lead => [normalizeCompanyKey(lead), lead.id]));
        let skippedNoEmail = 0;
        let mergedDuplicate = 0;
        incoming.forEach(lead => {
          const id = lead.id || newId("lead");
          const alreadySaved = existing.has(id);
          const key = normalizeCompanyKey(lead);
          if (!storableProspect(lead) && !alreadySaved) {
            skippedNoEmail += 1;
            return;
          }
          const duplicateId = keyToId.get(key);
          if (!alreadySaved && duplicateId && existing.has(duplicateId)) {
            existing.set(duplicateId, mergeLeadRecord(existing.get(duplicateId), lead));
            mergedDuplicate += 1;
            return;
          }
          keyToId.set(key, id);
          existing.set(id, alreadySaved ? mergeLeadRecord(existing.get(id), lead) : { ...lead, id, updatedAt: new Date().toISOString() });
        });
        hydrateSentEmailHistory(state);
        state.leads = [...existing.values(), ...state.leads.filter(lead => !existing.has(lead.id))].filter(storableProspect);
        hydrateSentEmailHistory(state);
        const leadById = new Map(state.leads.map(lead => [lead.id, lead]));
        for (const task of state.approvalQueue || []) {
          if (["email", "sms"].includes(task.channel) && !task.to && !task.recipient) {
            const lead = leadById.get(task.leadId);
            const recipient = task.channel === "sms" ? lead?.phone : lead?.email;
            if (recipient) {
              task.to = recipient;
              task.recipient = recipient;
            }
          }
        }
        state.auditLog.unshift({
          id: newId("audit"),
          at: new Date().toISOString(),
          action: "crm_leads_synced",
          details: { count: incoming.length, skippedNoEmail, mergedDuplicate, emailFirst: true }
        });
        return state.leads;
      });
      return send(res, 200, { leads: saved });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/saved-searches") {
    try {
      const body = await readJson(req);
      const saved = await mutateStore(state => {
        const search = {
          id: newId("search"),
          name: body.name || `${body.trade || "Trade"} in ${body.area || body.city || "Market"}`,
          trade: body.trade || "",
          city: body.city || "",
          state: body.state || "",
          zip: body.zip || "",
          radius: body.radius || 25,
          count: body.count || 10,
          createdAt: new Date().toISOString()
        };
        state.savedSearches.unshift(search);
        state.auditLog.unshift({ id: newId("audit"), at: new Date().toISOString(), action: "saved_search_created", details: search });
        return search;
      });
      return send(res, 200, { savedSearch: saved });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/campaigns") {
    try {
      const body = await readJson(req);
      const campaign = await mutateStore(state => {
        const next = { id: newId("campaign"), createdAt: new Date().toISOString(), ...buildCampaign(body) };
        state.campaigns.unshift(next);
        state.auditLog.unshift({ id: newId("audit"), at: new Date().toISOString(), action: "campaign_created", details: { id: next.id, name: next.name } });
        return next;
      });
      return send(res, 200, { campaign });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/campaigns/enroll") {
    try {
      const body = await readJson(req);
      const campaign = { ...(body.campaign || buildCampaign(body)) };
      const currentState = await readStore();
      hydrateSentEmailHistory(currentState);
      const contactedKeys = contactedKeySet(currentState.leads || []);
      const sourceLeads = Array.isArray(body.leads) ? body.leads : currentState.leads;
      const candidates = sourceLeads
        .filter(emailReadyLead)
        .filter(lead => Number(lead.callCatchFitScore || 0) >= Number(campaign.minFitScore || 68))
        .filter(lead => !campaign.trade || lead.trade === campaign.trade)
        .filter(lead => !taskMatchesContacted({ channel: "email", leadId: lead.id, business: lead.business, website: lead.website, city: lead.city, state: lead.state, to: lead.email, title: "Cold Email" }, lead, contactedKeys));
      const enrichedCandidates = [];
      for (const lead of candidates) {
        enrichedCandidates.push(await enrichLeadForOutreach(lead));
      }
      const result = await mutateStore(state => {
        const campaign = { ...(body.campaign || buildCampaign(body)), variantStats: state.sending?.variantStats || {} };
        const tasks = enrichedCandidates.flatMap(lead => buildSequenceTasks(lead, campaign, outreachAssets(lead))
          .filter(task => !body.mobileEmailOnly || task.channel === "email")
          .map(task => ({ ...task, id: newId("task"), createdAt: new Date().toISOString() })));
        state.leads = (state.leads || []).map(existing => enrichedCandidates.find(lead => lead.id && lead.id === existing.id) || existing);
        state.approvalQueue.unshift(...tasks);
        state.approvalQueue = compactApprovalQueue(state.approvalQueue || [], state.leads || []);
        const savedTasks = tasks.filter(task => state.approvalQueue.some(item => item.id === task.id));
        state.auditLog.unshift({ id: newId("audit"), at: new Date().toISOString(), action: "campaign_enrolled", details: { campaign: campaign.name, leads: enrichedCandidates.length, tasks: savedTasks.length, skippedWorked: tasks.length - savedTasks.length, enriched: true } });
        return { leads: enrichedCandidates.length, enrichedLeads: enrichedCandidates, tasks: savedTasks, skippedWorked: tasks.length - savedTasks.length };
      });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/approval-queue") {
    try {
      const body = await readJson(req);
      const saved = await mutateStore(state => {
        const items = Array.isArray(body.items) ? body.items : [];
        state.approvalQueue = state.approvalQueue || [];
        hydrateSentEmailHistory(state);
        if (body.replace === true) {
          const normalized = items.map(item => ({ id: item.id || newId("task"), createdAt: item.createdAt || new Date().toISOString(), status: item.status || "Needs Approval", ...item }));
          state.approvalQueue = compactApprovalQueue(normalized, state.leads || []);
          state.auditLog.unshift({
            id: newId("audit"),
            at: new Date().toISOString(),
            action: "approval_queue_replaced",
            details: { count: state.approvalQueue.length }
          });
          return state.approvalQueue;
        }
        if (items.length === 0) {
          state.approvalQueue = compactApprovalQueue(state.approvalQueue, state.leads || []);
          return state.approvalQueue;
        }
        const normalized = items.map(item => ({ id: item.id || newId("task"), createdAt: item.createdAt || new Date().toISOString(), status: item.status || "Needs Approval", ...item }));
        const incomingIds = new Set(normalized.map(item => item.id));
        const existing = new Map(state.approvalQueue.map(item => [item.id, item]));
        const mergedIncoming = normalized.map(item => ({ ...(existing.get(item.id) || {}), ...item }));
        const untouched = state.approvalQueue.filter(item => !incomingIds.has(item.id));
        state.approvalQueue = compactApprovalQueue(mergedIncoming.concat(untouched), state.leads || []);
        state.auditLog.unshift({ id: newId("audit"), at: new Date().toISOString(), action: "approval_queue_updated", details: { count: normalized.length } });
        return state.approvalQueue;
      });
      return send(res, 200, { items: saved });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/outreach/generate") {
    try {
      const body = await readJson(req);
      const lead = body.scan === false ? (body.lead || {}) : await enrichLeadForOutreach(body.lead || {});
      return send(res, 200, { lead, assets: outreachAssets(lead) });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/audit-log") {
    const state = await readStore();
    return send(res, 200, { auditLog: state.auditLog || [] });
  }

  if (req.method === "GET" && url.pathname === "/api/export/json") {
    const state = await readStore();
    return send(res, 200, state);
  }

  if (req.method === "GET" && url.pathname === "/api/email/status") {
    const config = emailConfig();
    const provider = activeProvider(config);
    return send(res, 200, {
      configured: emailConfigured(config),
      provider,
      host: config.host || "",
      port: config.port,
      secure: config.secure,
      from: config.from || "",
      fromName: config.fromName || "",
      apiConfigured: provider === "resend" || provider === "brevo",
      user: config.user ? config.user.replace(/^(.{2}).*(@.*)?$/, "$1***$2") : ""
    });
  }

  if (req.method === "POST" && url.pathname === "/api/email/send-test") {
    try {
      const body = await readJson(req);
      const result = await sendEmail({
        to: body.to,
        subject: body.subject || "CallCatch email test",
        body: body.body || "This is a CallCatch email delivery test."
      });
      await audit("email_test_sent", { to: result.to, messageId: result.messageId });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/sms/status") {
    const config = smsConfig();
    return send(res, 200, {
      configured: smsConfigured(config),
      provider: config.provider,
      from: config.fromNumber || "",
      messagingService: config.messagingServiceSid ? `${config.messagingServiceSid.slice(0, 6)}...${config.messagingServiceSid.slice(-4)}` : "",
      account: config.accountSid ? `${config.accountSid.slice(0, 6)}...${config.accountSid.slice(-4)}` : "",
      source: config.source
    });
  }

  if (req.method === "POST" && url.pathname === "/api/sms/send-test") {
    try {
      const body = await readJson(req);
      const result = await sendSms({
        to: body.to,
        body: body.body || "CallCatch SMS delivery test."
      });
      await audit("sms_test_sent", { to: result.to, messageId: result.messageId });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && ["/api/email/opened", "/api/email/clicked"].includes(url.pathname)) {
    try {
      const body = await readJson(req);
      const eventType = url.pathname.endsWith("opened") ? "opened" : "clicked";
      const result = await mutateStore(state => {
        state.sending = state.sending || {};
        state.sending.metrics = state.sending.metrics || {};
        state.sending.variantStats = state.sending.variantStats || {};
        const task = (state.approvalQueue || []).find(item => item.id === body.taskId);
        if (!task) throw new Error("Task not found");
        const lead = (state.leads || []).find(item => item.id === task.leadId) || {};
        task[eventType === "opened" ? "openedAt" : "clickedAt"] = new Date().toISOString();
        state.sending.metrics[eventType] = Number(state.sending.metrics[eventType] || 0) + 1;
        const trade = lead.trade || "Unknown";
        const variant = task.emailVariant || "A";
        state.sending.variantStats[trade] = state.sending.variantStats[trade] || {};
        state.sending.variantStats[trade][variant] = state.sending.variantStats[trade][variant] || { sent: 0, opened: 0, replies: 0, meetings: 0 };
        if (eventType === "opened") state.sending.variantStats[trade][variant].opened += 1;
        state.auditLog.unshift({ id: newId("audit"), at: new Date().toISOString(), action: `email_${eventType}`, details: { taskId: task.id, leadId: lead.id || "" } });
        return { task, lead };
      });
      return send(res, 200, { ok: true, event: eventType, ...result });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/email/send-approved") {
    try {
      const result = await mutateStore(async state => {
        const queue = state.approvalQueue || [];
        const leads = state.leads || [];
        const approved = queue.filter(item => item.channel === "email" && /^approved/i.test(item.status || ""));
        const sent = [];
        const failed = [];

        for (const item of approved) {
          const lead = leads.find(candidate => candidate.id === item.leadId) || {};
          const to = parseEmail(item.to || item.recipient || lead.email);
          if (!to) {
            item.status = "Needs Email";
            failed.push({ id: item.id, business: item.business, error: "No recipient email found" });
            continue;
          }
          try {
            const sendResult = await sendEmail({ to, task: item, lead });
            item.status = "Sent";
            item.sentAt = sendResult.sentAt;
            item.messageId = sendResult.messageId;
            lead.lastContact = sendResult.sentAt.slice(0, 10);
            lead.stage = lead.stage === "New" ? "Contacted" : lead.stage;
            lead.timeline = lead.timeline || [];
            lead.timeline.unshift({ at: sendResult.sentAt, text: `Email sent: ${item.title || "Approved email"}` });
            lead.sentEmails = lead.sentEmails || [];
            lead.sentEmails.unshift({
              id: newId("sent"),
              taskId: item.id,
              title: item.title || "Approved email",
              to,
              subject: String(item.body || "").split(/\r?\n/).find(line => /^subject:/i.test(line))?.replace(/^subject:\s*/i, "") || "CallCatch follow-up",
              sentAt: sendResult.sentAt,
              provider: sendResult.provider || "email",
              messageId: sendResult.messageId
            });
            lead.sentEmails = lead.sentEmails.slice(0, 100);
            sent.push({ id: item.id, business: item.business, to, messageId: sendResult.messageId });
          } catch (error) {
            item.status = "Send Failed";
            item.error = error.message;
            failed.push({ id: item.id, business: item.business, error: error.message });
          }
        }

        state.auditLog.unshift({
          id: newId("audit"),
          at: new Date().toISOString(),
          action: "approved_emails_sent",
          details: { sent: sent.length, failed: failed.length }
        });

        return { sent, failed };
      });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/sending/metrics") {
    const state = await readStore();
    return send(res, 200, sendingMetrics(state));
  }

  if (req.method === "POST" && url.pathname === "/api/sending/settings") {
    try {
      const body = await readJson(req);
      const settings = await mutateStore(state => {
        state.sending = state.sending || {};
        state.sending.limits = {
          ...(state.sending.limits || {}),
          maxPerHour: Number(body.maxPerHour || 20),
          maxPerDay: Number(body.maxPerDay || 100),
          minDelaySeconds: Number(body.minDelaySeconds || 45),
          maxDelaySeconds: Number(body.maxDelaySeconds || 180)
        };
        state.auditLog.unshift({ id: newId("audit"), at: new Date().toISOString(), action: "sending_settings_updated", details: state.sending.limits });
        return state.sending.limits;
      });
      return send(res, 200, { settings });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/sending/send-now") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => sendTaskNow(state, body.taskId));
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/sending/send-all-approved") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => sendApprovedBatch(state, { limit: body.limit, taskIds: body.taskIds }));
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/sending/schedule") {
    try {
      const body = await readJson(req);
      const job = await mutateStore(state => scheduleTask(state, { taskId: body.taskId, when: body.when }));
      return send(res, 200, { job });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/sending/run-due") {
    try {
      const results = await mutateStore(state => runDueScheduled(state));
      return send(res, 200, { results });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/sending/generate-followups") {
    try {
      const body = await readJson(req);
      const generated = await mutateStore(state => generateFollowUps(state, { autoPilot: body.autoPilot }));
      return send(res, 200, { generated });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/sending/run-sequence") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => runSequenceAutomation(state, { autoPilot: body.autoPilot }));
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/replies/record") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => recordReply(state, body));
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && (url.pathname === "/api/replies/inbound" || url.pathname === "/api/webhooks/resend/inbound")) {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => recordReply(state, normalizeInboundReplyPayload(body, req.headers)));
      return send(res, 200, { accepted: true, ...result });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/replies/resolve") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => {
        const lead = (state.leads || []).find(item => item.id === body.leadId);
        if (!lead) throw new Error("Lead not found");
        const reply = (lead.replies || []).find(item => item.id === body.replyId);
        if (!reply) throw new Error("Reply not found");
        reply.status = "Handled";
        reply.handledAt = new Date().toISOString();
        lead.timeline = lead.timeline || [];
        lead.timeline.unshift({ at: reply.handledAt, text: "Reply marked handled" });
        state.auditLog.unshift({ id: newId("audit"), at: reply.handledAt, action: "reply_handled", details: { leadId: lead.id, replyId: reply.id } });
        return { lead, reply };
      });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/daily-growth") {
    const state = await readStore();
    const config = mergeConfig(state.dailyGrowth || {});
    return send(res, 200, {
      config,
      capabilities: automationCapabilities(config),
      lastRun: (state.jobs || []).find(job => job.type === "daily-growth") || null
    });
  }

  if (req.method === "POST" && url.pathname === "/api/daily-growth/settings") {
    try {
      const body = await readJson(req);
      const config = await mutateStore(state => {
        state.dailyGrowth = mergeConfig(body);
        state.auditLog.unshift({
          id: newId("audit"),
          at: new Date().toISOString(),
          action: "daily_growth_settings_updated",
          details: {
            enabled: state.dailyGrowth.enabled,
            runTime: state.dailyGrowth.runTime,
            automationLevel: state.dailyGrowth.automationLevel,
            scoreThreshold: state.dailyGrowth.scoreThreshold
          }
        });
        return state.dailyGrowth;
      });
      return send(res, 200, {
        config,
        capabilities: automationCapabilities(config)
      });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/daily-growth/start") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(async state => {
        state.dailyGrowth = mergeConfig({ ...(state.dailyGrowth || DEFAULT_DAILY_GROWTH), ...body, enabled: true });
        return runDailyGrowth({ state, config: state.dailyGrowth });
      });
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/daily-growth/run") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(async state => runDailyGrowth({
        state,
        config: mergeConfig({ ...(state.dailyGrowth || DEFAULT_DAILY_GROWTH), ...body })
      }));
      return send(res, 200, result);
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  log("info", "server_started", {
    url: HOST === "0.0.0.0" ? `http://0.0.0.0:${PORT}` : `http://127.0.0.1:${PORT}`,
    requiresApiKey: false
  });
  runBackgroundAutomation();
  setInterval(runBackgroundAutomation, 30 * 60 * 1000);
});
