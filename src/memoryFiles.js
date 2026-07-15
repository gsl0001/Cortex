import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() || "";
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
  const tagsText = match[1].match(/^tags:\s*\[(.+)\]/m)?.[1];
  return {
    name,
    description,
    tags: tagsText
      ? tagsText.split(",").map((tag) => tag.trim().replace(/['"]/g, ""))
      : [],
  };
}

export function loadRelevantMemories(memoryDirs, keywords, { limit = 5 } = {}) {
  const candidates = [];
  for (const memoryDir of memoryDirs || []) {
    let files;
    try {
      files = readdirSync(memoryDir).filter((file) => file.endsWith(".md") && file !== "MEMORY.md");
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const { name, description, tags } = parseFrontmatter(
          readFileSync(join(memoryDir, file), "utf8"),
        );
        if (!name) continue;
        const searchable = `${name} ${description} ${tags.join(" ")}`.toLowerCase();
        const score = keywords.filter((keyword) => searchable.includes(keyword.toLowerCase())).length;
        if (score > 0) candidates.push({ name, description, file: join(memoryDir, file), score });
      } catch {
        // A malformed memory file must not block agent startup.
      }
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}
