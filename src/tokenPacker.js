function defaultEstimate(text) {
  return Math.ceil(String(text).length / 3.5);
}

function truncateField(text, limit) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function packBrief(sections, { maxTokens = 1200, estimateTokens = defaultEstimate, fieldChars = 160 } = {}) {
  const rendered = [];
  let usedTokens = 0;
  let dropped = 0;
  for (const section of sections) {
    if (section.raw) {
      usedTokens += estimateTokens(section.text);
      rendered.push(section.text);
      continue;
    }
    const lines = [];
    for (const item of section.items || []) {
      const text = truncateField(item, fieldChars);
      const cost = estimateTokens(text);
      if (usedTokens + cost <= maxTokens) {
        lines.push(`- ${text}`);
        usedTokens += cost;
      } else {
        dropped += 1;
      }
    }
    rendered.push(`${section.heading}\n${lines.length ? lines.join("\n") : "- none"}`);
  }
  let text = rendered.join("\n\n");
  if (dropped > 0) {
    text += `\n\n(+${dropped} item${dropped !== 1 ? "s" : ""} omitted to fit budget — search to expand)`;
  }
  return { text, usedTokens, maxTokens, dropped };
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
