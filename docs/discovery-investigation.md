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
5. Results are deduped.
6. Rating/review filters are applied.
7. Existing prospects are removed.
8. A capped candidate pool is enriched with websites.
9. Optional deep website research runs.
10. Final results are sorted with email-ready leads first.

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
| Provider request count | `min(count * 3, 60)` |
| OpenStreetMap element cap | 120 |
| Serper search terms | 3 |
| Serper results per term | 20 |
| Brave results per query | 20 |
| Serper website enrichment | 8 candidates |
| Brave website enrichment | 12 candidates |
| Deep research | 12 candidates |
| Daily Growth searches per run | 8 |
| Daily Growth leads per search | 8 |

## Funnel Example

For a user request such as `HVAC in Dallas, TX` with `count=10`:

| Stage | Maximum Before Real-World Drop-Off |
| --- | ---: |
| User asks for final leads | 10 |
| Provider candidate request | 30 |
| OpenStreetMap elements | 120 |
| Serper web/place candidates, if enabled | Up to 60 before dedupe |
| Brave web/location candidates, if enabled | Up to 20 before dedupe |
| After provider dedupe | Variable |
| After rating/review filters | Variable |
| After existing CRM/Pipeline filter | Variable |
| Initial candidate pool | 40 |
| Website enrichment | 8 with Serper, 12 with Brave |
| Deep research, if enabled | 12 |
| Final lead list | 10 |

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

This means the public map source alone is not enough for reliable high-volume lead discovery. Search APIs must be configured and the candidate window must be widened.

## Bottlenecks

1. Provider candidate caps are too small for large markets.
2. There is no pagination or tiling for OpenStreetMap/Overpass.
3. OpenStreetMap can time out and then discovery has no usable fallback unless Brave or Serper is configured.
4. Brave is hardcoded to US search settings, which weakens Canada, UK, and Europe discovery.
5. Serper is present in code but only works when `SERPER_API_KEY` is configured.
6. Serper maps broad Europe searches to `gb`, which limits country-specific European reach.
7. Australia is not supported by `normalizeCountry()`.
8. Daily Growth only runs 8 searches per run by default.
9. Daily Growth only keeps leads with email and score >= 75, so many discovered businesses never enter the working queue.
10. Existing CRM/Pipeline filtering removes already-seen companies before the final list. This is useful for avoiding duplicates, but it can make a repeated city look empty.

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

The largest bottleneck is the early discovery candidate window: provider results are capped and not paginated, then only 8 to 12 candidates get website enrichment. In practice, if OpenStreetMap times out and Serper/Brave is unavailable or weak for that country, no fresh prospects can populate.

Can discovery produce more leads safely?

Yes. The system can produce more without adding more industries first. The next fixes should broaden market coverage and provider depth:

- enable and verify Serper in production;
- make Brave country-aware;
- add country support for Australia and more Europe markets;
- add paginated/multi-query provider planning;
- tile large map searches instead of one large Overpass query;
- increase candidate enrichment limits behind safe rate limits;
- separate "discovered" leads from "email-ready" leads in Daily Growth.

Are additional industries necessary?

Not yet. The existing trade list is already broad. The discovery bottleneck is provider depth and qualification flow, not the number of industries.

