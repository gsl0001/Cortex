export const LINK_TYPES = Object.freeze(new Set([
  // structural (hidden in graph by default)
  "belongs_to_project",
  "belongs_to",
  "part_of",
  "changes_file",
  "implements_task",
  "fixed_by_commit",

  // causal / temporal
  "caused_by",
  "triggers",
  "precedes",
  "follows",

  // epistemic
  "supported_by",
  "contradicts",
  "verified_by",
  "refutes",
  "cites",

  // project / work
  "blocked_by",
  "depends_on",
  "supersedes",
  "replaces",
  "duplicates",

  // semantic
  "related_to",
  "similar_to",
  "derived_from",
  "generalizes",
  "specializes",

  // risk / decision
  "mitigates",
  "escalates",
  "decided_by",
  "influences",
]));

export function assertLinkType(linkType) {
  if (!LINK_TYPES.has(linkType)) throw new Error(`Unknown link type: ${linkType}`);
}
