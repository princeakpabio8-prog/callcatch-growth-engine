const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const serverSource = fs.readFileSync("callcatch-lead-server.js", "utf8");
const dashboardSource = fs.readFileSync("callcatch-lead-dashboard.html", "utf8");
const ANALYZE_ROUTE_END = 'if (req.method === "POST" && ["/api/brain-one/approve"';
const APPROVAL_ROUTE_START = 'if (req.method === "POST" && ["/api/brain-one/approve"';

function sectionBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `${startNeedle} not found`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `${endNeedle} not found`);
  return source.slice(start, end);
}

test("Brain One handoff route returns JSON immediately with a run id", () => {
  const route = sectionBetween(serverSource, 'url.pathname === "/api/brain-one/analyze"', ANALYZE_ROUTE_END);
  assert.match(route, /send\(res,\s*202,\s*brainOneStartResponse/);
  assert.match(route, /status:\s*"started"/);
  assert.match(route, /brain_one_run_id:\s*run\.id/);
  assert.match(route, /message:\s*"Brain One analysis started\."/);
});

test("Brain One route does not await full NVIDIA execution before responding", () => {
  const route = sectionBetween(serverSource, 'url.pathname === "/api/brain-one/analyze"', ANALYZE_ROUTE_END);
  const backgroundStart = route.indexOf("setTimeout(() =>");
  const responseSend = route.indexOf("send(res, 202");
  assert.ok(backgroundStart > -1);
  assert.ok(responseSend > backgroundStart);
  assert.doesNotMatch(route, /const result = await runBrainOne/);
});

test("Brain One duplicate click returns existing active run as JSON", () => {
  const route = sectionBetween(serverSource, 'url.pathname === "/api/brain-one/analyze"', ANALYZE_ROUTE_END);
  assert.match(route, /duplicateBrainOneRun/);
  assert.match(route, /status:\s*"already_running"/);
  assert.match(route, /brain_one_run_id:\s*duplicateRunning\.id/);
});

test("Brain One blocked evidence path returns JSON error shape", () => {
  const route = sectionBetween(serverSource, 'url.pathname === "/api/brain-one/analyze"', ANALYZE_ROUTE_END);
  assert.match(route, /status:\s*"blocked"/);
  assert.match(route, /code:\s*"evidence_not_ready"/);
  assert.match(route, /The evidence package is not ready/);
});

test("Brain One unexpected start error returns JSON error shape", () => {
  const route = sectionBetween(serverSource, 'url.pathname === "/api/brain-one/analyze"', ANALYZE_ROUTE_END);
  assert.match(route, /status:\s*"failed"/);
  assert.match(route, /code:\s*"brain_one_start_failed"/);
  assert.match(route, /Brain One could not be started/);
});

test("Brain One background task is guarded against sync and async failures", () => {
  const worker = sectionBetween(serverSource, "async function completeBrainOneRun", "const server = http.createServer");
  assert.match(worker, /try\s*{[\s\S]*await runBrainOne/);
  assert.match(worker, /catch \(error\)/);
  assert.match(worker, /markBrainOneFailed/);
  assert.match(worker, /brain_one_background_failed/);
  assert.match(worker, /finally/);
});

test("Brain One worker records every major execution stage", () => {
  const worker = sectionBetween(serverSource, "async function completeBrainOneRun", "const server = http.createServer");
  for (const stage of [
    "brain_one_job_started",
    "evidence_loaded",
    "prompt_built",
    "nvidia_request_started",
    "nvidia_response_received",
    "response_parsed",
    "validation_completed",
    "report_generation_started",
    "report_generation_completed",
    "database_write_started",
    "database_write_completed",
    "run_marked_completed"
  ]) {
    assert.match(worker, new RegExp(stage));
  }
});

test("Brain One worker has five-minute timeout protection with failed persistence", () => {
  assert.match(serverSource, /BRAIN_ONE_MAX_DURATION_MS[\s\S]*300000/);
  assert.match(serverSource, /function createBrainOneTimeout/);
  assert.match(serverSource, /brain_one_timeout/);
  assert.match(serverSource, /Promise\.race/);
  assert.match(serverSource, /timeoutGuard\.cancel/);
});

test("Brain One failure persistence avoids overwriting completed runs", () => {
  const failure = sectionBetween(serverSource, "async function markBrainOneFailed", "function createBrainOneTimeout");
  assert.match(failure, /!\["queued", "running"\]\.includes\(record\.executionStatus\)/);
});

test("Brain One stale running jobs are recovered after server restart", () => {
  assert.match(serverSource, /async function recoverStaleBrainOneRuns/);
  assert.match(serverSource, /run_interrupted_by_server_restart/);
  assert.match(serverSource, /recoverStaleBrainOneRuns\(\)/);
});

test("frontend parser handles empty and invalid Brain One responses safely", () => {
  assert.match(dashboardSource, /async function parseApiResponse/);
  assert.match(dashboardSource, /response\.text\(\)/);
  assert.match(dashboardSource, /The server returned an empty response while starting Brain One/);
  assert.match(dashboardSource, /The server returned an invalid response while starting Brain One/);
  assert.doesNotMatch(dashboardSource, /const payload = await response\.json\(\)/);
});

test("frontend shows actual Brain One failure stage", () => {
  assert.match(dashboardSource, /Stopped at:/);
  assert.match(dashboardSource, /run\.errorDetails\?\.failureStage \|\| run\.currentStage/);
  assert.match(dashboardSource, /Current step:/);
});

test("frontend handles 502 and 503 as temporary server responses", () => {
  assert.match(dashboardSource, /response\.status === 502 \|\| response\.status === 503/);
  assert.match(dashboardSource, /The server is temporarily unavailable/);
});

test("frontend Brain One flow polls the saved run after page refresh or start", () => {
  assert.match(dashboardSource, /async function refreshBrainOneRuns/);
  assert.match(dashboardSource, /async function pollBrainOne/);
  assert.match(dashboardSource, /api\(`\/api\/brain-one\/runs/);
  assert.match(dashboardSource, /brainOneStarting/);
});

test("Brain One handoff fix does not send or queue email", () => {
  const route = sectionBetween(serverSource, 'url.pathname === "/api/brain-one/analyze"', ANALYZE_ROUTE_END);
  assert.doesNotMatch(route, /sendEmail|sendTaskNow|approvalQueue|outreachAssets|generateFollowUps/);
});

test("manual Brain One approval route remains separate", () => {
  const approvalRoute = sectionBetween(serverSource, APPROVAL_ROUTE_START, 'url.pathname === "/api/daily-assistant"');
  assert.match(approvalRoute, /applyBrainOneReviewState/);
  assert.doesNotMatch(approvalRoute, /sendEmail|sendTaskNow/);
});
