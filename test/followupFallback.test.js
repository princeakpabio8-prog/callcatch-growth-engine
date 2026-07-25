const test = require("node:test");
const assert = require("node:assert/strict");

const { generateFollowUps } = require("../lead-engine/sendingEngine");

const restricted = /just checking in|checking in|bumping this|wanted to circle back|circle back|following up/i;

function qualityGate() {
  return { passed: true, status: "READY TO REVIEW", quality_score: 92, human_score: 94 };
}

function stateWithApprovedBrainTwo({ sentThrough = 0 } = {}) {
  const lead = {
    id: "lead-clean-followup",
    business: "Clean Air Pros",
    email: "owner@cleanair.example",
    website: "https://cleanair.example",
    trade: "HVAC",
    verifiedIndustry: "HVAC",
    industryVerified: true,
    emailSourceUrl: "https://cleanair.example/contact",
    identityVerification: {
      status: "Verified",
      verified: true,
      leadId: "lead-clean-followup",
      businessName: "Clean Air Pros",
      canonicalWebsite: "https://cleanair.example",
      websiteDomain: "cleanair.example",
      recipientEmail: "owner@cleanair.example",
      emailDomain: "cleanair.example",
      emailSourceUrl: "https://cleanair.example/contact",
      confirmedIndustry: "HVAC"
    },
    stage: "Contacted",
    replies: []
  };
  const initialSentAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const followUps = [
    { step: 1, recommended_delay_days: 3, subject: "One useful thought", body: "A short educational note with new value. If useful, I can show what I mean.", quality_gate: qualityGate() },
    { step: 2, recommended_delay_days: 7, subject: "One observation", body: "A specific business observation that was not used in the first email. Worth a quick look?", quality_gate: qualityGate() },
    { step: 3, recommended_delay_days: 10, subject: "A practical estimate", body: "The approved evidence suggests this may be worth reviewing. Happy to show you.", quality_gate: qualityGate() },
    { step: 4, recommended_delay_days: 14, subject: "Leaving this here", body: "I will leave this here for now. If it becomes useful later, I am happy to help.", quality_gate: qualityGate() }
  ];
  const approvalQueue = [{
    id: "task_initial",
    leadId: lead.id,
    business: lead.business,
    channel: "email",
    source: "brain-two-quality-gate",
    brainTwoRunId: "brain2-clean",
    sequenceStep: "initial-email",
    status: "Sent",
    sentAt: initialSentAt,
    to: lead.email,
    recipient: lead.email
  }];
  for (let step = 1; step <= sentThrough; step += 1) {
    approvalQueue.push({
      id: `task_followup_${step}`,
      leadId: lead.id,
      source: "brain-two-quality-gate",
      brainTwoRunId: "brain2-clean",
      sequenceStep: `followup-${step}`,
      channel: "email",
      status: "Sent",
      sentAt: new Date(Date.now() - (15 - step) * 24 * 60 * 60 * 1000).toISOString(),
      to: lead.email,
      recipient: lead.email
    });
  }
  return {
    leads: [lead],
    approvalQueue,
    outboundApprovals: [],
    auditLog: [],
    brainOneRuns: [{
      id: "brain1-clean",
      businessId: lead.id,
      executionStatus: "completed",
      approvalStatus: "approved-for-crm-brain-two",
      inputSnapshot: {
        businessIdentity: { businessId: lead.id, businessName: lead.business, websiteUrl: lead.website, trade: lead.trade },
        evidenceLog: []
      }
    }],
    brainTwoRuns: [{
      id: "brain2-clean",
      businessId: lead.id,
      brainOneRunId: "brain1-clean",
      executionStatus: "completed",
      approvalStatus: "approved",
      output: { follow_up_emails: followUps, brain_three_handoff: { lead_id: lead.id } }
    }],
    sending: { metrics: { followUpsGenerated: 0 } }
  };
}

test("due follow-up uses the approved Brain Two draft without automated check-in language", () => {
  const state = stateWithApprovedBrainTwo();
  const generated = generateFollowUps(state, { now: new Date() });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].sequenceStep, "followup-1");
  assert.equal(generated[0].source, "brain-two-quality-gate");
  assert.doesNotMatch(generated[0].body, restricted);
  assert.match(generated[0].body, /If useful, I can show what I mean\./);
});

test("fourth Brain Two follow-up preserves the low-pressure permission close", () => {
  const state = stateWithApprovedBrainTwo({ sentThrough: 3 });
  const generated = generateFollowUps(state, { now: new Date() });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].sequenceStep, "followup-4");
  assert.doesNotMatch(generated[0].body, restricted);
  assert.match(generated[0].body, /I will leave this here for now\./);
  assert.match(generated[0].body, /happy to help\./i);
});
