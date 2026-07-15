import { normalizeProjectPath } from "./storage.js";

function resolveTask(hub, { projectPath, id, title }) {
  const normalizedProject = normalizeProjectPath(projectPath);
  if (id) {
    const task = hub.storage.getTask(id);
    if (!task || task.projectPath !== normalizedProject) throw new Error(`Task not found: ${id}`);
    return task;
  }
  if (!String(title || "").trim()) throw new Error("Task id or title is required");
  const query = title.toLowerCase();
  const matches = hub.listTasks({ projectPath: normalizedProject })
    .filter((task) => task.title.toLowerCase().includes(query));
  if (matches.length !== 1) throw new Error(`Title "${title}" matched ${matches.length} tasks`);
  return matches[0];
}

export function updateTaskByReference(hub, input) {
  const task = resolveTask(hub, input);
  let updated;
  if (input.status === "in_progress") {
    updated = hub.claimTask({ id: task.id, agent: input.agent || "claude-code", branch: input.branch });
  } else if (input.status === "blocked") {
    updated = hub.blockTask({ id: task.id, reason: input.reason || input.evidence || "blocked" });
  } else if (input.status === "review") {
    updated = hub.reviewTask({ id: task.id, evidence: input.evidence, commitSha: input.commitSha });
  } else if (input.status === "done") {
    updated = hub.completeTask({ id: task.id, evidence: input.evidence || "completed", commitSha: input.commitSha });
  } else if (["backlog", "ready"].includes(input.status)) {
    updated = hub.storage.updateTask(task.id, { status: input.status });
  } else {
    throw new Error(`Unsupported task status: ${input.status}`);
  }
  return {
    id: task.id,
    title: task.title,
    previousStatus: task.status,
    newStatus: updated.status,
  };
}
