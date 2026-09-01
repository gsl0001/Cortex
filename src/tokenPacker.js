function defaultEstimate(text) {
  return Math.ceil(String(text).length / 3.5);
}

function truncateField(text, limit) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function packBrief(sections, { maxTokens = 1200, estimateTokens = defaultEstimate, fieldChars = 160, rawChars = 600 } = {}) {
  // Everything the brief renders is charged against the same budget (2026-07 audit: raw
  // sections and headings rode for free, so 87% of briefs exceeded their own cap). Raw
  // sections are reserved first — truncated to rawChars so an unbounded handoff can't eat
  // the brief — a heading costs tokens only when its section admits an item, and a section
  // that packs nothing renders nothing (no "- none" noise lines).
  let usedTokens = 0;
  let dropped = 0;
  const rawTexts = new Map();
  for (const section of sections) {
    if (!section.raw) continue;
    // Raw sections are charged against the SAME cap as list items (they used to reserve
    // unbudgeted, so a cold 350-token brief could exceed its own cap on raws alone).
    const remainingChars = Math.floor(Math.max(0, maxTokens - usedTokens) * 3.5);
    const cap = Math.min(rawChars, remainingChars);
    if (cap < 20) { dropped += 1; continue; }
    const full = String(section.text);
    const text = full.length <= cap ? full : `${full.slice(0, cap - 1)}…`;
    rawTexts.set(section, text);
    usedTokens += estimateTokens(text);
  }
  const rendered = [];
  for (const section of sections) {
    if (section.raw) {
      if (rawTexts.has(section)) rendered.push(rawTexts.get(section));
      continue;
    }
    const lines = [];
    for (const item of section.items || []) {
      const text = truncateField(item, fieldChars);
      const cost = estimateTokens(text) + (lines.length ? 0 : estimateTokens(section.heading));
      if (usedTokens + cost <= maxTokens) {
        lines.push(`- ${text}`);
        usedTokens += cost;
      } else {
        dropped += 1;
      }
    }
    if (lines.length) rendered.push(`${section.heading}\n${lines.join("\n")}`);
  }
  // contentText excludes the "(+N omitted)" footer: `dropped` counts items from sections that
  // never render, so hashing the footer made the brief hash churn on unrelated store activity
  // and killed delta suppression (live data: 4.6% suppression vs the ~58% the design assumed).
  const contentText = rendered.join("\n\n");
  let text = contentText;
  if (dropped > 0) {
    text += `\n\n(+${dropped} item${dropped !== 1 ? "s" : ""} omitted to fit budget — search to expand)`;
  }
  return { text, contentText, usedTokens, maxTokens, dropped };
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function packContext(results, { maxTokens = 1500, estimateTokens = defaultEstimate } = {}) {
  const selected = [];
  const excluded = [];
  const fingerprints = new Set();
  let usedTokens = 0;
  for (const result of results) {
    const fingerprint = `${normalized(result.title)}\u001f${normalized(result.excerpt)}`;
    if (fingerprints.has(fingerprint)) {
      excluded.push({ id: result.id, reason: "duplicate" });
      continue;
    }
    const text = `[${result.recordType}] ${result.title}\n${result.excerpt}`;
    const tokens = estimateTokens(text);
    if (usedTokens + tokens > maxTokens) {
      excluded.push({ id: result.id, reason: "budget" });
      continue;
    }
    fingerprints.add(fingerprint);
    selected.push({ ...result, text, tokens });
    usedTokens += tokens;
  }
  return {
    text: selected.map(({ text }) => text).join("\n\n"),
    citations: selected.map(({ id, recordType, title }) => ({ id, recordType, title })),
    usedTokens,
    maxTokens,
    excluded,
  };
}
