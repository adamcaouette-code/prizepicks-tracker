// netlify/functions/pp-403-probe.js
//
// READ-ONLY forensics on the PrizePicks 403.
//
// What we actually know, as opposed to what has been assumed:
//
//   partner-api.prizepicks.com   /leagues, /projections      WORK, every call
//   api.prizepicks.com           /projections/{id}/history   403, every call
//
// That is a HOST-specific difference, not "PrizePicks blocks this app". Both
// hosts are the same company, almost certainly behind the same edge. If the
// block were IP or ASN based — the datacenter-range explanation — partner-api
// would fail too, and it does not. So the cause is something about that host or
// that endpoint, and the previous diagnosis (a status code and a guess) never
// established which.
//
// This probe collects evidence instead of inferring:
//
//   A  the real response on the failing endpoint — status, server, cf-ray,
//      cf-mitigated, and the first part of the BODY, which is what separates a
//      Cloudflare bot challenge from an auth error from a rate limit
//   B  whether the whole host is blocked or only that endpoint
//   C  whether ordinary client headers change the answer
//   D  whether partner-api — the host that works — serves results anywhere
//   E  whether a settled projection carries its own result, which would make
//      grading free from an endpoint we ALREADY have access to
//
// E is the most promising and the least exotic. The engine already parses
// `status: pre_game | in_progress | final` off partner-api projections. If a
// final projection also carries its score, nothing needs to be worked around.
//
// Usage: /api/pp-403-probe                 auto-picks a live projection id
//        /api/pp-403-probe?id=123456       a specific one
//        /api/pp-403-probe?league_id=2     which league to sample

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const BROWSERISH = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://app.prizepicks.com/',
  Origin: 'https://app.prizepicks.com',
};

// Headers worth reporting: these are what identify the edge and its verdict.
const TELLING = ['server', 'cf-ray', 'cf-mitigated', 'cf-cache-status', 'retry-after',
  'x-ratelimit-remaining', 'content-type', 'www-authenticate', 'set-cookie'];

async function probe(url, headers = {}, ms = 4000) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    const hdrs = {};
    for (const h of TELLING) { const v = res.headers.get(h); if (v) hdrs[h] = String(v).slice(0, 120); }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON — that itself is a signal */ }
    return {
      url: url.replace(/\?.*$/, ''),
      status: res.status,
      ms: Date.now() - started,
      headers: hdrs,
      // A Cloudflare interstitial is HTML and says so; an API error is JSON.
      looksLike: /<!DOCTYPE html|<html/i.test(text) ? 'HTML page (challenge or error page)'
        : json ? 'JSON' : text ? 'plain text' : 'empty',
      bodyStart: text.replace(/\s+/g, ' ').slice(0, 220),
      jsonKeys: json && typeof json === 'object' ? Object.keys(json).slice(0, 12) : null,
    };
  } catch (e) {
    return { url: url.replace(/\?.*$/, ''), status: 0, ms: Date.now() - started, error: String(e.name === 'AbortError' ? 'timeout' : e.message).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const leagueId = q.league_id || '2';

  try {
    // ---- get a real projection id off the host that works -------------------
    const listUrl = `https://partner-api.prizepicks.com/projections?per_page=25&single_stat=true&league_id=${leagueId}&page=1`;
    const list = await probe(listUrl, BROWSERISH, 6000);

    let sampleId = q.id || null;
    let statusCounts = {};
    let attributeKeys = null;
    let settledSample = null;

    if (!sampleId || !q.id) {
      try {
        const res = await fetch(listUrl, { headers: BROWSERISH });
        const body = await res.json();
        const rows = Array.isArray(body?.data) ? body.data : [];
        if (rows.length) {
          sampleId = sampleId || rows[0].id;
          // E: every attribute a projection carries. If a result field exists,
          // it is in this list — and that would make grading free.
          attributeKeys = Object.keys(rows[0].attributes || {}).sort();
          for (const r of rows) {
            const st = r.attributes?.status || 'unknown';
            statusCounts[st] = (statusCounts[st] || 0) + 1;
            // A settled projection is the interesting one: does it carry a score?
            if (!settledSample && /final|settled|complete|graded/i.test(st)) {
              settledSample = { id: r.id, attributes: r.attributes };
            }
          }
        }
      } catch { /* the probe above already recorded the failure */ }
    }

    const id = sampleId || '0';

    // ---- A + B + C + D, concurrently ---------------------------------------
    const [
      histBrowser, histBare, histNoOrigin,
      apiList, apiRoot,
      partnerHistory, partnerSingle, partnerResults, partnerScores,
    ] = await Promise.all([
      // A / C: the failing endpoint under three header sets. If all three give
      // the same answer, headers are not the variable and no amount of header
      // tuning will fix it.
      probe(`https://api.prizepicks.com/projections/${id}/history`, BROWSERISH),
      probe(`https://api.prizepicks.com/projections/${id}/history`, {}),
      probe(`https://api.prizepicks.com/projections/${id}/history`, { 'User-Agent': BROWSERISH['User-Agent'], Accept: 'application/json' }),
      // B: is the whole host blocked, or just this endpoint?
      probe(`https://api.prizepicks.com/projections?league_id=${leagueId}&per_page=2`, BROWSERISH),
      probe('https://api.prizepicks.com/leagues', BROWSERISH),
      // D: does the host that WORKS serve results anywhere?
      probe(`https://partner-api.prizepicks.com/projections/${id}/history`, BROWSERISH),
      probe(`https://partner-api.prizepicks.com/projections/${id}`, BROWSERISH),
      probe('https://partner-api.prizepicks.com/results?per_page=2', BROWSERISH),
      probe(`https://partner-api.prizepicks.com/scores?league_id=${leagueId}`, BROWSERISH),
    ]);

    // ---- read the evidence --------------------------------------------------
    const ok = (r) => r.status >= 200 && r.status < 300;
    const findings = [];

    const partnerWorks = ok(list);
    const apiHostBlocked = [histBrowser, apiList, apiRoot].every((r) => r.status === 403);

    if (partnerWorks && apiHostBlocked) {
      findings.push('partner-api works while EVERY api.prizepicks.com endpoint returns 403 — the block is host-wide, not specific to the history endpoint. An IP or ASN ban would have taken partner-api down too, so it is that host refusing this client.');
    } else if (partnerWorks && ok(apiList) && histBrowser.status === 403) {
      findings.push('api.prizepicks.com serves other endpoints but 403s /history specifically — that is endpoint-level authorisation, not bot blocking. History likely requires a signed-in session, which is a very different problem from being blocked.');
    }

    const headerSensitive = new Set([histBrowser.status, histBare.status, histNoOrigin.status]).size > 1;
    findings.push(headerSensitive
      ? 'Headers CHANGE the outcome — see which variant differs; the right header set may be all that is missing.'
      : 'All three header variants return the same status, so headers are not the variable. Tuning User-Agent or Referer will not fix this.');

    if (histBrowser.looksLike?.startsWith('HTML')) {
      findings.push('The 403 body is an HTML page rather than JSON — that is an edge/WAF interstitial, not the API answering. Check cf-ray and cf-mitigated above.');
    } else if (histBrowser.jsonKeys) {
      findings.push('The 403 body is JSON — the API itself is refusing, and the message in bodyStart is the actual reason. Read it literally.');
    }

    const partnerAlt = [partnerHistory, partnerSingle, partnerResults, partnerScores].filter(ok);
    if (partnerAlt.length) {
      findings.push(`WORKAROUND FOUND: ${partnerAlt.map((r) => r.url).join(', ')} responds on the host that is not blocked. If it carries results, grading can move there with no evasion of any kind.`);
    } else {
      findings.push('No results endpoint found on partner-api — every candidate tried returned an error. That host appears to serve upcoming projections only.');
    }

    if (settledSample) {
      findings.push('A SETTLED projection is present in the live feed — inspect settledSample.attributes below for a score/result field. If one exists, grading is free from the endpoint the app already calls successfully.');
    } else if (attributeKeys) {
      findings.push('No settled projection in the current feed, so whether a final one carries its result is still unknown. Re-run this shortly after games finish — that is when the answer appears.');
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
      projectionIdUsed: id,
      findings,
      A_failingEndpoint: { withBrowserHeaders: histBrowser, withNoHeaders: histBare, withMinimalHeaders: histNoOrigin },
      B_isTheWholeHostBlocked: { projectionsList: apiList, leagues: apiRoot },
      D_partnerApiCandidates: { history: partnerHistory, singleProjection: partnerSingle, results: partnerResults, scores: partnerScores },
      E_doProjectionsCarryResults: {
        listCall: { status: list.status, ms: list.ms },
        statusCounts,
        attributeKeys,
        settledSample,
        note: 'attributeKeys is every field a projection carries. A result field would appear there. statusCounts shows whether settled projections stay in the feed at all.',
      },
      nextStep: 'Paste this whole response back. The findings array names the cause; A/B/C separate a WAF block from an auth requirement, and D/E test the two legitimate routes that need no workaround.',
    }, null, 2) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
