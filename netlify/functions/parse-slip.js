// netlify/functions/parse-slip.js
//
// Reads a PrizePicks slip / board screenshot and returns structured legs
// ready to hand to the judge pipeline. VISION EXTRACTION ONLY — it reports
// what's on the card; it does not fetch stats, look up players, or grade.
//
//   POST /api/parse-slip
//   body: { "image": "<base64 or data: URL>", "mediaType": "image/png" (optional) }
//   ->   { ok: true, slip: {...}, warnings: [...] }   on success
//        { ok: false, error: "..." }                  on failure
//
// Env:
//   ANTHROPIC_API_KEY  (required — same key the judge uses)
//   PARSE_MODEL        (optional — vision-capable model string;
//                       defaults to claude-sonnet-5, which is cheap and plenty
//                       for OCR-style extraction. No need to burn Opus here.)

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PARSE_MODEL = process.env.PARSE_MODEL || "claude-sonnet-5";

const EXTRACTION_PROMPT = `You are reading a screenshot from PrizePicks (a daily-fantasy prop app). Extract every pick on the card as strict JSON. Output JSON ONLY — no prose, no markdown code fences.

CRITICAL — do not confuse these two numbers:
- The LINE sits next to the stat name and the up/down arrow, e.g. "↓ 23.5 PRA". Extract this as "line".
- The large colored number inside the progress-bar bubble (e.g. "20", "38.8") is the ACTUAL RESULT of an already-settled pick. NEVER put this in "line". Only use its presence to decide "alreadySettled".

For each pick capture:
- player: full name exactly as shown, including accents (e.g. "Ismaïla Sarr")
- team: the abbreviation shown (e.g. "PDX", "WAS")
- position: position letter(s) if shown (G / F / C), else null
- number: jersey number as an integer if shown, else null
- stat: the stat name exactly as shown (e.g. "Rebounds", "PRA", "Fantasy Score", "FG Made")
- line: the numeric line next to the arrow (a number, e.g. 23.5 or 6)
- pick: "under" if the arrow points DOWN (PrizePicks labels this "less"); "over" if it points UP ("more")
- oddsType: "demon" if a red devil/demon icon sits next to the line; "goblin" if a green goblin icon sits next to the line; otherwise "standard"

Also capture slip-level fields:
- slipType: "flex" if the card says Flex, "power" if it says Power, else null
- legCount: total number of picks (a "6-Pick" play is 6)
- league: lowercase league code if visible ("wnba", "nba", "nfl", "mlb", "world_cup"), else null
- matchup: the game shown as "AAA vs BBB" using team abbreviations, else null
- alreadySettled: true if the card shows final results, win/loss coloring, a "Final" tag, or a payout; otherwise false

Return EXACTLY this shape and nothing else:
{
  "slipType": null,
  "legCount": 0,
  "league": null,
  "matchup": null,
  "alreadySettled": false,
  "legs": [
    { "player": "", "team": "", "position": null, "number": null, "stat": "", "line": 0, "pick": "under", "oddsType": "standard" }
  ]
}`;

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }

  const raw = body?.image;
  if (!raw || typeof raw !== "string") {
    return json({ ok: false, error: "Missing 'image' (base64 or data URL)" }, 400);
  }

  // Accept "data:image/png;base64,XXXX" or bare base64.
  let mediaType = body.mediaType || "image/png";
  let data = raw;
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (m) {
    mediaType = m[1];
    data = m[2];
  }

  let apiResp;
  try {
    apiResp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: PARSE_MODEL,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data } },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return json({ ok: false, error: "Anthropic request failed: " + e.message }, 502);
  }

  if (!apiResp.ok) {
    const detail = await apiResp.text().catch(() => "");
    return json({ ok: false, error: `Anthropic ${apiResp.status}`, detail }, 502);
  }

  const payload = await apiResp.json();
  const text = (payload.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const parsed = safeParseJSON(text);
  if (!parsed) return json({ ok: false, error: "Could not parse extraction as JSON", raw: text }, 502);

  const slip = normalizeSlip(parsed);

  const warnings = [];
  if (slip.alreadySettled) {
    warnings.push(
      "Card appears already settled (final results shown). Judging it has no predictive value — screenshot the slip before lock, or a live board, instead."
    );
  }
  if (!slip.legs.length) {
    warnings.push("No legs were read from the image.");
  }
  if (slip.legs.some((l) => l.line == null)) {
    warnings.push("One or more lines could not be read as a number — confirm before judging.");
  }

  return json({ ok: true, slip, warnings });
};

function normalizeSlip(p) {
  const legs = Array.isArray(p.legs) ? p.legs.map(normalizeLeg) : [];
  return {
    slipType: lower(p.slipType) || null,
    legCount: Number.isInteger(p.legCount) ? p.legCount : legs.length,
    league: lower(p.league) || null,
    matchup: p.matchup || null,
    alreadySettled: p.alreadySettled === true,
    legs,
  };
}

function normalizeLeg(l = {}) {
  let oddsType = lower(l.oddsType);
  if (!["goblin", "demon", "standard"].includes(oddsType)) oddsType = "standard";
  return {
    player: (l.player || "").trim(),
    team: (l.team || "").trim().toUpperCase() || null,
    position: l.position ? String(l.position).trim().toUpperCase() : null,
    number: numOrNull(l.number, true),
    stat: (l.stat || "").trim(),
    line: numOrNull(l.line, false),
    pick: lower(l.pick) === "over" ? "over" : "under",
    oddsType,
  };
}

function numOrNull(v, asInt) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  if (Number.isNaN(n)) return null;
  return asInt ? parseInt(n, 10) : n;
}

function lower(v) {
  return typeof v === "string" ? v.toLowerCase().trim() : "";
}

function safeParseJSON(text) {
  if (!text) return null;
  let t = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(t);
  } catch {}
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(t.slice(s, e + 1));
    } catch {}
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
