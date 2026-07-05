const { searchLeads } = require("./searchEngine");
const { scanWebsite } = require("./websiteScanner");
const { enrichProspect, outreachAssets } = require("./prospectIntelligence");
const { buildCampaign, buildSequenceTasks } = require("./campaigns");
const { newId } = require("./dataStore");

const DEFAULT_DAILY_GROWTH = {
  enabled: false,
  runTime: "08:00",
  automationLevel: "Assisted",
  states: ["TX", "FL", "AZ", "IL"],
  citiesByState: {
    TX: ["Dallas", "Houston", "Austin"],
    FL: ["Miami", "Orlando", "Tampa"],
    AZ: ["Phoenix", "Tucson", "Mesa"],
    IL: ["Chicago", "Aurora", "Naperville"]
  },
  trades: ["HVAC", "Plumbing", "Electrical", "Roofing"],
  scoreThreshold: 75,
  countPerSearch: 8,
  radius: 25,
  maxSearchesPerRun: 8,
  sendEnabled: false
};

function automationCapabilities(config = {}) {
  const mode = config.automationLevel || "Assisted";
  return {
    mode,
    canSearch: true,
    canResearch: true,
    canScore: true,
    canGenerateOutreach: true,
    canQueue: true,
    canSend: mode === "Auto Pilot" && Boolean(config.sendEnabled),
    sendingStatus: mode === "Auto Pilot" && config.sendEnabled ? "enabled" : "adapter-required"
  };
}

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_DAILY_GROWTH,
    ...config,
    citiesByState: {
      ...DEFAULT_DAILY_GROWTH.citiesByState,
      ...(config.citiesByState || {})
    }
  };
}

function leadKey(lead) {
  return [
    String(lead.business || "").toLowerCase(),
    String(lead.phone || "").toLowerCase(),
    String(lead.website || "").toLowerCase()
  ].join("|");
}

function hasEmail(lead) {
  return !!String(lead.email || "").trim();
}

function buildSearchPlan(config) {
  const searches = [];
  for (const state of config.states) {
    const cities = config.citiesByState[state] || [];
    for (const city of cities) {
      for (const trade of config.trades) {
        searches.push({ trade, city, state, area: `${city}, ${state}`, radius: config.radius, count: config.countPerSearch });
      }
    }
  }
  return searches.slice(0, config.maxSearchesPerRun);
}

async function enrichLead(lead) {
  if (!lead.website) return enrichProspect(lead, {});
  const scan = await scanWebsite(lead.website);
  return enrichProspect({ ...lead, email: lead.email || (scan.emails || [])[0] || "", phone: lead.phone || (scan.phones || [])[0] || "" }, scan);
}

function makeApprovalTasks(lead, campaign) {
  const assets = outreachAssets(lead);
  return buildSequenceTasks(lead, campaign, {
    email: assets.email,
    linkedin: assets.linkedinFirstMessage || assets.linkedinConnection,
    call: assets.callScript,
    sms: assets.sms
  }).map(task => ({
    ...task,
    id: newId("task"),
    createdAt: new Date().toISOString(),
    status: "Needs Approval",
    automationLevel: campaign.automationLevel || "Assisted"
  }));
}

async function runDailyGrowth({ state, config: rawConfig }) {
  const config = mergeConfig(rawConfig);
  const startedAt = new Date().toISOString();
  const capabilities = automationCapabilities(config);
  const searchPlan = buildSearchPlan(config);
  const existingKeys = new Set((state.leads || []).map(leadKey));
  const discovered = [];
  const errors = [];

  for (const search of searchPlan) {
    try {
      const result = await searchLeads(search);
      for (const lead of result.leads || []) {
        const key = leadKey(lead);
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          discovered.push({ ...lead, state: lead.state || search.state, city: lead.city || search.city });
        }
      }
    } catch (error) {
      errors.push({ search, error: error.message });
    }
  }

  const enriched = [];
  for (const lead of discovered) {
    try {
      enriched.push(await enrichLead(lead));
    } catch {
      enriched.push(enrichProspect(lead, {}));
    }
  }

  const qualified = enriched
    .filter(hasEmail)
    .filter(lead => Number(lead.callCatchFitScore || 0) >= Number(config.scoreThreshold || 75))
    .map(lead => ({
      ...lead,
      id: lead.id || newId("lead"),
      stage: lead.stage || "New",
      assignedTeamMember: lead.assignedTeamMember || "Sales Team",
      timeline: [
        { at: new Date().toISOString(), text: "Added by Daily Growth automation" },
        ...(lead.timeline || [])
      ]
    }));

  const campaign = {
    ...buildCampaign({
      name: "Daily Growth Sequence",
      minFitScore: config.scoreThreshold
    }),
    automationLevel: config.automationLevel
  };
  const tasks = qualified.flatMap(lead => makeApprovalTasks(lead, campaign));
  const sent = capabilities.canSend ? tasks.length : 0;

  state.leads = qualified.concat(state.leads || []);
  state.approvalQueue = tasks.concat(state.approvalQueue || []);
  state.jobs = state.jobs || [];
  const summary = {
    id: newId("job"),
    type: "daily-growth",
    startedAt,
    finishedAt: new Date().toISOString(),
    automationLevel: config.automationLevel,
    searchesRun: searchPlan.length,
    newBusinesses: discovered.length,
    qualified: qualified.length,
    emailsReady: tasks.filter(task => task.channel === "email").length,
    linkedinReady: tasks.filter(task => task.channel === "linkedin").length,
    followUpsDue: tasks.filter(task => task.title.toLowerCase().includes("follow")).length,
    sent,
    repliesYesterday: 0,
    demoRequests: 0,
    revenuePipeline: qualified.reduce((sum, lead) => sum + Number(lead.revenueOpportunityEstimate || 0), 0),
    errors,
    capabilities
  };
  state.jobs.unshift(summary);
  state.jobs = state.jobs.slice(0, 100);
  state.auditLog.unshift({
    id: newId("audit"),
    at: new Date().toISOString(),
    action: "daily_growth_run",
    details: summary
  });

  return summary;
}

module.exports = {
  DEFAULT_DAILY_GROWTH,
  automationCapabilities,
  mergeConfig,
  runDailyGrowth
};
