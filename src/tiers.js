import { normalizeProjectPath } from "./storage.js";

// Lived in agentLauncher.js until the task rail was deleted (value audit V phase 2);
// the pin outlives the launcher because tiers/stall reporting still read it.
export const autopilotKey = (path) => String(path || "").toLowerCase().replaceAll("\\", "/");
// Set CORTEX_NEVER_AUTOPILOT to a comma-separated list of absolute paths (e.g. a
// production or money-moving repo). Each entry is keyed through the SAME normalization
// a task's projectPath gets (resolve + git-root + lowercase), so a subdirectory,
// trailing separator, or mixed-separator spelling of a protected repo still collapses
// to the repo root and the pin fires.
export const parseNeverAutopilot = (raw) =>
  new Set(
    (raw || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => autopilotKey(normalizeProjectPath(p))),
  );
export const NEVER_AUTOPILOT = parseNeverAutopilot(process.env.CORTEX_NEVER_AUTOPILOT);

// How much autonomy a project has granted, lowest first. Enrollment used to be one boolean,
// which is why eight projects sat "enrolled" holding nothing while the live-money repo had to
// be defended by a hard-coded exclusion list. A dial says what you actually want per repo.
//   watch  — remembered and reported; no agent process is ever launched
//   plan   — agents may propose tasks and flag stalls; never execute
//   assist — runs only when a human releases a specific task (today's manual launch)
//   auto   — works the ready queue inside the night window; results always park for review
export const TIERS = ["watch", "plan", "assist", "auto"];
const RANK = new Map(TIERS.map((t, i) => [t, i]));

// A floor, not a filter: a project pinned here cannot be raised by any setting write.
export const PINNED_WATCH = NEVER_AUTOPILOT;

const SETTING_PREFIX = "autopilot.tier.";

export const isPinnedWatch = (projectPath) => PINNED_WATCH.has(autopilotKey(projectPath));
export const tierKey = (projectPath) => `${SETTING_PREFIX}${autopilotKey(projectPath)}`;
export const atLeast = (tier, floor) => (RANK.get(tier) ?? 0) >= (RANK.get(floor) ?? 0);

// Rows written before the {tier, path} shape stored the bare tier string, so both shapes read.
const storedTier = (stored) => (stored && typeof stored === "object" ? stored.tier : stored);

// Unset projects inherit from the legacy enrollment list so existing installs keep working:
// enrolled meant "the dispatcher may run this", which is `auto`. Everything else starts at
// `watch`, so a newly-seen project is never autonomous by default.
export function projectTier(storage, projectPath) {
  if (isPinnedWatch(projectPath)) return "watch";
  const stored = storedTier(storage.getSetting(tierKey(projectPath), null));
  if (RANK.has(stored)) return stored;
  const legacy = storage.getSetting("dispatcher.projects", []) || [];
  return legacy.some((p) => autopilotKey(p) === autopilotKey(projectPath)) ? "auto" : "watch";
}

export function setProjectTier(storage, projectPath, tier) {
  if (!RANK.has(tier)) throw new Error(`unknown tier: ${tier}`);
  if (isPinnedWatch(projectPath) && tier !== "watch") {
    throw new Error(`${projectPath} is pinned at watch and cannot be promoted`);
  }
  storage.setSetting(tierKey(projectPath), { tier, path: projectPath });
  return tier;
}
