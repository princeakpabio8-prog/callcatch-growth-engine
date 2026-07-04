function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function tradeValue(trade) {
  const values = {
    HVAC: 850,
    Plumbing: 625,
    Electrical: 650,
    Roofing: 3500,
    "Garage Doors": 475,
    Landscaping: 550,
    "Pest Control": 275,
    Cleaning: 220,
    Painting: 1800,
    Locksmith: 225,
    "Appliance Repair": 325,
    "Tree Service": 1400,
    Flooring: 2800,
    Solar: 12000,
    "Pool Services": 500,
    "Junk Removal": 350
  };
  return values[trade] || 600;
}

function emergencyTrade(trade) {
  return ["HVAC", "Plumbing", "Electrical", "Garage Doors", "Locksmith", "Appliance Repair", "Tree Service", "Pest Control"].includes(trade);
}

function buildInsights(lead, scan = {}) {
  const insights = [];
  if (!lead.website) insights.push("No website listed in public data");
  if (scan.ok === false && lead.website) insights.push("Website could not be scanned");
  if (scan.websiteQualityScore && scan.websiteQualityScore < 45) insights.push("Website appears weak or incomplete");
  if (scan.noOnlineBooking) insights.push("No online booking detected");
  if (scan.noChatDetected) insights.push("No live chat or AI chatbot detected");
  if (!lead.email && !(scan.emails || []).length) insights.push("No public email detected");
  if (lead.reviews && lead.reviews < 40) insights.push("Small review count");
  if (scan.emergencyService || emergencyTrade(lead.trade)) insights.push("Emergency or urgent-service category");
  if (scan.emergencyService) insights.push("Emergency service messaging detected");
  if (scan.financing) insights.push("Financing language detected");
  if (!scan.businessHours) insights.push("Business hours not clearly detected");
  return insights;
}

function recommendedAngle(lead, insights) {
  if (insights.some(item => item.includes("Emergency")) || emergencyTrade(lead.trade)) {
    return "Lead with missed emergency calls: customers with urgent needs often call the next company within minutes.";
  }
  if (insights.some(item => item.includes("No online booking"))) {
    return "Lead with instant text-back as the simplest conversion upgrade before investing in a full booking system.";
  }
  if (insights.some(item => item.includes("weak"))) {
    return "Lead with customer experience: CallCatch gives them a modern response layer even if the website is outdated.";
  }
  return "Lead with revenue recovery: show how a few recovered missed callers can pay for CallCatch quickly.";
}

function estimateRevenue(lead, scan = {}) {
  const baseCalls = emergencyTrade(lead.trade) ? 70 : 42;
  const digitalPenalty = scan.websiteQualityScore ? Math.max(0, 60 - scan.websiteQualityScore) / 3 : 12;
  const missedRate = Math.min(32, 14 + digitalPenalty + (emergencyTrade(lead.trade) ? 5 : 0));
  const closeRate = emergencyTrade(lead.trade) ? 24 : 18;
  const missedMonthly = baseCalls * 4.33 * (missedRate / 100);
  const jobs = missedMonthly * (closeRate / 100);
  const revenue = jobs * tradeValue(lead.trade);
  return {
    averageJobValue: tradeValue(lead.trade),
    estimatedMonthlyMissedCalls: Math.round(missedMonthly),
    estimatedRecoverableJobs: Number(jobs.toFixed(1)),
    revenueOpportunityEstimate: Math.round(revenue)
  };
}

function enrichProspect(lead, scan = {}) {
  const insights = buildInsights(lead, scan);
  const revenue = estimateRevenue(lead, scan);
  const websiteScore = scan.websiteQualityScore ?? (lead.website ? 45 : 10);
  const digitalScore = scan.digitalPresenceScore ?? websiteScore;
  let fit = 42;
  fit += emergencyTrade(lead.trade) ? 15 : 7;
  fit += lead.phone ? 10 : 0;
  fit += lead.website ? 6 : 0;
  fit += websiteScore < 45 ? 10 : 0;
  fit += scan.noOnlineBooking ? 8 : 0;
  fit += scan.noChatDetected ? 5 : 0;
  fit += revenue.revenueOpportunityEstimate > 3000 ? 10 : 0;
  const callCatchFitScore = clamp(fit);
  const opportunityLevel = callCatchFitScore >= 78 ? "High" : callCatchFitScore >= 58 ? "Medium" : "Nurture";
  const responsePriority = callCatchFitScore >= 82 ? "Today" : callCatchFitScore >= 65 ? "This Week" : "Nurture";

  return {
    ...lead,
    ...revenue,
    callCatchFitScore,
    websiteQualityScore: websiteScore,
    digitalPresenceScore: digitalScore,
    aiOpportunityLevel: opportunityLevel,
    responsePriority,
    aiInsights: insights,
    recommendedSalesAngle: recommendedAngle(lead, insights),
    websiteIntelligence: scan
  };
}

function outreachAssets(lead) {
  const angle = lead.recommendedSalesAngle || "Lead with revenue recovery from missed calls.";
  const value = lead.revenueOpportunityEstimate || 0;
  return {
    email: `Subject: Missed calls at ${lead.business}\n\nHi,\n\nQuick idea for ${lead.business}. ${angle}\n\nCallCatch texts missed callers instantly so they do not move on to the next company. Based on your category, the monthly missed-call opportunity could be around $${value.toLocaleString()} in job value.\n\nWorth a 15-minute walkthrough?`,
    linkedinConnection: `Hi, I work with home-service businesses on missed-call recovery. Thought ${lead.business} might be a fit.`,
    linkedinFirstMessage: `Thanks for connecting. ${angle} CallCatch helps recover missed callers with instant text-back. Open to seeing the 2-minute version?`,
    sms: `Hi, quick idea for ${lead.business}: CallCatch texts missed callers instantly so they do not call the next company. Worth a quick look?`,
    callScript: `Opening: I help ${lead.trade} companies recover jobs from missed calls.\n\nDiscovery: When do you miss the most calls? After hours, while driving, or during jobs?\n\nAngle: ${angle}\n\nClose: Want me to show what the customer sees after a missed call?`,
    objections: `Already call back: Totally. The problem is timing; many customers call the next company within minutes.\nToo busy: Setup is designed to be simple and approval-first.\nNot sure we miss calls: One urgent job can make the math obvious.`
  };
}

module.exports = { enrichProspect, outreachAssets };
