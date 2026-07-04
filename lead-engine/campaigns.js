const DEFAULT_SEQUENCE = [
  { day: 1, channel: "email", title: "Cold Email" },
  { day: 3, channel: "linkedin", title: "LinkedIn Connection" },
  { day: 5, channel: "email", title: "Follow-up Email" },
  { day: 7, channel: "call", title: "Phone Call Reminder" },
  { day: 10, channel: "email", title: "Final Email" }
];

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
}

function buildCampaign({ name = "Default Outbound Sequence", minFitScore = 68, trade = "", sequence = DEFAULT_SEQUENCE } = {}) {
  return {
    name,
    minFitScore: Number(minFitScore) || 68,
    trade,
    status: "Draft",
    automationMode: "Review before sending",
    stopOnReplyOrBooked: true,
    sequence
  };
}

function buildSequenceTasks(lead, campaign, outreachAssets) {
  const start = new Date();
  const bodyFor = step => {
    if (step.channel === "linkedin") return step.title.toLowerCase().includes("connection") ? outreachAssets.linkedinConnection : outreachAssets.linkedinFirstMessage;
    return outreachAssets[step.channel] || outreachAssets.email || "";
  };
  return campaign.sequence.map(step => ({
    leadId: lead.id,
    business: lead.business,
    to: step.channel === "email" ? (lead.email || "") : "",
    recipient: step.channel === "email" ? (lead.email || "") : "",
    campaignName: campaign.name,
    channel: step.channel,
    title: step.title,
    dueDate: addDays(start, Number(step.day) - 1),
    status: "Needs Approval",
    body: bodyFor(step),
    safety: "Not sent. Human approval required."
  }));
}

module.exports = {
  DEFAULT_SEQUENCE,
  buildCampaign,
  buildSequenceTasks
};
