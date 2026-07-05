const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { URL } = require("url");
const { searchLeads } = require("./lead-engine/searchEngine");
const { fetchJson } = require("./lead-engine/httpClient");
const { scanWebsite } = require("./lead-engine/websiteScanner");
const { enrichProspect, outreachAssets } = require("./lead-engine/prospectIntelligence");
const { audit, mutateStore, newId, readStore } = require("./lead-engine/dataStore");
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

function emailReadyLead(lead = {}) {
  return !!String(lead.email || "").trim();
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
      providers: ["nominatim", "openstreetmap"],
      modules: ["prospect-intelligence", "website-scanner", "approval-queue"],
      automation: ["daily-growth", "campaign-sequences", "approval-first-autopilot"],
      sendingEngine: ["send-now", "bulk-send", "scheduled-send", "rate-limits", "reply-tracking"],
      storage: "json-file",
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
    const state = await readStore();
    return send(res, 200, state);
  }

  if (req.method === "POST" && url.pathname === "/api/crm/leads") {
    try {
      const body = await readJson(req);
      const incoming = Array.isArray(body.leads) ? body.leads : [];
      const saved = await mutateStore(state => {
        const existing = new Map(state.leads.map(lead => [lead.id, lead]));
        const companyKeys = new Set(state.leads.map(normalizeCompanyKey));
        let skippedNoEmail = 0;
        let skippedDuplicate = 0;
        incoming.forEach(lead => {
          const id = lead.id || newId("lead");
          const alreadySaved = existing.has(id);
          const key = normalizeCompanyKey(lead);
          if (!emailReadyLead(lead) && !alreadySaved) {
            skippedNoEmail += 1;
            return;
          }
          if (!alreadySaved && companyKeys.has(key)) {
            skippedDuplicate += 1;
            return;
          }
          companyKeys.add(key);
          existing.set(id, { ...lead, id, updatedAt: new Date().toISOString() });
        });
        state.leads = [...existing.values()].filter(emailReadyLead);
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
          details: { count: incoming.length, skippedNoEmail, skippedDuplicate, emailFirst: true }
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
      const sourceLeads = Array.isArray(body.leads) ? body.leads : (await readStore()).leads;
      const candidates = sourceLeads
        .filter(emailReadyLead)
        .filter(lead => Number(lead.callCatchFitScore || 0) >= Number(campaign.minFitScore || 68))
        .filter(lead => !campaign.trade || lead.trade === campaign.trade);
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
        state.auditLog.unshift({ id: newId("audit"), at: new Date().toISOString(), action: "campaign_enrolled", details: { campaign: campaign.name, leads: enrichedCandidates.length, tasks: tasks.length, enriched: true } });
        return { leads: enrichedCandidates.length, enrichedLeads: enrichedCandidates, tasks };
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
        if (items.length === 0) return state.approvalQueue;
        const normalized = items.map(item => ({ id: item.id || newId("task"), createdAt: item.createdAt || new Date().toISOString(), status: item.status || "Needs Approval", ...item }));
        const incomingIds = new Set(normalized.map(item => item.id));
        const existing = new Map(state.approvalQueue.map(item => [item.id, item]));
        const mergedIncoming = normalized.map(item => ({ ...(existing.get(item.id) || {}), ...item }));
        const untouched = state.approvalQueue.filter(item => !incomingIds.has(item.id));
        state.approvalQueue = mergedIncoming.concat(untouched);
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

  if (req.method === "POST" && url.pathname === "/api/replies/inbound") {
    try {
      const body = await readJson(req);
      const result = await mutateStore(state => recordReply(state, {
        leadId: body.leadId,
        taskId: body.taskId,
        from: body.from || body.sender || body.replyFrom,
        body: body.body || body.text || body.message
      }));
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
