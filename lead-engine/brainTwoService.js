const fs = require("fs");
const path = require("path");

const BRAIN_TWO_VERSION = "brain-two-v1.0";
const RUNTIME_PROMPT = fs.readFileSync(path.join(__dirname, "..", "brains", "brain-two-runtime.md"), "utf8");
const outputSchema = require("../schemas/brain-two-output.json");

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function uniqueArray(items = []) {
  return [...new Set(items.filter(item => item !== null && item !== undefined && item !== ""))];
}

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function flattenBrainOneOutput(value = {}) {
  if (!value.modules) return value || {};
  return {
    ...(value.modules.foundation?.output || {}),
    ...(value.modules.digital_intelligence?.output || {}),
    ...(value.modules.opportunities?.output || {}),
    ...(value.modules.strategic_interpretation?.output || {}),
    ...(value.modules.contact_decision?.output || {})
  };
}

function brainOneCombinedOutput(brainOneRun = {}) {
  return brainOneRun.phaseAOutput || brainOneRun.validatedOutput || {};
}

function brainOneFlatOutput(brainOneRun = {}) {
  return flattenBrainOneOutput(brainOneCombinedOutput(brainOneRun));
}

function evidenceIdList(value = {}) {
  if (!value || typeof value !== "object") return [];
  const found = [];
  const visit = item => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (Array.isArray(item.evidence_ids)) found.push(...item.evidence_ids);
  };
  visit(value);
  return uniqueArray(found);
}

function claimText(item = {}) {
  if (typeof item === "string") return item;
  return compact(item.claim || item.title || item.summary || item.opportunity || item.reasoning || item.value || "");
}

function isManualTestLead(lead = {}) {
  return !!(lead.testProspect || lead.manualTest || lead.outreachDisabled || lead.analysis_mode === "manual_test");
}

function contactPaths(lead = {}, flat = {}) {
  const contacts = Array.isArray(flat.contacts) ? flat.contacts : [];
  const emails = uniqueArray([
    lead.email,
    ...contacts.map(item => item.contact_email)
  ].map(item => compact(item, 160)).filter(item => /@/.test(item)));
  const phones = uniqueArray([
    lead.phone,
    ...contacts.map(item => item.contact_phone)
  ].map(item => compact(item, 80)).filter(Boolean));
  const forms = uniqueArray([
    lead.websiteIntelligence?.contactForm ? "contact form" : "",
    flat.digital_health?.contact_form_detected ? "contact form" : ""
  ].filter(Boolean));
  return { emails, phones, forms, hasUsablePath: !!(emails.length || phones.length || forms.length) };
}

function brainTwoHandoff(flat = {}) {
  return flat.brain_two_handoff || {};
}

function handoffNeedsManualResearch(flat = {}) {
  const handoff = brainTwoHandoff(flat);
  const text = [
    handoff.summary,
    handoff.status,
    handoff.research_status,
    ...(handoff.information_gaps || []),
    ...(flat.contact_decision?.information_gaps || [])
  ].join(" ").toLowerCase();
  return handoff.needs_manual_research === true
    || handoff.manual_research_required === true
    || /manual research|research needed|find contact|verify contact|no verified contact/.test(text);
}

function brainOneDecision(flat = {}) {
  return flat.contact_decision?.decision || flat.contact_decision?.recommendation_status || "";
}

function approvedBrainOne(brainOneRun = {}) {
  return /^approved/i.test(brainOneRun.approvalStatus || "");
}

function evaluateBrainTwoEligibility({ lead = {}, brainOneRun = {} } = {}) {
  brainOneRun = brainOneRun || {};
  const reasons = [];
  if (!brainOneRun || !brainOneRun.id) reasons.push("Brain One has not run.");
  if (brainOneRun.id && brainOneRun.executionStatus !== "completed") reasons.push("Brain One has not completed.");
  if (brainOneRun.id && !approvedBrainOne(brainOneRun)) reasons.push("Brain One has not been manually approved.");
  if (isManualTestLead(lead)) reasons.push("Lead is still in Manual Test mode.");

  const flat = brainOneFlatOutput(brainOneRun);
  const decision = brainOneDecision(flat);
  if (decision === "DO NOT CONTACT") reasons.push("Brain One decision is DO NOT CONTACT.");

  const paths = contactPaths(lead, flat);
  const manualResearchRequired = handoffNeedsManualResearch(flat);
  if (!paths.hasUsablePath && !manualResearchRequired) {
    reasons.push("No usable outreach path is available.");
  }

  const blocked = reasons.length > 0;
  return {
    eligible: !blocked,
    status: blocked ? "blocked" : manualResearchRequired && !paths.hasUsablePath ? "needs_review" : "eligible",
    reasons,
    brain_one_run_id: brainOneRun.id || "",
    manual_research_required: manualResearchRequired && !paths.hasUsablePath,
    contact_paths: paths
  };
}

function primaryEvidence(flat = {}) {
  return uniqueArray([
    ...evidenceIdList(flat.business_dna || {}),
    ...evidenceIdList(flat.hidden_opportunities || []),
    ...evidenceIdList(flat.ai_opportunity_radar || {}),
    ...evidenceIdList(flat.why_we_chose_you || {}),
    ...evidenceIdList(flat.one_day_action_plan || {}),
    ...evidenceIdList(flat.contact_decision || {})
  ]).slice(0, 12);
}

function choosePersona(lead = {}, flat = {}) {
  const trade = compact(lead.trade || (flat.business_dna?.primary_services || [])[0] || "").toLowerCase();
  const evidence = primaryEvidence(flat);
  const personas = [];
  const push = (persona, reasoning, confidence = "medium") => personas.push({ persona, rank: personas.length + 1, reasoning, confidence, evidence_ids: evidence.slice(0, 5) });
  if (/hvac|plumb|electric|roof|garage|locksmith|pest|landscap|clean|painting|appliance|tree|floor|solar|pool|junk/.test(trade)) {
    push("Owner or General Manager", "Home service buying decisions are usually owned by the operator or manager responsible for calls, dispatch, and revenue.", "medium");
    push("Office Manager or Dispatcher", "This persona is close to missed calls, booking friction, and follow-up speed.", "medium");
    push("Marketing Manager", "This persona may care about converting more inbound demand into booked jobs.", "low");
  } else {
    push("Revenue Operations or Growth Lead", "The strongest available evidence points to conversion, customer journey, or operational workflow improvements.", "medium");
    push("Operations Lead", "This persona is likely responsible for response workflows and customer handoff quality.", "medium");
    push("Founder or Business Owner", "Founder-level outreach is appropriate when the business appears smaller or when no specific department is verified.", "low");
  }
  return personas;
}

function selectedOpportunity(flat = {}) {
  const opportunities = Array.isArray(flat.hidden_opportunities) ? flat.hidden_opportunities : [];
  const sorted = [...opportunities].sort((a, b) => (Number(b.opportunity_priority_score) || 0) - (Number(a.opportunity_priority_score) || 0));
  return sorted[0] || null;
}

function chooseOffer(lead = {}, flat = {}) {
  const evidence = primaryEvidence(flat);
  const opportunity = selectedOpportunity(flat);
  const text = [
    opportunity?.title,
    opportunity?.specific_observed_problem,
    opportunity?.why_it_matters,
    flat.business_dna?.customer_journey,
    flat.digital_health?.summary,
    flat.ai_opportunity_radar?.conversion?.opportunity
  ].join(" ").toLowerCase();
  if (/after.?hours|missed call|emergency|urgent|voicemail|call/.test(text)) {
    return {
      name: "Missed Call Text-Back",
      description: "CallCatch can respond to missed callers by text so the prospect stays engaged until the team can call back.",
      reasoning: "The approved Brain One report points to response speed, calls, urgency, or customer journey friction.",
      evidence_ids: evidence.slice(0, 6)
    };
  }
  if (/booking|schedule|form|conversion|contact/.test(text)) {
    return {
      name: "Lead Response and Booking Recovery",
      description: "CallCatch can help keep inbound prospects engaged when the first contact attempt is missed.",
      reasoning: "The approved Brain One report points to conversion or booking-path friction.",
      evidence_ids: evidence.slice(0, 6)
    };
  }
  return {
    name: "Inbound Response Safety Net",
    description: "CallCatch helps reduce the risk of losing inbound prospects when a team cannot respond immediately.",
    reasoning: "The approved Brain One report supports a conservative response-speed angle without inventing specific losses.",
    evidence_ids: evidence.slice(0, 6)
  };
}

function chooseAngle(lead = {}, flat = {}) {
  const opportunity = selectedOpportunity(flat);
  const evidence = evidenceIdList(opportunity || {}).length ? evidenceIdList(opportunity) : primaryEvidence(flat);
  if (opportunity) {
    return {
      angle: compact(opportunity.title || opportunity.opportunity || "Improve inbound response quality", 180),
      reasoning: compact(opportunity.why_it_matters || opportunity.specific_observed_problem || "Selected from the highest-priority Brain One opportunity.", 300),
      claim_type: evidence.length ? "evidence_backed" : "soft_hypothesis",
      evidence_ids: evidence.slice(0, 8)
    };
  }
  return {
    angle: "Improve inbound response quality",
    reasoning: "Brain One did not validate a specific hidden opportunity, so Brain Two uses a soft, conservative response-speed angle.",
    claim_type: "soft_hypothesis",
    evidence_ids: primaryEvidence(flat).slice(0, 8)
  };
}

function businessName(lead = {}, flat = {}) {
  return compact(lead.business || flat.business_identity?.business_name || flat.business_identity?.name || "your team", 120);
}

function shortGreeting(name) {
  return name && name !== "your team" ? `Hi ${name} team,` : "Hi there,";
}

function wordCount(value = "") {
  return compact(value, 4000).split(/\s+/).filter(Boolean).length;
}

function stableIndex(seed = "", length = 1) {
  if (length <= 1) return 0;
  let hash = 2166136261;
  for (const char of String(seed || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function evidenceTextEntries(flat = {}) {
  const evidenceLog = Array.isArray(flat.evidence_log) ? flat.evidence_log : [];
  const facts = Array.isArray(flat.confirmed_facts) ? flat.confirmed_facts : [];
  return [
    ...evidenceLog.map(item => ({
      text: compact(item.excerpt || item.summary || item.title || item.value || "", 220),
      evidence_ids: item.id ? [item.id] : [],
      source_type: item.source_type || "",
      source_url: item.source_url || ""
    })),
    ...facts.map(item => ({
      text: compact(item.claim || item.summary || "", 220),
      evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [],
      source_type: "confirmed_fact",
      source_url: ""
    }))
  ].filter(item => item.text);
}

function observationFromText(entry = {}, lead = {}, flat = {}) {
  const text = compact(entry.text, 220);
  const lower = text.toLowerCase();
  const service = compact((flat.business_dna?.primary_services || [])[0] || lead.trade || "service", 60);
  if (/24\/7|24-7|after.?hours|emergency|urgent/.test(lower)) {
    return { sentence: `I noticed your website mentions emergency service.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/book|booking|schedule|appointment|contact form|form/.test(lower)) {
    return { sentence: `I noticed your website points people toward a booking or contact form.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/financ|payment plan|monthly payment/.test(lower)) {
    return { sentence: `I saw that your website mentions financing options.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/commercial|business|facility|property manager/.test(lower)) {
    return { sentence: `I noticed your website speaks to commercial customers.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (/review|testimonial|rated|stars|trusted/.test(lower)) {
    return { sentence: `I noticed your website leans on customer trust signals.`, evidence_ids: entry.evidence_ids || [] };
  }
  if (service) {
    return { sentence: `I was looking through your website and saw the focus on ${service}.`, evidence_ids: entry.evidence_ids || [] };
  }
  return { sentence: `I was looking through your website and noticed the service details you share for customers.`, evidence_ids: entry.evidence_ids || [] };
}

function websiteObservation(lead = {}, flat = {}) {
  const entries = evidenceTextEntries(flat);
  const websiteEntry = entries.find(item => /website|official|page/i.test(item.source_type || "") || /^https?:\/\//i.test(item.source_url || ""));
  const entry = websiteEntry || entries[0];
  if (entry) return observationFromText(entry, lead, flat);
  const service = compact((flat.business_dna?.primary_services || [])[0] || lead.trade || "", 60);
  return {
    sentence: service
      ? `I was looking through the approved research and saw the focus on ${service}.`
      : "I was looking through the approved research on your business.",
    evidence_ids: primaryEvidence(flat).slice(0, 2)
  };
}

function revenueLine(flat = {}) {
  const money = flat.money_left_on_table || {};
  if (money.status !== "estimated") return "";
  const low = Number(money.low_estimate);
  const high = Number(money.high_estimate);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) return "";
  const currency = money.currency || "$";
  const period = money.time_period ? ` per ${money.time_period}` : "";
  return `Based on the approved estimate, improving response may be worth roughly ${currency}${Math.round(low).toLocaleString()}-${currency}${Math.round(high).toLocaleString()}${period}, depending on the assumptions.`;
}

function naturalSubjectLines(name, style = "A") {
  const pool = [
    "Quick question",
    "Noticed something",
    "Question about your website",
    "Idea for your team",
    "One thing I noticed",
    "Small idea",
    "Worth a look?",
    name && name !== "your team" ? `Question for ${name}` : "Question for your team"
  ];
  const offset = stableIndex(`${name}|${style}|subjects`, pool.length);
  return uniqueArray([...pool.slice(offset), ...pool.slice(0, offset)]).slice(0, 5);
}

function softCta(seed = "") {
  const options = [
    "Worth a quick look?",
    "Happy to show you.",
    "If useful, I can send a short demo.",
    "I can show what I mean."
  ];
  return options[stableIndex(seed, options.length)];
}

function founderSignature(long = true) {
  return long
    ? ["Best,", "Prince Esien", "Founder | CallCatch", "hello@callcatch.site", "https://callcatch.site"].join("\n")
    : ["Best,", "Prince"].join("\n");
}

function styleEmail({ style, name, observation, offer, angle, cta, revenue = "" }) {
  const greeting = shortGreeting(name);
  const problem = angle.claim_type === "evidence_backed"
    ? "When a customer reaches out and nobody can respond right away, that moment can decide whether they wait or call someone else."
    : "For service teams, the small gap is often the calls that arrive while everyone is already busy.";
  const intro = "That is why I built CallCatch. It texts missed callers within seconds, so the conversation stays warm until someone can follow up.";
  if (style === "B") {
    return [
      greeting,
      "",
      observation.sentence,
      "",
      `${problem} ${revenue || "It may be a simple place to protect more of the demand you already worked to earn."}`,
      "",
      `${intro}`,
      "",
      "I built it after seeing how often good conversations are lost before anyone has a chance to reply. I am not assuming this is urgent, but it looked relevant enough to mention.",
      "",
      "The goal is just to keep a real prospect engaged until the team can respond.",
      "",
      offer.name ? `For your team, the fit looks like ${offer.name.toLowerCase()}.` : "",
      "",
      cta,
      "",
      founderSignature()
    ].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  if (style === "C") {
    return [
      greeting,
      "",
      `${observation.sentence} It made me wonder how calls are handled when the team is tied up on another job.`,
      "",
      "Most people with an urgent issue do not wait long or leave a voicemail. They usually call the next company that answers.",
      "",
      `${intro} ${revenue || "Nothing heavy, just a response safety net for the moments that are easy to miss."}`,
      "",
      cta,
      "",
      founderSignature()
    ].join("\n");
  }
  return [
    greeting,
    "",
    observation.sentence,
    "",
    "I built CallCatch for one simple reason: missed callers often move on before a busy team can call back.",
    "",
    `${offer.description} ${revenue || "It might be useful if even a few good calls slip through during busy hours."} I am not trying to overcomplicate it, just pointing out a small gap that is easy to miss.`,
    "",
    cta,
    "",
    founderSignature()
  ].join("\n");
}

function qualityCheckEmail(body = "", observation = {}) {
  const lower = body.toLowerCase();
  const wc = wordCount(body);
  const banned = ["revolutionary", "game changing", "ai powered", "next generation", "cutting edge", "state of the art"];
  const bannedHits = banned.filter(item => lower.includes(item));
  const ctaOk = /worth a quick look|happy to show you|short demo|show what i mean/i.test(body)
    && !/book a meeting|schedule a call|hop on zoom/i.test(body);
  const observationOk = observation.sentence && body.includes(observation.sentence);
  const lengthOk = wc >= 90 && wc <= 170;
  const shortParagraphs = body.split(/\n{2,}/).every(paragraph => paragraph.split(/[.!?]+/).filter(Boolean).length <= 3);
  const passed = !bannedHits.length && ctaOk && observationOk && lengthOk && shortParagraphs;
  const base = passed ? 10 : 8;
  return {
    human_sounding: base,
    personalization: observationOk ? 10 : 8,
    specificity: observationOk ? 10 : 8,
    reading_ease: shortParagraphs && wc <= 170 ? 10 : 8,
    founder_authenticity: !bannedHits.length && ctaOk ? 10 : 8,
    word_count: wc,
    passed,
    notes: passed ? "Passed deterministic founder-tone quality gate." : "Needs rewrite before use."
  };
}

function generateMessaging({ lead = {}, flat = {}, persona, angle, offer, runId = "" } = {}) {
  const name = businessName(lead, flat);
  const observation = websiteObservation(lead, flat);
  const styleLabels = ["A", "B", "C"];
  const selectedStyle = styleLabels[stableIndex(`${lead.id || ""}|${name}|${runId || ""}`, styleLabels.length)];
  const cta = softCta(`${lead.id || name}|${selectedStyle}`);
  const subjectLines = naturalSubjectLines(name, selectedStyle);
  const revenue = revenueLine(flat);
  const variants = styleLabels.map(style => {
    const body = styleEmail({ style, name, observation, offer, angle, cta: softCta(`${lead.id || name}|${style}`), revenue });
    return {
      style,
      body,
      quality_check: qualityCheckEmail(body, observation)
    };
  });
  const selectedVariant = variants.find(item => item.style === selectedStyle && item.quality_check.passed)
    || variants.find(item => item.quality_check.passed)
    || variants[0];
  const firstBody = selectedVariant.body;
  const evidenceIds = uniqueArray([...angle.evidence_ids, ...offer.evidence_ids, ...observation.evidence_ids]).slice(0, 8);

  const followUps = [
    {
      step: 1,
      recommended_delay_days: 3,
      subject: `Re: ${subjectLines[0]}`,
      body: `${shortGreeting(name)}\n\nI wanted to follow up on the note I sent after looking at your website.\n\nThe idea was simple: if a good caller reaches out while the team is busy, a fast text reply can keep that conversation from going cold.\n\nIf this is already handled well, no worries. If not, CallCatch may be worth a quick look.\n\n${softCta(`${lead.id || name}|follow1`)}\n\n${founderSignature(false)}`
    },
    {
      step: 2,
      recommended_delay_days: 7,
      subject: `Worth a quick look?`,
      body: `${shortGreeting(name)}\n\nOne more thought, then I will stay out of your inbox.\n\nFor service businesses, the missed-call problem is not always obvious because the customer rarely tells you they moved on. They just call someone else.\n\nCallCatch is meant to quietly catch that moment with a quick text response.\n\nHappy to show you.\n\n${founderSignature(false)}`
    },
    {
      step: 3,
      recommended_delay_days: 10,
      subject: `Should I close the loop?`,
      body: `${shortGreeting(name)}\n\nI do not want to keep chasing you.\n\nI reached out because your site made it look like fast response could matter for the kind of customers you serve. If that is not a focus right now, I can close the loop.\n\nIf useful, I can send a short demo.\n\n${founderSignature(false)}`
    }
  ].map(item => ({
    ...item,
    evidence_ids: evidenceIds,
    claims: [angle.angle, offer.name]
  }));

  return {
    selected_style: selectedVariant.style,
    subject_lines: subjectLines,
    first_email: {
      subject: subjectLines[0],
      body: firstBody,
      evidence_ids: evidenceIds,
      claims: [angle.angle, offer.name]
    },
    follow_up_emails: followUps,
    concise_cta: cta,
    quality_check: selectedVariant.quality_check,
    outreach_variants: variants.map(item => ({ style: item.style, quality_check: item.quality_check }))
  };
}

function prohibitedClaims(flat = {}) {
  return uniqueArray([
    ...(flat.contact_decision?.prohibited_claims_for_brain_two || []),
    "Do not claim guaranteed revenue.",
    "Do not claim the business is losing a specific amount unless Brain One estimated it.",
    "Do not claim a verified owner name unless Brain One verified one.",
    "Do not claim CallCatch has customers or case studies not present in the approved evidence.",
    "Do not claim urgency, deadlines, discounts, or limited-time offers."
  ]);
}

function confidenceScore({ eligibility, persona, angle, offer, paths } = {}) {
  if (!eligibility.eligible) return { score: 0, level: "low", reasoning: eligibility.reasons.join(" ") || "Brain Two is blocked." };
  let score = 35;
  if (paths.hasUsablePath) score += 20;
  if (persona.confidence === "high") score += 15;
  if (persona.confidence === "medium") score += 10;
  if (angle.claim_type === "evidence_backed") score += 15;
  if ((offer.evidence_ids || []).length) score += 10;
  if (eligibility.manual_research_required) score -= 25;
  const finalScore = clamp(score);
  return {
    score: finalScore,
    level: finalScore >= 75 ? "high" : finalScore >= 50 ? "medium" : "low",
    reasoning: eligibility.manual_research_required
      ? "Manual contact research is required before outreach can be used."
      : "Confidence is based on approved Brain One evidence, persona fit, outreach path availability, and angle support."
  };
}

function buildSupportingEvidence(angle, offer, flat = {}) {
  return [
    { claim: angle.angle, evidence_ids: angle.evidence_ids || [], claim_type: angle.claim_type || "soft_hypothesis" },
    { claim: offer.name, evidence_ids: offer.evidence_ids || [], claim_type: offer.evidence_ids?.length ? "evidence_backed" : "soft_hypothesis" },
    ...((flat.hidden_opportunities || []).slice(0, 2).map(item => ({
      claim: claimText(item),
      evidence_ids: evidenceIdList(item),
      claim_type: evidenceIdList(item).length ? "evidence_backed" : "soft_hypothesis"
    })))
  ].filter(item => item.claim);
}

function blockedOutput(eligibility, runId = "") {
  return {
    version: BRAIN_TWO_VERSION,
    status: "BLOCKED",
    eligibility,
    ideal_contact_persona: { persona: "Unavailable", reasoning: eligibility.reasons.join(" "), confidence: "low", evidence_ids: [] },
    ranked_contact_personas: [],
    selected_outreach_angle: { angle: "Unavailable", reasoning: "Brain Two is blocked by eligibility rules.", claim_type: "soft_hypothesis", evidence_ids: [] },
    selected_offer: { name: "Unavailable", description: "Brain Two is blocked.", reasoning: "Brain Two is blocked by eligibility rules.", evidence_ids: [] },
    offer_fit_explanation: "Brain Two did not generate outreach because eligibility failed.",
    subject_lines: ["Needs review", "Needs review", "Needs review", "Needs review", "Needs review"],
    first_email: { subject: "Needs review", body: "", evidence_ids: [], claims: [] },
    follow_up_emails: [1, 2, 3].map(step => ({ step, recommended_delay_days: step === 1 ? 3 : step === 2 ? 7 : 10, subject: "Needs review", body: "", evidence_ids: [], claims: [] })),
    concise_cta: "",
    outreach_confidence: { score: 0, level: "low", reasoning: eligibility.reasons.join(" ") || "Blocked." },
    supporting_evidence: [],
    prohibited_claims: prohibitedClaims({}),
    brain_three_handoff: { lead_id: "", brain_one_run_id: eligibility.brain_one_run_id || "", brain_two_run_id: runId, selected_angle: "", selected_offer: "", reply_watch_items: [], do_not_claim: prohibitedClaims({}), approval_required: true },
    approval_state: "pending-review",
    generation_mode: "deterministic"
  };
}

function runBrainTwo({ lead = {}, brainOneRun = {}, runId = "", createdAt = nowIso() } = {}) {
  const flat = brainOneFlatOutput(brainOneRun);
  const eligibility = evaluateBrainTwoEligibility({ lead, brainOneRun });
  if (!eligibility.eligible) {
    const output = blockedOutput(eligibility, runId);
    output.brain_three_handoff.lead_id = lead.id || "";
    return { output, status: "blocked", createdAt, executionStatus: "blocked", approvalStatus: "pending-review" };
  }

  const personas = choosePersona(lead, flat);
  const persona = personas[0];
  const angle = chooseAngle(lead, flat);
  const offer = chooseOffer(lead, flat);
  const messaging = generateMessaging({ lead, flat, persona, angle, offer, runId });
  const paths = contactPaths(lead, flat);
  const confidence = confidenceScore({ eligibility, persona, angle, offer, paths });
  const prohibited = prohibitedClaims(flat);
  const supportingEvidence = buildSupportingEvidence(angle, offer, flat);
  const status = eligibility.status === "needs_review" || confidence.score < 50 ? "NEEDS_REVIEW" : "READY";
  const output = {
    version: BRAIN_TWO_VERSION,
    status,
    eligibility,
    ideal_contact_persona: persona,
    ranked_contact_personas: personas,
    selected_outreach_angle: angle,
    selected_offer: offer,
    offer_fit_explanation: offer.reasoning,
    ...messaging,
    outreach_confidence: confidence,
    supporting_evidence: supportingEvidence,
    prohibited_claims: prohibited,
    brain_three_handoff: {
      lead_id: lead.id || "",
      brain_one_run_id: brainOneRun.id || "",
      brain_two_run_id: runId,
      selected_angle: angle.angle,
      selected_offer: offer.name,
      reply_watch_items: ["pricing interest", "demo request", "wrong person", "not interested", "existing vendor", "manual research needed"],
      do_not_claim: prohibited,
      approval_required: true
    },
    approval_state: "pending-review",
    generation_mode: "deterministic"
  };
  const validation = validateBrainTwoOutput(output);
  if (!validation.ok) {
    const error = new Error(`Brain Two output failed validation: ${validation.errors.join("; ")}`);
    error.validationErrors = validation.errors;
    throw error;
  }
  return { output, status: output.status.toLowerCase(), createdAt, executionStatus: "completed", approvalStatus: "pending-review" };
}

function validateArray(value, pathName, errors, min = 0, max = Infinity) {
  if (!Array.isArray(value)) {
    errors.push(`${pathName} must be an array`);
    return;
  }
  if (value.length < min) errors.push(`${pathName} must contain at least ${min} items`);
  if (value.length > max) errors.push(`${pathName} must contain at most ${max} items`);
}

function validateBrainTwoOutput(output = {}) {
  const errors = [];
  for (const key of outputSchema.required) {
    if (!(key in output)) errors.push(`${key} is required`);
  }
  if (output.version !== BRAIN_TWO_VERSION) errors.push("version must be brain-two-v1.0");
  if (!["READY", "NEEDS_REVIEW", "BLOCKED"].includes(output.status)) errors.push("status is invalid");
  if (!output.eligibility || typeof output.eligibility !== "object") errors.push("eligibility is required");
  validateArray(output.ranked_contact_personas, "ranked_contact_personas", errors);
  validateArray(output.subject_lines, "subject_lines", errors, 5, 5);
  validateArray(output.follow_up_emails, "follow_up_emails", errors, 3, 3);
  validateArray(output.supporting_evidence, "supporting_evidence", errors);
  validateArray(output.prohibited_claims, "prohibited_claims", errors);
  if (!output.first_email?.body && output.status !== "BLOCKED") errors.push("first_email.body is required when not blocked");
  if (output.first_email?.body && output.status !== "BLOCKED") {
    const count = wordCount(output.first_email.body);
    if (count > 170) errors.push("first_email.body must not exceed 170 words");
    if (count < 90) errors.push("first_email.body should contain at least 90 words");
    const lower = output.first_email.body.toLowerCase();
    for (const banned of ["revolutionary", "game changing", "ai powered", "next generation", "cutting edge", "state of the art"]) {
      if (lower.includes(banned)) errors.push(`first_email.body contains banned phrase: ${banned}`);
    }
    if (/book a meeting|schedule a call|hop on zoom/i.test(output.first_email.body)) errors.push("first_email.body contains a high-pressure CTA");
  }
  if (!output.brain_three_handoff?.approval_required) errors.push("brain_three_handoff.approval_required must be true");
  for (const item of output.supporting_evidence || []) {
    if (!item.claim) errors.push("supporting_evidence.claim is required");
    if (!Array.isArray(item.evidence_ids)) errors.push("supporting_evidence.evidence_ids must be an array");
    if (!["evidence_backed", "soft_hypothesis"].includes(item.claim_type)) errors.push("supporting_evidence.claim_type is invalid");
  }
  return { ok: errors.length === 0, errors };
}

function duplicateBrainTwoRun(runs = [], leadId = "") {
  return (runs || []).find(run => run.businessId === leadId && run.executionStatus === "running") || null;
}

function applyBrainTwoReviewState(state = {}, { runId, leadId, approved, reviewedBy = "CallCatch user", notes = "", reviewedAt = nowIso() } = {}) {
  state.brainTwoRuns = state.brainTwoRuns || [];
  const record = state.brainTwoRuns.find(item => item.id === runId);
  if (!record) throw new Error("Brain Two run not found");
  if (!["completed", "blocked"].includes(record.executionStatus)) throw new Error("Only completed Brain Two runs can be reviewed");
  record.approvalStatus = approved ? "approved" : "rejected";
  record.reviewedAt = reviewedAt;
  record.reviewedBy = reviewedBy;
  record.reviewNotes = notes;
  if (record.output) record.output.approval_state = approved ? "approved" : "rejected";
  const lead = (state.leads || []).find(item => item.id === leadId || item.id === record.businessId);
  if (lead) {
    lead.brainTwoLatestRunId = record.id;
    lead.brainTwoApprovalStatus = record.approvalStatus;
    lead.timeline = lead.timeline || [];
    lead.timeline.unshift({
      at: reviewedAt,
      text: approved ? "Brain Two outreach intelligence approved. No email was sent or queued." : "Brain Two outreach intelligence rejected."
    });
  }
  state.auditLog = state.auditLog || [];
  state.auditLog.unshift({
    id: `audit_${Date.now().toString(36)}`,
    at: reviewedAt,
    action: approved ? "brain_two_approved" : "brain_two_rejected",
    details: { runId: record.id, businessId: record.businessId }
  });
  return { run: record, lead };
}

module.exports = {
  BRAIN_TWO_VERSION,
  RUNTIME_PROMPT,
  applyBrainTwoReviewState,
  duplicateBrainTwoRun,
  evaluateBrainTwoEligibility,
  flattenBrainOneOutput,
  runBrainTwo,
  validateBrainTwoOutput
};
