// Side-effect import: must be the FIRST import in any test file that exercises the
// pinned-watch guard, so the env var is set before tiers.js computes NEVER_AUTOPILOT
// at module-evaluation time.
process.env.CORTEX_NEVER_AUTOPILOT = "C:/work/master";
