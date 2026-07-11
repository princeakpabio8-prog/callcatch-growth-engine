const APP_USER_AGENT = "CallCatchLeadFinder/1.0 (local lead discovery; contact: https://callcatch.site)";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}, retryOptions = {}) {
  const retries = retryOptions.retries ?? 2;
  const retryDelayMs = retryOptions.retryDelayMs ?? 800;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const signal = options.signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(retryOptions.timeoutMs ?? 12000)
        : undefined);
      const response = await fetch(url, {
        ...options,
        signal,
        headers: {
          "User-Agent": APP_USER_AGENT,
          "Accept": "application/json",
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};

      if (!response.ok) {
        const message = payload.error || payload.message || `${response.status} ${response.statusText}`;
        throw new Error(message);
      }

      return payload;
    } catch (error) {
      if (attempt >= retries) {
        const cause = error.cause && (error.cause.code || error.cause.message) ? ` (${error.cause.code || error.cause.message})` : "";
        throw new Error(`${error.message}${cause}`);
      }
      await delay(retryDelayMs * (attempt + 1));
    }
  }
}

module.exports = { APP_USER_AGENT, fetchJson };
