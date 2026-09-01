// Topic scoping (value audit IV). Project *labels* are not project *topics*: a record is filed
// under the directory the session ran in, so asking a hub session about the camera app files
// camera content under the hub. Measured on live data, 13.8% of hub-labelled records were about
// a different project — 32% of research, 17.8% of decisions — and every one of them was served
// as "Cortex" history. The project_path check audit IV reported as "0% foreign" compares
// labels, so it passes on exactly these rows and cannot see the pollution.
//
// This is a one-sided read-side test, deliberately: it never re-files a record (attribution
// needs a judgement call this can't make), it only declines to serve one in a brief where it
// plainly does not belong. Set CORTEX_TOPIC_SCOPE=0 to disable without a redeploy.

// Words that appear in project names but identify nothing.
const STOP = new Set([
  "app", "apps", "system", "systems", "project", "projects", "lite", "new", "folder",
  "user", "users", "work", "documents", "local", "src", "code", "tool", "tools", "the",
  "and", "for", "via", "win", "windows", "ios", "web", "api", "cli", "dev", "test",
]);

const terms = (text) => new Set(String(text || "").toLowerCase().match(/[a-z]{3,}/g) || []);

// Asymmetric thresholds, because the two sides carry opposite risks. Recognising a record's OWN
// project only ever keeps a record, so that side is generous at 3+ characters — "hub" is how
// this project is named in practice, and a 4-character floor made it invisible. Triggering on a
// FOREIGN project drops a record, so that side demands 4+: three-letter fragments of a directory
// name ("low" from low_cap, "cap") are ordinary English and would filter honest records.
const TRIGGER_MIN_LENGTH = 4;

// A project's identifying vocabulary: its directory name plus its profile name. A term shared by
// two or more projects identifies neither, so it is dropped everywhere — that self-tunes as
// projects are added and keeps generic words ("memory", "trading") from ever gating anything.
export function buildProjectIndex(profiles = []) {
  const raw = new Map();
  for (const profile of profiles) {
    const path = profile?.projectPath;
    if (!path) continue;
    const base = String(path).split("/").filter(Boolean).pop() || "";
    const set = terms(`${base.replace(/[-_]/g, " ")} ${profile.name || ""}`);
    for (const stop of STOP) set.delete(stop);
    raw.set(path, set);
  }
  const counts = new Map();
  for (const set of raw.values()) for (const term of set) counts.set(term, (counts.get(term) || 0) + 1);
  const index = new Map();
  for (const [path, set] of raw) {
    const own = new Set([...set].filter((t) => counts.get(t) === 1));
    index.set(path, { own, trigger: new Set([...own].filter((t) => t.length >= TRIGGER_MIN_LENGTH)) });
  }
  return index;
}

// True when the text names some OTHER registered project and never names this one. Silence is
// not evidence: a record mentioning no project at all ("Ollama caches GPU discovery at startup")
// stays, which is the common case and must not be filtered.
export function isOffTopic(text, projectPath, index) {
  if (!index?.size) return false;
  const entry = index.get(projectPath);
  if (!entry) return false;
  const tokens = terms(text);
  if (!tokens.size) return false;
  for (const term of entry.own) if (tokens.has(term)) return false;
  // A record naming TWO OR MORE foreign projects is a cross-project rule ("never enroll
  // master in Autopilot"), not a mis-filed record — those are among the highest-value
  // records the hub holds, and they were this filter's concentrated false negatives.
  let foreign = 0;
  for (const [path, other] of index) {
    if (path === projectPath) continue;
    for (const term of other.trigger) {
      if (tokens.has(term)) {
        foreign += 1;
        break;
      }
    }
    if (foreign > 1) return false;
  }
  return foreign === 1;
}
