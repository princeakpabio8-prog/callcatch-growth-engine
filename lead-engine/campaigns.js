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

function variantScore(stats = {}) {
  const sent = Number(stats.sent || 0);
  if (!sent) return 0;
  return ((Number(stats.replies || 0) * 2) + (Number(stats.meetings || 0) * 4) + Number(stats.opened || 0)) / sent;
}

function orderedVariants(lead, campaign) {
  const tradeStats = (campaign.variantStats || {})[lead.trade] || {};
  return ["A", "B"].sort((left, right) => variantScore(tradeStats[right]) - variantScore(tradeStats[left]));
}

function buildSequenceTasks(lead, campaign, outreachAssets) {
  const start = new Date();
  const bodyFor = (step, variant = "") => {
    if (step.channel === "linkedin") return step.title.toLowerCase().includes("connection") ? outreachAssets.linkedinConnection : outreachAssets.linkedinFirstMessage;
    if (step.channel === "email" && variant === "B") return outreachAssets.emailB || outreachAssets.email;
    if (step.channel === "email" && variant === "A") return outreachAssets.emailA || outreachAssets.email;
    return outreachAssets[step.channel] || outreachAssets.email || "";
  };
  return campaign.sequence.flatMap(step => {
    const variants = step.channel === "email" ? orderedVariants(lead, campaign) : [""];
    return variants.map(variant => ({
    leadId: lead.id,
    business: lead.business,
    to: step.channel === "email" ? (lead.email || "") : "",
    recipient: step.channel === "email" ? (lead.email || "") : "",
    campaignName: campaign.name,
    channel: step.channel,
    title: variant ? `${step.title} - Version ${variant}` : step.title,
    emailVariant: variant,
    dueDate: addDays(start, Number(step.day) - 1),
    status: "Needs Approval",
    body: bodyFor(step, variant),
    safety: "Not sent. Human approval required."
    }));
  });
}

module.exports = {
  DEFAULT_SEQUENCE,
  buildCampaign,
  buildSequenceTasks
};
