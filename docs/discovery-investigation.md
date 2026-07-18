# CallCatch Discovery Investigation

## Scope

This investigation traces why CallCatch returns too few fresh prospects in large markets. It does not redesign Brain Zero, Brain One, Brain Two, CRM, outreach, email sending, or scoring.

Important finding: Brain Zero is not the first-stage lead finder. New prospect volume is controlled by the discovery path in `lead-engine/searchEngine.js` and provider adapters. Brain Zero runs after a lead/business exists and collects deeper evidence for analysis.

## Discovery Path

Input:

- Trade
- City, state, ZIP, country, radius
- Lead count
- Optional rating/review filters
- Optional deep research

Processing:

1. `/api/leads` receives the request.
2. `searchLeads()` normalizes country, area, radius, and count.
3. Existing CRM/Pipeline records are indexed by email, website, and company/city.
4. Providers run:
   - Nominatim geocodes the market.
   - OpenStreetMap/Overpass searches map data.
   - Brave Search runs only when `BRAVE_SEARCH_API_KEY` is configured.
   - Serper runs only when `SERPER_API_KEY` is configured.
5. Results are deduped across providers, queries, and pages.
6. Rating/review filters are applied.
7. Existing prospects are removed.
8. A capped candidate pool is enriched with official websites.
9. Websites are scanned for usable business emails.
10. Businesses without usable emails are excluded from active outreach results.
11. Optional deep website research runs only after email readiness.
12. Final results contain outreach-ready leads only.

Output:

- `leads`
- `search` summary
- `errors`
- `diagnostics.funnel`
- `diagnostics.caps`
- `diagnostics.likelyBottlenecks`

## Hard Limits Found

| Area | Current Limit |
| --- | --- |
| Final leads per manual search | 50 |
| Provider request count | `min(max(count * 6, 40), 120)` |
| OpenStreetMap element cap | 120 |
| Serper search terms | 3 |
| Serper results per term | 20 |
| Brave results per query | 20 |
| Brave query variations | 6 to 12 |
| Brave pages per query | 2 |
| Serper website enrichment | up to 36 candidates |
| Brave website enrichment | up to 36 candidates |
| Deep research | 12 candidates |
| Daily Growth searches per run | 24 |
| Daily Growth leads per search | 8 |
| Daily Growth email-ready target | 25 |

## Funnel Example

For a user request such as `HVAC in Dallas, TX` with `count=10`:

| Stage | Maximum Before Real-World Drop-Off |
| --- | ---: |
| User asks for final leads | 10 |
| Provider candidate request | 60 |
| OpenStreetMap elements | 120 |
| Serper web/place candidates, if enabled | Up to 60 before dedupe |
| Brave web/location candidates, if enabled | Multiple queries and pages, capped safely |
| After provider dedupe | Variable |
| After rating/review filters | Variable |
| After existing CRM/Pipeline filter | Variable |
| Initial candidate pool | Up to 220 |
| Website enrichment | Up to 36 with Serper or Brave |
| Email validation | Removes no-reply, test, disposable, directory, and malformed emails |
| Deep research, if enabled | 12 |
| Final lead list | 10 email-ready leads, or fewer if safely exhausted |

The current system is sampling from a small candidate window. It is not exhausting Dallas, Phoenix, London, Toronto, Berlin, or other large markets.

## Live-Style Comparison Result

A local run with no `SERPER_API_KEY` or `BRAVE_SEARCH_API_KEY` available tested:

- HVAC: United States, Canada, United Kingdom, Germany, Australia
- Trades in Dallas: HVAC, Plumbing, Electrical, Roofing

Result:

- Serper was unavailable locally.
- Brave was unavailable locally.
- OpenStreetMap/Overpass timed out in every sampled search.
- Australia normalized to `US`, so Australia is not currently supported as a first-class country.

Observed funnel in each timeout case:

| Stage | Count |
| --- | ---: |
| Raw provider leads | 0 |
| After provider dedupe | 0 |
| After filters | 0 |
| After existing CRM/Pipeline filter | 0 |
| Final leads | 0 |
| Email-ready leads | 0 |

This means the public map source alone is not enough for reliable high-volume lead discovery. Search APIs must be configured, and discovery must keep inspecting candidates until it reaches the requested email-ready target or safely exhausts its search space.

## Fix Implemented

- Brave is now the primary broad discovery provider when configured.
- Brave uses multiple natural query variations per trade/location.
- Brave supports controlled pagination through result offsets.
- Brave search country handling is no longer US-only.
- Discovery now rejects unsupported countries instead of silently converting them to the United States.
- Australia and individual supported European countries are recognized.
- Discovery now filters final results to outreach-ready leads with usable business email addresses.
- Businesses without usable emails are counted in diagnostics instead of being returned as active outreach work.
- Daily Growth now aims for an email-ready target and keeps searching across planned markets until the target is reached or the search plan is exhausted.

## Bottlenecks

1. OpenStreetMap can still time out, so Brave should be configured for production breadth.
2. OpenStreetMap still does not tile very large bounding boxes.
3. Serper is present in code but only works when `SERPER_API_KEY` is configured.
4. Serper maps broad Europe searches to `gb`, which limits country-specific European reach.
5. Existing CRM/Pipeline filtering removes already-seen companies before the final list. This is useful for avoiding duplicates, but it can make a repeated city look empty.
6. Final outreach-ready volume depends on how many public websites expose usable business emails.

## Answers

Is Brain Zero exhausting available businesses?

No. Brain Zero is not exhausting businesses because Brain Zero does not discover the broad market. The discovery layer is sampling a capped set of providers before Brain Zero starts.

If no, where is the system stopping?

It stops in the discovery provider layer and candidate-enrichment layer:

- small provider request caps;
- OpenStreetMap timeout/no pagination;
- disabled or missing search API keys;
- existing CRM/Pipeline suppression;
- small website enrichment limits;
- Daily Growth email/score filters.

Single biggest bottleneck:

The remaining largest bottleneck is provider availability: if Brave is not configured, discovery runs in reduced-capacity mode and may depend heavily on OpenStreetMap, which can time out. With Brave configured, the bottleneck moves to public email availability on company websites.

Can discovery produce more leads safely?

Yes. The system can produce more without adding more industries first. The next fixes should broaden market coverage and provider depth:

- keep Brave configured in production;
- tile large map searches instead of one large Overpass query;
- add optional non-paid public sources where permitted;
- monitor diagnostics for no-email and invalid-email drop-off.

Are additional industries necessary?

Not yet. The existing trade list is already broad. The discovery bottleneck is provider depth and qualification flow, not the number of industries.
