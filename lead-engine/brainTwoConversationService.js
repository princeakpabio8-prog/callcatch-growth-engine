const CONVERSATION_STATES = [
  "NEW",
  "EMAIL_SENT",
  "WAITING",
  "REPLIED",
  "MEETING_REQUESTED",
  "MEETING_BOOKED",
  "NOT_NOW",
  "ALREADY_HAVE_SOLUTION",
  "WRONG_CONTACT",
  "UNSUBSCRIBED",
  "BOUNCED",
  "CLOSED"
];

const REPLY_INTENTS = [
  "Interested",
  "Question",
  "Need more information",
  "Call me",
  "Send pricing",
  "Send details",
  "Not now",
  "Busy",
  "Already using competitor",
  "Already solved",
  "Wrong person",
  "Forwarded",
  "Unsubscribe",
  "Hostile",
  "Unknown"
];

function nowIso() {
  return new Date().toISOString();
}

function compact(value = "", max = 600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function newConversationId(prefix = "conv") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeConversationState(lead = {}) {
  const candidate = String(lead.conversationState || lead.brainTwoConversationState || "").toUpperCase();
  if (CONVERSATION_STATES.includes(candidate)) return candidate;
  if (lead.unsubscribe || lead.unsubscribed) return "UNSUBSCRIBED";
  if (lead.bounced || lead.emailBounced) return "BOUNCED";
  if (lead.stage === "Demo Scheduled") return "MEETING_REQUESTED";
  if (lead.stage === "Customer" || lead.stage === "Lost") return "CLOSED";
  if (ensureArray(lead.replies).length) return "REPLIED";
  if (ensureArray(lead.sentEmails).length) return "EMAIL_SENT";
  return "NEW";
}

function appendTimeline(lead, text, at = nowIso()) {
  lead.timeline = ensureArray(lead.timeline);
  lead.timeline.unshift({ at, text });
}

function hasAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function classifyReply({ body = "", subject = "", eventType = "reply", providerEvent = "" } = {}) {
  const text = `${subject} ${body} ${providerEvent} ${eventType}`.toLowerCase();
  const bounced = eventType === "bounce" || hasAny(text, [/mail delivery/i, /delivery status notification/i, /\bbounced?\b/i, /address not found/i, /undeliverable/i]);
  if (bounced) {
    return {
      intent: "Unknown",
      confidence: 98,
      reason: "Delivery failure or bounce signal detected.",
      recommended_action: "Mark bounced, pause automation, and do not send more follow-ups.",
      next_state: "BOUNCED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/unsubscribe/i, /remove me/i, /stop emailing/i, /do not email/i, /don't email/i, /opt out/i])) {
    return {
      intent: "Unsubscribe",
      confidence: 99,
      reason: "Recipient requested removal or no further email.",
      recommended_action: "Mark permanently unsubscribed. Never email again.",
      next_state: "UNSUBSCRIBED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/fuck/i, /scam/i, /leave us alone/i, /harass/i, /annoying/i])) {
    return {
      intent: "Hostile",
      confidence: 92,
      reason: "Hostile or complaint language detected.",
      recommended_action: "Close politely, pause automation, and do not continue outreach.",
      next_state: "CLOSED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/wrong person/i, /not the right person/i, /not my department/i, /contact someone else/i])) {
    return {
      intent: "Wrong person",
      confidence: 94,
      reason: "Recipient indicated they are not the right contact.",
      recommended_action: "Ask if another contact is appropriate, then stop the sequence.",
      next_state: "WRONG_CONTACT",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/forwarded/i, /i forwarded/i, /passing this/i, /sent this to/i])) {
    return {
      intent: "Forwarded",
      confidence: 86,
      reason: "Recipient says the message was forwarded internally.",
      recommended_action: "Pause automation and wait for the right person to respond.",
      next_state: "WRONG_CONTACT",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/already use/i, /using .*competitor/i, /we use/i, /have a system/i, /already have/i, /current provider/i])) {
    return {
      intent: hasAny(text, [/competitor/i, /provider/i, /vendor/i]) ? "Already using competitor" : "Already solved",
      confidence: 88,
      reason: "Recipient says they already have a solution or provider.",
      recommended_action: "Acknowledge, offer future comparison, and close politely.",
      next_state: "ALREADY_HAVE_SOLUTION",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/not now/i, /later/i, /next quarter/i, /next month/i, /reach back/i, /circle back later/i])) {
    return {
      intent: "Not now",
      confidence: 91,
      reason: "Recipient showed possible future interest but not immediate timing.",
      recommended_action: "Suggest a future reminder and pause immediate follow-ups.",
      next_state: "NOT_NOW",
      stop_automation: true,
      reminder_days: 60
    };
  }
  if (hasAny(text, [/\bbusy\b/i, /swamped/i, /too much going on/i, /no time/i])) {
    return {
      intent: "Busy",
      confidence: 82,
      reason: "Recipient indicated timing or workload is the blocker.",
      recommended_action: "Suggest a light 30-day reminder and pause immediate follow-ups.",
      next_state: "NOT_NOW",
      stop_automation: true,
      reminder_days: 30
    };
  }
  if (hasAny(text, [/pricing/i, /\bprice\b/i, /\bcost\b/i, /how much/i, /rates/i])) {
    return {
      intent: "Send pricing",
      confidence: 90,
      reason: "Recipient asked about price or cost.",
      recommended_action: "Draft a short pricing response and pause automation.",
      next_state: "REPLIED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/send details/i, /send info/i, /more details/i, /send more/i, /send over/i])) {
    return {
      intent: "Send details",
      confidence: 87,
      reason: "Recipient requested details.",
      recommended_action: "Draft a concise details response and pause automation.",
      next_state: "REPLIED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/call me/i, /give me a call/i, /phone me/i, /ring me/i])) {
    return {
      intent: "Call me",
      confidence: 94,
      reason: "Recipient requested a call.",
      recommended_action: "Suggest meeting or call next step. Human approval required.",
      next_state: "MEETING_REQUESTED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/let'?s talk/i, /lets talk/i, /interested/i, /demo/i, /walkthrough/i, /can we schedule/i, /book/i])) {
    return {
      intent: "Interested",
      confidence: 92,
      reason: "Recipient expressed interest or meeting intent.",
      recommended_action: "Draft response, suggest a simple meeting CTA, and pause automation.",
      next_state: "MEETING_REQUESTED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/\?/, /how does/i, /what does/i, /can it/i, /does it/i, /who/i, /why/i])) {
    return {
      intent: "Question",
      confidence: 80,
      reason: "Recipient asked a question.",
      recommended_action: "Draft an answer and wait for human approval before sending.",
      next_state: "REPLIED",
      stop_automation: true,
      reminder_days: null
    };
  }
  if (hasAny(text, [/tell me more/i, /more information/i, /more info/i])) {
    return {
      intent: "Need more information",
      confidence: 82,
      reason: "Recipient requested more information.",
      recommended_action: "Draft a short helpful response and pause automation.",
      next_state: "REPLIED",
      stop_automation: true,
      reminder_days: null
    };
  }
  return {
    intent: "Unknown",
    confidence: 45,
    reason: "Reply received but no strong intent pattern matched.",
    recommended_action: "Pause automation and ask a human to review the reply.",
    next_state: "REPLIED",
    stop_automation: true,
    reminder_days: null
  };
}

function draftResponse({ lead = {}, classification = {}, reply = {} } = {}) {
  const business = compact(lead.business || "your team", 120);
  const intent = classification.intent;
  let body;
  let meetingSuggestion = "";
  if (intent === "Interested" || intent === "Call me") {
    meetingSuggestion = "Happy to walk you through it.";
    body = `Hi,\n\nThanks for getting back to me. Happy to walk you through it and keep it simple.\n\nThe quick version is that CallCatch helps missed callers get a fast text response so they do not go cold before your team can reply.\n\n${meetingSuggestion}\n\nBest,\nPrince`;
  } else if (intent === "Question") {
    body = `Hi,\n\nGood question. The simple version is that CallCatch responds to missed callers by text, then keeps the conversation warm until someone on the team can follow up.\n\nI can answer the specific part you are wondering about.\n\nBest,\nPrince`;
  } else if (intent === "Send pricing") {
    body = `Hi,\n\nThanks for asking. Pricing depends on the setup and call volume, but I would keep it practical: it only makes sense if the recovered calls justify it.\n\nHappy to send the simple version first.\n\nBest,\nPrince`;
  } else if (intent === "Send details" || intent === "Need more information") {
    body = `Hi,\n\nAbsolutely. CallCatch is built to catch missed callers with a quick text response, so the lead does not disappear before the team can get back to them.\n\nI can send a short walkthrough if useful.\n\nBest,\nPrince`;
  } else if (intent === "Not now" || intent === "Busy") {
    body = `Hi,\n\nTotally understand. I will not crowd your inbox.\n\nIf it helps, I can leave this for later and reconnect when timing is better.\n\nBest,\nPrince`;
  } else if (intent === "Wrong person" || intent === "Forwarded") {
    body = `Hi,\n\nThanks for letting me know. I appreciate it.\n\nIf there is someone better to speak with about missed-call response, feel free to point me in the right direction. If not, no worries at all.\n\nBest,\nPrince`;
  } else if (intent === "Already using competitor" || intent === "Already solved") {
    body = `Hi,\n\nThat makes sense. Glad you already have something in place.\n\nI will close the loop here. If you ever want a simple comparison around missed-call recovery, I am happy to help.\n\nBest,\nPrince`;
  } else if (intent === "Unsubscribe" || intent === "Hostile") {
    body = `Hi,\n\nUnderstood. I will not contact ${business} again.\n\nBest,\nPrince`;
  } else {
    body = `Hi,\n\nThanks for the reply. I do not want to assume the wrong next step, so I will pause here and review this properly before responding.\n\nBest,\nPrince`;
  }
  return {
    id: newConversationId("draft"),
    channel: "email",
    status: "Needs Approval",
    human_approval_required: true,
    intent,
    meeting_suggestion: meetingSuggestion,
    body,
    source_reply_id: reply.id || "",
    createdAt: nowIso()
  };
}

function cancelRemainingFollowUps(state = {}, leadId = "", reason = "conversation started") {
  const cancelled = [];
  for (const task of ensureArray(state.approvalQueue)) {
    if (task.leadId !== leadId) continue;
    if (task.status === "Sent") continue;
    const isFollowUp = /follow/i.test(`${task.title || ""} ${task.sequenceStep || ""}`);
    if (!isFollowUp) continue;
    task.status = `Stopped - ${reason}`;
    task.stoppedReason = reason;
    task.stoppedAt = nowIso();
    cancelled.push(task);
  }
  for (const job of ensureArray(state.scheduledJobs)) {
    const task = ensureArray(state.approvalQueue).find(item => item.id === job.taskId);
    if (task?.leadId !== leadId) continue;
    if (job.status === "Sent" || job.status === "Completed") continue;
    job.status = `Stopped - ${reason}`;
    job.stoppedReason = reason;
    job.stoppedAt = nowIso();
  }
  return cancelled;
}

function applyConversationEvent(state = {}, { leadId = "", eventType = "reply", reply = {}, taskId = "", manualState = "", actor = "Brain Two" } = {}) {
  state.leads = ensureArray(state.leads);
  state.approvalQueue = ensureArray(state.approvalQueue);
  state.auditLog = ensureArray(state.auditLog);
  state.scheduledJobs = ensureArray(state.scheduledJobs);
  const lead = state.leads.find(item => item.id === leadId);
  if (!lead) throw new Error("Lead not found");
  const at = nowIso();
  const previousState = normalizeConversationState(lead);
  let classification = null;
  let nextState = previousState;
  let draft = null;
  let cancelledFollowUps = [];

  if (eventType === "email_sent") {
    nextState = "EMAIL_SENT";
    appendTimeline(lead, "Email Sent", at);
  } else if (eventType === "waiting") {
    nextState = "WAITING";
  } else if (eventType === "meeting_booked") {
    nextState = "MEETING_BOOKED";
    cancelledFollowUps = cancelRemainingFollowUps(state, lead.id, "meeting booked");
    appendTimeline(lead, "Meeting Booked", at);
  } else if (eventType === "manual_close" || eventType === "user_complete") {
    nextState = manualState && CONVERSATION_STATES.includes(manualState) ? manualState : "CLOSED";
    cancelledFollowUps = cancelRemainingFollowUps(state, lead.id, "manual close");
    appendTimeline(lead, "Sequence Closed", at);
  } else {
    classification = classifyReply({ ...reply, eventType });
    nextState = classification.next_state;
    if (classification.stop_automation) {
      cancelledFollowUps = cancelRemainingFollowUps(state, lead.id, nextState.toLowerCase().replace(/_/g, " "));
    }
    lead.replies = ensureArray(lead.replies);
    const replyRecord = {
      id: reply.id || newConversationId("reply"),
      at,
      from: compact(reply.from || "", 160),
      subject: compact(reply.subject || "", 200),
      body: compact(reply.body || "", 2000),
      taskId,
      intent: classification.intent,
      confidence: classification.confidence
    };
    lead.replies.unshift(replyRecord);
    draft = draftResponse({ lead, classification, reply: replyRecord });
    lead.brainTwoDraftResponses = ensureArray(lead.brainTwoDraftResponses);
    lead.brainTwoDraftResponses.unshift(draft);
    appendTimeline(lead, "Reply Received", at);
    appendTimeline(lead, `Intent Classified: ${classification.intent}`, at);
    appendTimeline(lead, "Draft Generated", at);
    if (nextState === "MEETING_REQUESTED") appendTimeline(lead, "Meeting Suggested", at);
    if (classification.stop_automation) appendTimeline(lead, "Sequence Paused", at);
    if (nextState === "NOT_NOW" && classification.reminder_days) {
      lead.nextFollowUp = new Date(Date.now() + classification.reminder_days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      lead.followUpStatus = `Reminder suggested in ${classification.reminder_days} days`;
      appendTimeline(lead, `Reminder Suggested: ${classification.reminder_days} days`, at);
    }
    if (nextState === "UNSUBSCRIBED") {
      lead.unsubscribed = true;
      lead.doNotEmail = true;
    }
    if (nextState === "BOUNCED") {
      lead.emailBounced = true;
    }
  }

  lead.conversationState = nextState;
  lead.brainTwoConversationState = nextState;
  lead.brainTwoConversation = {
    state: nextState,
    previousState,
    lastIntent: classification?.intent || "",
    lastConfidence: classification?.confidence || null,
    human_approval_required: !!draft,
    automation_paused: ["REPLIED", "MEETING_REQUESTED", "MEETING_BOOKED", "NOT_NOW", "ALREADY_HAVE_SOLUTION", "WRONG_CONTACT", "UNSUBSCRIBED", "BOUNCED", "CLOSED"].includes(nextState),
    updatedAt: at
  };
  state.auditLog.unshift({
    id: newConversationId("audit"),
    at,
    action: "brain_two_conversation_event",
    details: { leadId: lead.id, eventType, previousState, nextState, intent: classification?.intent || "", cancelledFollowUps: cancelledFollowUps.length, actor }
  });
  return {
    lead,
    previousState,
    state: nextState,
    classification,
    draft,
    cancelledFollowUps,
    quality_check: validateConversationResult({ lead, state: nextState, classification, draft, cancelledFollowUps, eventType })
  };
}

function validateConversationResult({ lead = {}, state = "", classification = null, draft = null, cancelledFollowUps = [], eventType = "" } = {}) {
  const errors = [];
  if (!CONVERSATION_STATES.includes(state)) errors.push("Lead must have exactly one valid conversation state.");
  if (Array.isArray(state)) errors.push("Conversation state must not be an array.");
  if (classification?.stop_automation && cancelledFollowUps.some(task => task.status === "Sent")) errors.push("Sent follow-ups must not be cancelled retroactively.");
  if (classification?.stop_automation && !lead.brainTwoConversation?.automation_paused) errors.push("Automation must be paused after reply, bounce, unsubscribe, or close.");
  if (draft && draft.human_approval_required !== true) errors.push("Draft responses require human approval.");
  if (eventType !== "email_sent" && eventType !== "waiting" && !ensureArray(lead.timeline).some(item => /Reply Received|Meeting Booked|Sequence Closed/.test(item.text || ""))) {
    errors.push("Conversation timeline was not updated.");
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  CONVERSATION_STATES,
  REPLY_INTENTS,
  applyConversationEvent,
  cancelRemainingFollowUps,
  classifyReply,
  draftResponse,
  normalizeConversationState,
  validateConversationResult
};
