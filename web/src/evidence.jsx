import { Fragment } from "react";

// Agent evidence is markdown. ponytail: a full parser is a dependency we don't need —
// agents only emit **bold**, `code`, "- " bullets, and blank-line paragraphs. Handle those.
export function inline(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function Evidence({ text }) {
  if (!text) return null;
  const long = text.length > 320;
  const body = text.split(/\n/).map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} className="ev-gap" />;
    if (t.startsWith("- ")) return <div key={i} className="ev-bullet">{inline(t.slice(2))}</div>;
    return <div key={i} className="ev-line">{inline(t)}</div>;
  });
  if (!long) return <div className="evidence">{body}</div>;
  return (
    <details className="evidence">
      <summary>{inline(text.split(/\n/).find((l) => l.trim()) || "Show details")}</summary>
      {body}
    </details>
  );
}
