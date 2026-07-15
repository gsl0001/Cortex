import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App.jsx";
import { addDays, mondayOf, today } from "./Goals.jsx";

afterEach(() => { cleanup(); window.innerWidth = 1024; });

test("renders the command center shell and preserves existing views", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  render(<App />);
  const navigation = within(screen.getByRole("navigation", { name: "Primary" }));
  for (const name of ["Command center", "Search", "Tasks", "Knowledge graph", "Activity log", "More"]) {
    expect(navigation.getByRole("button", { name })).toBeInTheDocument();
  }
  expect(screen.getByRole("heading", { name: /working late|good morning|good afternoon|good evening/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");

  fireEvent.click(navigation.getByRole("button", { name: "Search" }));
  expect(screen.getByLabelText("Search project memory")).toBeInTheDocument();
  fireEvent.click(navigation.getByRole("button", { name: "Knowledge graph" }));
  expect(screen.getByRole("heading", { name: "Relationship graph" })).toBeInTheDocument();
});

test("uses icon sidebar on mobile with More menu for secondary views", async () => {
  window.innerWidth = 375;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  render(<App />);
  const navigation = within(screen.getByRole("navigation", { name: "Primary" }));
  for (const name of ["Command center", "Control Center", "Goals", "Search", "Tasks", "More"]) {
    expect(navigation.getByRole("button", { name })).toBeInTheDocument();
  }
  // bottom-bar buttons carry a short visible label under the icon (full name stays the aria-label)
  const homeBtn = navigation.getByRole("button", { name: "Command center" });
  expect(within(homeBtn).getByText("Home")).toBeInTheDocument();
  expect(within(navigation.getByRole("button", { name: "Control Center" })).getByText("Control")).toBeInTheDocument();
  fireEvent.click(navigation.getByRole("button", { name: "More" }));
  const menu = screen.getByRole("menu", { name: "More destinations" });
  expect(within(menu).getByRole("menuitem", { name: "Runs" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Health & audit" })).toBeInTheDocument();
});

test("activity log renders cross-DB rows and filters by type", async () => {
  const rows = [
    { id: "f1", type: "fix", ts: new Date().toISOString(), project: "C:/demo", agent: "claude", title: "Fixed cache", detail: "stop-hook" },
    { id: "d1", type: "decision", ts: new Date().toISOString(), project: "C:/demo", agent: "codex", title: "Adopt WAL", detail: "concurrency" },
  ];
  const fetchMock = vi.fn().mockImplementation((path) => {
    const s = String(path);
    if (s.includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/demo", name: "Demo" }] });
    if (s.includes("/activity-log")) {
      const filtered = s.includes("types=fix") ? rows.filter((r) => r.type === "fix") : rows;
      return Promise.resolve({ ok: true, json: async () => filtered });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  const navigation = within(screen.getByRole("navigation", { name: "Primary" }));
  fireEvent.click(navigation.getByRole("button", { name: "Activity log" }));
  expect(await screen.findByText("Fixed cache")).toBeInTheDocument();
  expect(await screen.findByText("Adopt WAL")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "fix" }));
  await vi.waitFor(() => expect(screen.queryByText("Adopt WAL")).not.toBeInTheDocument());
  expect(screen.getByText("Fixed cache")).toBeInTheDocument();
});

test("tasks view: This week is the default, and All tasks groups by project", async () => {
  const tasks = [
    {
      id: "task-1",
      projectPath: "/home/user/projects/app",
      title: "Add push-based fill handler with a very long implementation title",
      status: "ready",
      priority: "high",
      assignedAgent: null,
      branch: null,
      verificationCommand: "python -m pytest -q",
    },
    {
      id: "task-2",
      projectPath: "C:/spy/cortex",
      title: "Add next-task command for agent workflow",
      status: "in_progress",
      priority: "high",
      assignedAgent: "claude-code",
      branch: "main",
      verificationCommand: "npm test",
    },
  ];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((path) => {
    if (String(path).includes("/projects")) {
      return Promise.resolve({ ok: true, json: async () => [
        { projectPath: "/home/user/projects/app", name: "Example App" },
        { projectPath: "C:/spy/cortex", name: "Cortex" },
      ] });
    }
    if (String(path).includes("/tasks")) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => [] });
  }));
  render(<App />);

  const navigation = within(screen.getByRole("navigation", { name: "Primary" }));
  fireEvent.click(navigation.getByRole("button", { name: "Tasks" }));

  // neither task has a milestoneId, so both are user requests by default
  const userReqPane = within(await screen.findByRole("complementary", { name: "User requests" }));
  expect(userReqPane.getByText("Add push-based fill handler with a very long implementation title")).toBeInTheDocument();
  // origin is now a subtle dot, not a text label — one per user-request row
  expect(userReqPane.getAllByLabelText("User request").length).toBe(2);

  fireEvent.click(screen.getByRole("button", { name: "All tasks" }));
  expect(screen.getAllByText("Example App").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Cortex").length).toBeGreaterThan(0);
  // agent is an inline select; task-2's assigned agent is preselected
  expect(screen.getByLabelText("Assign agent for Add next-task command for agent workflow")).toHaveValue("claude-code");
  // status pills are shown per row, and portfolio progress is computed over all tasks
  expect(screen.getByText("In progress")).toBeInTheDocument();
  expect(screen.getByText("Ready")).toBeInTheDocument();
  expect(screen.getByText(/0 of 2 done/)).toBeInTheDocument();
});

test("this-week workbench splits scheduled roadmap tasks from unscheduled user requests", async () => {
  const weekStart = mondayOf(today());
  const tasks = [
    { id: "t1", projectPath: "/home/user/projects/app", title: "Scheduled roadmap task", status: "ready", priority: "high", milestoneId: "m1", scheduledFor: weekStart },
    { id: "t2", projectPath: "/home/user/projects/app", title: "Ad-hoc user request", status: "ready", priority: "normal" },
    { id: "t3", projectPath: "/home/user/projects/app", title: "Future roadmap task", status: "ready", priority: "high", milestoneId: "m1", scheduledFor: addDays(weekStart, 30) },
    { id: "t4", projectPath: "/home/user/projects/app", title: "Scheduled ad-hoc request", status: "ready", priority: "normal", scheduledFor: weekStart },
  ];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((path) => {
    if (String(path).includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "/home/user/projects/app", name: "Example App" }] });
    if (String(path).includes("/tasks")) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => [] });
  }));
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));

  const roadmapPane = within(await screen.findByRole("region", { name: "Roadmap, this week" }));
  expect(roadmapPane.getByText("Scheduled roadmap task")).toBeInTheDocument();
  expect(roadmapPane.queryByText("Roadmap")).toBeNull();
  // scope to the row title (not the "Depends on" select, which lists sibling tasks project-wide as <option>s)
  expect(roadmapPane.queryByText("Future roadmap task", { selector: ".task-title-text" })).not.toBeInTheDocument();
  expect(roadmapPane.queryByText("Ad-hoc user request", { selector: ".task-title-text" })).not.toBeInTheDocument();

  // user requests = everything outside the roadmap, scheduled or not
  const userReqPane = within(screen.getByRole("complementary", { name: "User requests" }));
  expect(userReqPane.getByText("Ad-hoc user request", { selector: ".task-title-text" })).toBeInTheDocument();
  expect(userReqPane.getByText("Scheduled ad-hoc request", { selector: ".task-title-text" })).toBeInTheDocument();
  // origin dots (aria-label) replace the old "User req" text tag
  expect(userReqPane.getAllByLabelText("User request").length).toBe(2);
});

test("empty this-week panes show guidance, and Add user request posts a new task", async () => {
  const fetchMock = vi.fn().mockImplementation((path, options = {}) => {
    const url = String(path);
    if (url.includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/repo", name: "Repo" }] });
    if (url.endsWith("/tasks") && options.method === "POST") return Promise.resolve({ ok: true, json: async () => ({ id: "new-1" }) });
    if (url.endsWith("/tasks")) return Promise.resolve({ ok: true, json: async () => [] });
    return Promise.resolve({ ok: true, json: async () => [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));

  expect(await screen.findByText("No roadmap tasks scheduled this week")).toBeInTheDocument();
  expect(screen.getByText("No user requests")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Add user request" }));
  const dialog = screen.getByRole("dialog", { name: "Add user request" });
  fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Look into flaky test" } });
  fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "bug" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add request" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks", expect.objectContaining({ method: "POST" })));
  const postCall = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/api/v1/tasks") && o?.method === "POST");
  const body = JSON.parse(postCall[1].body);
  expect(body.title).toBe("Look into flaky test");
  expect(body.type).toBe("bug");
  expect(body.projectPath).toBe("C:/repo");
});

test("shows Continue for an in-progress task with a resumable run, Launch otherwise", async () => {
  const tasks = [
    { id: "t-run", projectPath: "C:/repo", title: "Task with live run", status: "in_progress", priority: "normal" },
    { id: "t-ready", projectPath: "C:/repo", title: "Task ready to launch", status: "ready", priority: "normal" },
  ];
  const runs = [{ taskId: "t-run", agent: "claude-code", status: "running", sessionId: "sess-1", startedAt: new Date().toISOString() }];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((path) => {
    const url = String(path);
    if (url.includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/repo", name: "Repo" }] });
    if (url.endsWith("/runs")) return Promise.resolve({ ok: true, json: async () => runs });
    if (url.endsWith("/tasks")) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => [] });
  }));
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));

  expect(await screen.findByRole("link", { name: "Continue" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Launch Task ready to launch" })).toBeEnabled();
});

test("blocked task shows one merged detail line: run state + reason (log path stripped), expandable, with Open in Claude", async () => {
  const started = new Date(Date.now() - 5000).toISOString();
  const ended = new Date().toISOString();
  const tasks = [{
    id: "t-blocked", projectPath: "C:/repo", title: "Wire up handler", status: "blocked", priority: "normal",
    blockReason: "Agent exited with code 1; log: C:\\Users\\me\\.cortex\\runs\\abc.log",
  }];
  const runs = [{ taskId: "t-blocked", agent: "claude-code", status: "failed", sessionId: "sess-x", startedAt: started, endedAt: ended, lastEvent: "Agent exited with code 1" }];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((path) => {
    const url = String(path);
    if (url.includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/repo", name: "Repo" }] });
    if (url.endsWith("/runs")) return Promise.resolve({ ok: true, json: async () => runs });
    if (url.endsWith("/tasks")) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => [] });
  }));
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));

  // one collapsed summary, run state merged in, raw log path stripped from the visible line
  const summary = await screen.findByText(/failed in 5s.*exited with code 1/i, { selector: "summary" });
  expect(summary.textContent).not.toContain("log:");
  expect(summary.textContent).not.toContain(".log");

  // the run sub-row is gone; its Open-in-Claude link now lives on the detail line
  expect(screen.getByRole("link", { name: "Open in Claude" })).toBeInTheDocument();

  // expanding reveals the full text including the raw log path
  fireEvent.click(summary);
  expect(screen.getByText(/log: C:\\Users\\me/)).toBeInTheDocument();
});

test("renders the Stats panel from the stats endpoint", async () => {
  const stats = { recallCount: 3, avgTokens: 220, tokensP95: 400, captureTotal: 5, captureByReason: { accepted_fix: 2, discarded_near_duplicate: 1 }, records: { fix: 4, research: 2 }, supersededFixes: 1 };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((path) => {
    if (String(path).includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/demo", name: "Demo" }] });
    if (String(path).includes("/stats")) return Promise.resolve({ ok: true, json: async () => stats });
    if (String(path).includes("/audit")) return Promise.resolve({ ok: true, json: async () => ({ issues: [{ code: "stale_index", message: "Search index needs refresh" }] }) });
    return Promise.resolve({ ok: true, json: async () => [] });
  }));
  render(<App />);
  const navigation = within(screen.getByRole("navigation", { name: "Primary" }));
  fireEvent.click(navigation.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Health & audit" }));
  expect(await screen.findByText("220")).toBeInTheDocument(); // avg tokens card
  expect(await screen.findByText("Search index needs refresh")).toBeInTheDocument();
});

test("Health & audit findings sharing the same code do not trigger a React duplicate-key warning", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const stats = { recallCount: 0, avgTokens: 0, tokensP95: 0, captureTotal: 0, captureByReason: {}, records: { fix: 0, research: 0 }, supersededFixes: 0 };
  const issues = [
    { code: "fix_missing_verification", message: "Fix A has no verification evidence." },
    { code: "fix_missing_verification", message: "Fix B has no verification evidence." },
  ];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((path) => {
    if (String(path).includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/demo", name: "Demo" }] });
    if (String(path).includes("/stats")) return Promise.resolve({ ok: true, json: async () => stats });
    if (String(path).includes("/audit")) return Promise.resolve({ ok: true, json: async () => ({ issues }) });
    return Promise.resolve({ ok: true, json: async () => [] });
  }));
  render(<App />);
  const navigation = within(screen.getByRole("navigation", { name: "Primary" }));
  fireEvent.click(navigation.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Health & audit" }));
  expect(await screen.findByText("Fix A has no verification evidence.")).toBeInTheDocument();
  expect(await screen.findByText("Fix B has no verification evidence.")).toBeInTheDocument();
  const keyWarning = consoleError.mock.calls.some((call) => String(call[0]).includes("same key"));
  expect(keyWarning).toBe(false);
  consoleError.mockRestore();
});

test("launch opens reviewed task handoffs in Codex and Claude", async () => {
  const tasks = [{
    id: "task-1", projectPath: "C:/repo", title: "Fix launch", status: "ready", priority: "high",
    acceptanceCriteria: "Desktop app opens", relatedFiles: ["src/x.js"], verificationCommand: "npm test",
  }];
  const fetchMock = vi.fn(async (path, options = {}) => {
    const url = String(path);
    if (url.includes("/projects")) return { ok: true, json: async () => [{ projectPath: "C:/repo", name: "Repo" }] };
    if (url.endsWith("/runs")) return { ok: true, json: async () => [] };
    if (url.endsWith("/tasks")) return { ok: true, json: async () => tasks };
    return { ok: true, json: async () => [] };
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));

  fireEvent.click(await screen.findByRole("button", { name: "Launch Fix launch" }));
  expect(screen.getByRole("dialog", { name: "Launch task" })).toBeInTheDocument();

  const codexUrl = new URL(screen.getByRole("link", { name: "Open in Codex" }).getAttribute("href"));
  expect(codexUrl.href).toMatch(/^codex:\/\/threads\/new\?/);
  expect(codexUrl.searchParams.get("path")).toBe("C:/repo");
  expect(codexUrl.searchParams.get("prompt")).toContain("Task ID: task-1");
  expect(codexUrl.searchParams.get("prompt")).toContain("Desktop app opens");

  fireEvent.click(screen.getByLabelText("Claude Code"));
  const claudeUrl = new URL(screen.getByRole("link", { name: "Open in Claude" }).getAttribute("href"));
  expect(claudeUrl.href).toMatch(/^claude:\/\/code\/new\?/);
  expect(claudeUrl.searchParams.get("folder")).toBe("C:/repo");
  expect(claudeUrl.searchParams.get("q")).toContain("--agent claude-code");
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/tasks/task-1/launch"))).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "More actions for Fix launch" }));
  expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Remove" })).toBeInTheDocument();
});

test("edit sends PATCH action edit; remove confirms then surfaces API errors", async () => {
  let tasks = [{ id: "task-1", projectPath: "C:/repo", title: "Old", status: "ready", priority: "normal" }];
  const fetchMock = vi.fn(async (path, options = {}) => {
    const url = String(path);
    if (url.includes("/projects")) return { ok: true, json: async () => [{ projectPath: "C:/repo", name: "Repo" }] };
    if (url.endsWith("/tasks/task-1") && options.method === "PATCH") {
      tasks = [{ ...tasks[0], title: "New" }];
      return { ok: true, json: async () => tasks[0] };
    }
    if (url.endsWith("/tasks/task-1") && options.method === "DELETE") {
      return { ok: false, status: 400, json: async () => ({ error: { message: "Task has an unfinished run" } }) };
    }
    if (url.endsWith("/runs")) return { ok: true, json: async () => [] };
    if (url.endsWith("/tasks")) return { ok: true, json: async () => tasks };
    return { ok: true, json: async () => [] };
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));

  fireEvent.click(await screen.findByRole("button", { name: "More actions for Old" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit task" });
  fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "New" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save task" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/tasks/task-1",
    expect.objectContaining({ method: "PATCH" }),
  ));
  const patchCall = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/tasks/task-1") && o?.method === "PATCH");
  expect(JSON.parse(patchCall[1].body).action).toBe("edit");

  fireEvent.click(await screen.findByRole("button", { name: "More actions for New" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove task" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("unfinished run");
});

// ---- Control Center (replaces the old Needs-you view) ----
// Base fetch mock for the CC's five reads; per-test overrides layer on top.
function ccFetch(overrides = {}) {
  const {
    needs = { reviews: [], inbox: [], dispatcher: { enabled: false, projects: [], activeRuns: 0, lastTickAt: null } },
    runs = [], tasks = [], overview = { capturedToday: 0, durableMemories: 0, blockedTasks: 0 },
    settings = {}, projects = [{ projectPath: "C:/repo", name: "Repo" }], costs = null, extra,
  } = overrides;
  return vi.fn().mockImplementation((path, options) => {
    const s = String(path);
    if (extra) { const r = extra(s, options); if (r) return r; }
    if (s.includes("/needs-you")) return Promise.resolve({ ok: true, json: async () => needs });
    if (s.includes("/costs")) return Promise.resolve({ ok: true, json: async () => costs });
    if (s.includes("/overview")) return Promise.resolve({ ok: true, json: async () => overview });
    if (s.includes("/settings")) return Promise.resolve({ ok: true, json: async () => settings });
    if (s.includes("/projects")) return Promise.resolve({ ok: true, json: async () => projects });
    if (s.endsWith("/runs")) return Promise.resolve({ ok: true, json: async () => runs });
    if (s.endsWith("/tasks")) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => [] });
  });
}
const openControlCenter = () =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Control Center" }));

test("control center lists decisions and approves a review with a complete PATCH", async () => {
  const review = { id: "t1", title: "Paywall T3", status: "review", evidence: "33 tests green", projectPath: "C:/spy/sitelogs", assignedAgent: "codex" };
  const needs = {
    reviews: [review],
    inbox: [{ id: "i1", projectPath: "C:/spy/sitelogs", author: "codex", message: "PR open, awaiting merge" }],
    dispatcher: { enabled: false, projects: [], activeRuns: 0, lastTickAt: null },
  };
  const fetchMock = ccFetch({
    needs,
    projects: [{ projectPath: "C:/spy/sitelogs", name: "Sitelogs" }],
    extra: (s, options) => {
      if (s.includes("/tasks/t1") && options?.method === "PATCH") {
        needs.reviews = [];
        return Promise.resolve({ ok: true, json: async () => ({ ...review, status: "done" }) });
      }
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  expect(await screen.findByText("Paywall T3")).toBeInTheDocument();
  expect(screen.getByText("PR open, awaiting merge")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Approve Paywall T3" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve Paywall T3" })); // double-click: in-flight guard must dedupe
  await vi.waitFor(() => expect(screen.queryByText("Paywall T3")).not.toBeInTheDocument());
  const patches = fetchMock.mock.calls.filter(([url, opts]) => String(url).includes("/tasks/t1") && opts?.method === "PATCH");
  expect(patches).toHaveLength(1);
  expect(JSON.parse(patches[0][1].body)).toMatchObject({ action: "complete", agent: "human" });
});

test("control center reject flow blocks the task with the typed reason and date", async () => {
  const review = { id: "t1", title: "Paywall T3", status: "review", evidence: "33 tests green", projectPath: "C:/spy/sitelogs", assignedAgent: "codex" };
  const needs = { reviews: [review], inbox: [], dispatcher: { enabled: false, projects: [], activeRuns: 0, lastTickAt: null } };
  const fetchMock = ccFetch({
    needs,
    projects: [{ projectPath: "C:/spy/sitelogs", name: "Sitelogs" }],
    extra: (s, options) => {
      if (s.includes("/tasks/t1") && options?.method === "PATCH") {
        needs.reviews = [];
        return Promise.resolve({ ok: true, json: async () => ({ ...review, status: "blocked" }) });
      }
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();

  fireEvent.click(await screen.findByRole("button", { name: "Reject Paywall T3" }));
  const confirmButton = screen.getByRole("button", { name: "Confirm reject" });
  expect(confirmButton).toBeDisabled(); // no reason typed yet
  fireEvent.change(screen.getByLabelText("Reject reason"), { target: { value: "needs more evidence" } });
  fireEvent.change(screen.getByLabelText("Recheck date"), { target: { value: "2026-08-01" } });
  expect(confirmButton).toBeEnabled();
  const needsBefore = fetchMock.mock.calls.filter(([url]) => String(url).includes("/needs-you")).length;
  fireEvent.click(confirmButton);

  await vi.waitFor(() => expect(screen.queryByText("Paywall T3")).not.toBeInTheDocument());
  const patch = fetchMock.mock.calls.find(([url, opts]) => String(url).includes("/tasks/t1") && opts?.method === "PATCH");
  expect(JSON.parse(patch[1].body)).toMatchObject({ action: "block", agent: "human", reason: "needs more evidence", recheckAt: "2026-08-01" });
  const needsAfter = fetchMock.mock.calls.filter(([url]) => String(url).includes("/needs-you")).length;
  expect(needsAfter).toBe(needsBefore + 1); // refetch after the block
});

test("control center surfaces a Memory Guard block with reason, matched memory, and actions", async () => {
  const guardTask = {
    id: "g1", title: "Rework migration order", status: "blocked", projectPath: "C:/repo", assignedAgent: "claude-code",
    blockReason: "Memory Guard [block]: conflicts with a durable lesson",
    guard: {
      kind: "block", reason: "conflicts with a durable lesson about migration order",
      memories: [{ id: "m1", recordType: "fix", title: "Preserve storage migration order", excerpt: "Fixed schema corruption by keeping order" }],
    },
  };
  const needs = { reviews: [], inbox: [], guard: [guardTask], dispatcher: { enabled: false, projects: [], activeRuns: 0, lastTickAt: null } };
  const fetchMock = ccFetch({
    needs,
    extra: (s, options) => {
      if (s.includes("/tasks/g1") && options?.method === "PATCH") {
        needs.guard = [];
        return Promise.resolve({ ok: true, json: async () => ({ ...guardTask, status: "ready" }) });
      }
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();

  const card = within(await screen.findByRole("region", { name: "Memory Guard" }));
  expect(card.getByText("Rework migration order")).toBeInTheDocument();
  expect(card.getByText("BLOCK")).toBeInTheDocument();
  expect(card.getByText(/conflicts with a durable lesson about migration order/)).toBeInTheDocument();
  // matched memory context is shown so the human sees what the guard saw
  expect(card.getByText("Preserve storage migration order")).toBeInTheDocument();
  // all four actions are available
  for (const name of ["Approve Rework migration order", "Edit Rework migration order", "Retry Rework migration order", "Leave Rework migration order blocked"]) {
    expect(card.getByRole("button", { name })).toBeInTheDocument();
  }

  fireEvent.click(card.getByRole("button", { name: "Retry Rework migration order" }));
  await vi.waitFor(() => expect(screen.queryByText("Rework migration order")).not.toBeInTheDocument());
  const patch = fetchMock.mock.calls.find(([u, o]) => String(u).includes("/tasks/g1") && o?.method === "PATCH");
  expect(JSON.parse(patch[1].body)).toMatchObject({ action: "edit", status: "ready", agent: "human" });
});

test("control center resolves an inbox note", async () => {
  const needs = {
    reviews: [], inbox: [{ id: "i1", projectPath: "C:/repo", author: "codex", message: "PR open, awaiting merge" }],
    dispatcher: { enabled: false, projects: [], activeRuns: 0, lastTickAt: null },
  };
  const fetchMock = ccFetch({
    needs,
    extra: (s, options) => {
      if (s.includes("/inbox/i1") && options?.method === "PATCH") {
        needs.inbox = [];
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  fireEvent.click(await screen.findByRole("button", { name: "Resolve inbox item from codex" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/inbox/i1", expect.objectContaining({ method: "PATCH" })));
  const patch = fetchMock.mock.calls.find(([u, o]) => String(u).includes("/inbox/i1") && o?.method === "PATCH");
  expect(JSON.parse(patch[1].body)).toMatchObject({ agent: "human", action: "resolve", projectPath: "C:/repo" });
});

test("control center renders markdown evidence as formatted elements, not literal syntax", async () => {
  const review = { id: "t1", title: "Price-drop", status: "review", assignedAgent: "claude-code", projectPath: "C:/spy/marketplace",
    evidence: "**What shipped**\n- `src/price-drop.ts` — recordAndDetectDrops()\n- `src/alerts.ts` — processAlerts()" };
  const fetchMock = ccFetch({
    needs: { reviews: [review], inbox: [], dispatcher: { enabled: false, projects: [], activeRuns: 0, lastTickAt: null } },
    projects: [{ projectPath: "C:/spy/marketplace", name: "Marketplace" }],
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  // "**What shipped**" must render as bold "What shipped", never the literal asterisks
  const bold = await screen.findByText("What shipped");
  expect(bold.tagName).toBe("STRONG");
  expect(screen.queryByText(/\*\*What shipped\*\*/)).not.toBeInTheDocument();
  const code = screen.getByText("src/price-drop.ts");
  expect(code.tagName).toBe("CODE");
});

test("control center emergency stop pauses the dispatcher and flips the armed pill", async () => {
  const needs = { reviews: [], inbox: [], dispatcher: { enabled: true, projects: ["C:/repo"], activeRuns: 0, lastTickAt: new Date().toISOString() } };
  const fetchMock = ccFetch({
    needs,
    extra: (s, options) => {
      if (s.endsWith("/dispatcher") && options?.method === "POST") {
        needs.dispatcher = { ...needs.dispatcher, enabled: false };
        return Promise.resolve({ ok: true, json: async () => needs.dispatcher });
      }
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  expect(await screen.findByText("Autopilot armed")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /EMERGENCY STOP/ }));
  await screen.findByText("Autopilot paused");
  const post = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/dispatcher") && o?.method === "POST");
  expect(JSON.parse(post[1].body)).toMatchObject({ agent: "human", enabled: false });
});

test("control center enrolls a project by POSTing the full updated projects array", async () => {
  const needs = { reviews: [], inbox: [], dispatcher: { enabled: true, projects: [], activeRuns: 0, lastTickAt: new Date().toISOString() } };
  const fetchMock = ccFetch({
    needs,
    projects: [{ projectPath: "C:/repo", name: "Repo" }, { projectPath: "C:/other", name: "Other" }],
    extra: (s, options) => {
      if (s.endsWith("/dispatcher") && options?.method === "POST") {
        needs.dispatcher = { ...needs.dispatcher, projects: JSON.parse(options.body).projects };
        return Promise.resolve({ ok: true, json: async () => needs.dispatcher });
      }
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  fireEvent.click(await screen.findByRole("button", { name: "Enroll Repo" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith("/dispatcher") && o?.method === "POST")).toBe(true));
  const post = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/dispatcher") && o?.method === "POST");
  expect(JSON.parse(post[1].body)).toMatchObject({ agent: "human", projects: ["C:/repo"] });
});

test("control center persists a capture-policy toggle via /settings", async () => {
  const fetchMock = ccFetch({
    settings: { "capturePolicy.durableFixes": true, "capturePolicy.researchNotes": true, "capturePolicy.decisions": true, "capturePolicy.genericChatter": false, "capturePolicy.signalThreshold": 60 },
    extra: (s, options) => {
      if (s.endsWith("/settings") && options?.method === "POST") return Promise.resolve({ ok: true, json: async () => JSON.parse(options.body) });
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  fireEvent.click(await screen.findByLabelText("Decisions"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith("/settings") && o?.method === "POST")).toBe(true));
  const post = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/settings") && o?.method === "POST");
  expect(JSON.parse(post[1].body)).toMatchObject({ agent: "human", key: "capturePolicy.decisions", value: false });
});

test("control center splits running and failed into their own cards; retry re-queues a failed task", async () => {
  const runs = [
    { id: "r1", taskId: "t-live", agent: "codex", startedAt: new Date().toISOString(), endedAt: null, outcome: null, lastEvent: "Editing storage.js" },
    { id: "r2", taskId: "t-done", agent: "claude-code", startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: new Date().toISOString(), outcome: "success" },
    { id: "r3", taskId: "t-fail", agent: "codex", startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: new Date().toISOString(), outcome: "fail" },
  ];
  const tasks = [
    { id: "t-live", projectPath: "C:/repo", title: "Wire the dispatcher", status: "in_progress" },
    { id: "t-done", projectPath: "C:/repo", title: "Ship the parser", status: "review" },
    { id: "t-fail", projectPath: "C:/repo", title: "Broken migration", status: "blocked", assignedAgent: "codex", blockReason: "Agent exited with code 1" },
  ];
  const fetchMock = ccFetch({
    runs, tasks,
    extra: (s, options) => {
      if (s.includes("/tasks/t-fail") && options?.method === "PATCH") return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();

  const running = within(await screen.findByRole("region", { name: "Running agents" }));
  expect(running.getByText("Wire the dispatcher")).toBeInTheDocument();
  expect(running.getByText("RUNNING")).toBeInTheDocument();

  const failed = within(screen.getByRole("region", { name: "Failed runs" }));
  expect(failed.getByText("Broken migration")).toBeInTheDocument();
  expect(failed.getByText("FAILED")).toBeInTheDocument();

  // the finished/done run lands in the collapsible history, not the main column
  const history = within(screen.getByRole("region", { name: "Run history" }));
  expect(history.getByText("Ship the parser")).toBeInTheDocument();

  fireEvent.click(failed.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks/t-fail", expect.objectContaining({ method: "PATCH" })));
  const patch = fetchMock.mock.calls.find(([u, o]) => String(u).includes("/tasks/t-fail") && o?.method === "PATCH");
  expect(JSON.parse(patch[1].body)).toMatchObject({ action: "edit", status: "ready", agent: "human" });
});

test("control center view-log drawer tails a run's log; history exposes the same control", async () => {
  const runs = [
    { id: "r-live", taskId: "t-live", agent: "codex", startedAt: new Date().toISOString(), endedAt: null, outcome: null, lastEvent: "working" },
    { id: "r-old", taskId: "t-old", agent: "claude-code", startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: new Date().toISOString(), outcome: "fail" },
  ];
  const tasks = [
    { id: "t-live", projectPath: "C:/repo", title: "Wire the dispatcher", status: "in_progress" },
    { id: "t-old", projectPath: "C:/repo", title: "Night task", status: "blocked" },
  ];
  const fetchMock = ccFetch({
    runs, tasks,
    extra: (s) => {
      if (s.includes("/runs/r-live/log")) return Promise.resolve({ ok: true, json: async () => ({ runId: "r-live", missing: false, lines: ["first line of log", "very last line of log"] }) });
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();

  const running = within(await screen.findByRole("region", { name: "Running agents" }));
  fireEvent.click(running.getByRole("button", { name: "View log for Wire the dispatcher" }));
  const drawer = within(await screen.findByRole("dialog", { name: "Run log" }));
  expect(await drawer.findByText(/very last line of log/)).toBeInTheDocument();
  fireEvent.click(drawer.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Run log" })).not.toBeInTheDocument());

  // finished runs in the history archive expose the same control (inside collapsed <details>)
  const history = screen.getByRole("region", { name: "Run history" });
  expect(within(history).getByRole("button", { name: "View log for Night task", hidden: true })).toBeInTheDocument();
});

test("queued card annotates dependency and earliest-start gates", async () => {
  const tasks = [
    { id: "p", projectPath: "C:/repo", title: "Producer", status: "ready", priority: "normal", assignedAgent: "claude-code" },
    { id: "c", projectPath: "C:/repo", title: "Consumer", status: "ready", priority: "normal", assignedAgent: "claude-code", dependsOn: ["p"] },
  ];
  const fetchMock = ccFetch({ tasks, needs: { reviews: [], inbox: [], dispatcher: { enabled: true, projects: ["C:/repo"], activeRuns: 0, lastTickAt: null, window: null, windowOpen: true } } });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  const queue = within(await screen.findByRole("region", { name: "Queued to dispatch" }));
  expect(queue.getByText(/waiting on: Producer/)).toBeInTheDocument();
});

test("run history lists every finished run collapsibly, with no cap or toggle", async () => {
  const now = Date.now();
  const runs = [
    { id: "live", taskId: "t0", agent: "codex", startedAt: new Date(now).toISOString(), endedAt: null, outcome: null, lastEvent: "working" },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `h${i}`, taskId: `t${i + 1}`, agent: "claude-code",
      startedAt: new Date(now - (i + 2) * 60000).toISOString(),
      endedAt: new Date(now - (i + 1) * 60000).toISOString(), outcome: "success", notes: "done",
    })),
  ];
  const tasks = [{ id: "t0", projectPath: "C:/repo", title: "Live one", status: "in_progress" },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `t${i + 1}`, projectPath: "C:/repo", title: `History run ${i + 1}`, status: "review" }))];
  vi.stubGlobal("fetch", ccFetch({ runs, tasks }));
  render(<App />);
  openControlCenter();

  const running = within(await screen.findByRole("region", { name: "Running agents" }));
  expect(running.getByText("Live one")).toBeInTheDocument();

  // all ten finished runs live in history (collapsed <details> keep them in the DOM); no cap, no expander
  const history = within(screen.getByRole("region", { name: "Run history" }));
  expect(history.getByText("History run 1")).toBeInTheDocument();
  expect(history.getByText("History run 10")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /older runs/ })).not.toBeInTheDocument();
});

test("control center token-spend panel ranks cost by model, project, and type", async () => {
  const costs = {
    total: { costUsd: 2.85, tokens: 2722000, runs: 3 },
    byModel: [{ key: "opus", costUsd: 2.75, tokens: 2600000, runs: 2 }, { key: "sonnet", costUsd: 0.10, tokens: 122000, runs: 1 }],
    byProject: [{ key: "C:/repo", costUsd: 2.85, tokens: 2722000, runs: 3 }],
    byType: [{ key: "feature", costUsd: 2.0, tokens: 1900000, runs: 1 }, { key: "chore", costUsd: 0.85, tokens: 822000, runs: 2 }],
    byDay: [],
  };
  vi.stubGlobal("fetch", ccFetch({ costs }));
  render(<App />);
  openControlCenter();

  const spend = within((await screen.findByText("Token spend")).closest("details"));
  expect(spend.getByText("By model")).toBeInTheDocument();
  expect(spend.getByText("opus")).toBeInTheDocument();
  expect(spend.getByText("$2.75")).toBeInTheDocument();
  expect(spend.getByText("sonnet")).toBeInTheDocument();
  expect(spend.getByText("$0.10")).toBeInTheDocument();
  // project path resolves to its friendly name; task-type breakdown present
  expect(spend.getByText("Repo")).toBeInTheDocument();
  expect(spend.getByText("By task type")).toBeInTheDocument();
});

test("control center scheduler panel persists the run window", async () => {
  const fetchMock = ccFetch({ needs: { reviews: [], inbox: [], dispatcher: { enabled: false, projects: [], activeRuns: 0, lastTickAt: null, window: null, windowOpen: true } } });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  const panel = within((await screen.findByText("Scheduler")).closest("details"));
  fireEvent.click(panel.getByLabelText("Enable run window"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/dispatcher", expect.objectContaining({ method: "POST" })));
});

test("scheduler panel sets concurrency; a run shows its PR link", async () => {
  const runs = [{ id: "r1", taskId: "t1", agent: "claude-code", status: "running", startedAt: new Date().toISOString(), branch: "autopilot/t1", prUrl: "https://gh/pr/9" }];
  const fetchMock = ccFetch({ runs, needs: { reviews: [], inbox: [], dispatcher: { enabled: true, projects: ["C:/repo"], activeRuns: 1, lastTickAt: null, window: null, windowOpen: true, maxConcurrent: 1, maxPerProject: 1 } } });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  openControlCenter();
  const sched = within((await screen.findByText("Scheduler")).closest("details"));
  fireEvent.change(sched.getByLabelText("Max concurrent runs"), { target: { value: "3" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/dispatcher", expect.objectContaining({ method: "POST" })));
  const post = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/dispatcher") && o?.method === "POST");
  expect(JSON.parse(post[1].body)).toMatchObject({ maxConcurrent: 3 });
  // the running run surfaces its PR
  expect(screen.getByRole("link", { name: /PR/ })).toHaveAttribute("href", "https://gh/pr/9");
});

test("tasks: assigning an agent inline PATCHes edit, and the dispatch cue marks ready+assigned tasks", async () => {
  // ready + agent + no schedule => dispatchable (cue shown); ready + unassigned => not
  const tasks = [
    { id: "t-cue", projectPath: "C:/repo", title: "Dispatchable task", status: "ready", priority: "normal", assignedAgent: "codex" },
    { id: "t-plain", projectPath: "C:/repo", title: "Unassigned task", status: "ready", priority: "normal" },
  ];
  const fetchMock = vi.fn().mockImplementation((path, options) => {
    const s = String(path);
    if (s.includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/repo", name: "Repo" }] });
    if (s.endsWith("/tasks/t-plain") && options?.method === "PATCH") return Promise.resolve({ ok: true, json: async () => ({}) });
    if (s.endsWith("/runs")) return Promise.resolve({ ok: true, json: async () => [] });
    if (s.endsWith("/tasks")) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));

  // dispatch cue (inline ⚡) only on the ready + assigned task
  expect(await screen.findByLabelText("Dispatchable")).toBeInTheDocument();
  expect(screen.getAllByLabelText("Dispatchable")).toHaveLength(1);

  fireEvent.change(screen.getByLabelText("Assign agent for Unassigned task"), { target: { value: "claude-code" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks/t-plain", expect.objectContaining({ method: "PATCH" })));
  const patch = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/tasks/t-plain") && o?.method === "PATCH");
  expect(JSON.parse(patch[1].body)).toMatchObject({ agent: "human", action: "edit", assignedAgent: "claude-code" });
});

test("task editor sets a dependency and earliest-start via PATCH edit", async () => {
  const tasks = [
    { id: "p", projectPath: "C:/repo", title: "Producer", status: "ready", priority: "normal" },
    { id: "c", projectPath: "C:/repo", title: "Consumer", status: "ready", priority: "normal" },
  ];
  const fetchMock = vi.fn().mockImplementation((path, options) => {
    const s = String(path);
    if (s.includes("/projects")) return Promise.resolve({ ok: true, json: async () => [{ projectPath: "C:/repo", name: "Repo" }] });
    if (s.endsWith("/tasks/c") && options?.method === "PATCH") return Promise.resolve({ ok: true, json: async () => ({}) });
    if (s.endsWith("/tasks")) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Tasks" }));
  fireEvent.change(await screen.findByLabelText("Depends on for Consumer"), { target: { value: "p" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/tasks/c", expect.objectContaining({ method: "PATCH" })));
  const patch = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith("/tasks/c") && o?.method === "PATCH");
  expect(JSON.parse(patch[1].body)).toMatchObject({ action: "edit", dependsOn: ["p"] });
});

test("control center polls /needs-you on an interval and pauses when the tab is hidden", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = ccFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Control Center" }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/needs-you"))).toBe(true));

    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes("/needs-you")).length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/needs-you")).length).toBe(before + 1);

    // hidden tab => poll is skipped
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const afterOne = fetchMock.mock.calls.filter(([u]) => String(u).includes("/needs-you")).length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/needs-you")).length).toBe(afterOne);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  } finally {
    vi.useRealTimers();
  }
});

test("api sends stored bearer token", async () => {
  localStorage.setItem("cortex_token", "sekret");
  try {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api.js");
    await api("/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer sekret");
  } finally {
    localStorage.removeItem("cortex_token");
  }
});
