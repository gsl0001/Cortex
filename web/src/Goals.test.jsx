import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import Goals from "./Goals.jsx";

afterEach(cleanup);

function filler(id, rank, health) {
  return {
    id, projectPath: `C:/${id}`, title: `Goal ${rank}`, outcome: `Outcome ${rank}`,
    targetDate: "2026-08-01", activeRank: rank, weeklyCapacity: 2, status: "active",
    progress: { done: 0, total: 2, percent: 0 }, deadlineHealth: health, stalled: false,
    eligibleForAchievement: false, nextTask: null, milestones: [], successCriteria: [],
  };
}

const portfolio = {
  nextAction: { id: "t-ready", title: "Run verification", projectPath: "C:/p1" },
  projects: [
    {
      id: "g1", projectPath: "C:/p1", title: "Ship result", outcome: "Verified result",
      targetDate: "2026-07-31", activeRank: 1, weeklyCapacity: 3, status: "active",
      progress: { done: 1, total: 3, percent: 33 }, deadlineHealth: "overdue", stalled: false,
      eligibleForAchievement: true,
      nextTask: { id: "t-ready", title: "Run verification" },
      milestones: [{ id: "m1", goalId: "g1", title: "Baseline", sortOrder: 1, dueDate: "2026-07-05" }],
      successCriteria: [{ id: "c1", text: "Verification passes", task_ids: ["t1"] }],
    },
    filler("p2", 2, "at_risk"),
    filler("p3", 3, "on_track"),
    filler("p4", 4, "on_track"),
    filler("p5", 5, "on_track"),
  ],
  attention: [{ kind: "blocked_task", taskId: "t-blocked", projectPath: "C:/p2", message: "waiting on adb" }],
  verifiedOutcomes: [{ id: "g0", title: "Old win", achievedAt: "2026-06-28T00:00:00.000Z" }],
};

const week = {
  weekStart: "2026-06-29", weekEnd: "2026-07-03", totalCapacity: 10,
  scheduled: [{ id: "t1", title: "Run verification", scheduledFor: "2026-06-29", projectPath: "C:/p1", status: "ready" }],
  unscheduled: [{ id: "t2", title: "Later task", projectPath: "C:/p1", status: "ready" }],
};

const roadmap = {
  goal: {
    id: "g1", projectPath: "C:/p1", title: "Ship result", outcome: "Verified result",
    targetDate: "2026-07-31", status: "active", weeklyCapacity: 3, activeRank: 1,
    successCriteria: [{ id: "c1", text: "Verification passes", task_ids: ["t1"] }],
  },
  milestones: [{ id: "m1", goalId: "g1", title: "Baseline", sortOrder: 1, dueDate: "2026-07-05" }],
  tasks: [{ id: "t1", milestoneId: "m1", taskNumber: "1.1", title: "Run verification", status: "ready", roadmapOrder: 1, scheduledFor: "2026-06-29" }],
};

const proposals = [{
  id: "prop1", projectPath: "C:/p1", createdBy: "codex", status: "pending",
  payload: {
    version: 1, goal: { title: "Refined goal" },
    milestones: [{ key: "m1", title: "Baseline", order: 1, dueDate: "2026-07-05" }],
    tasks: [
      { key: "t1", action: "create", number: "1.1", title: "New task" },
      { key: "t2", action: "link", number: "1.2", taskId: "existing" },
      { key: "t3", action: "update", number: "1.3", taskId: "existing2" },
    ],
  },
}];

const res = (body, ok = true) => Promise.resolve({ ok, json: async () => body });

function mockApi(opts = {}) {
  const {
    portfolioBody = portfolio, portfolioOk = true, weekOk = true,
    proposalsBody = proposals, autoPlanOk = true, autoPlanError = "capacity exhausted",
    approveOk = true, approveError = "proposal is stale",
  } = opts;
  return vi.fn().mockImplementation((url, options) => {
    const u = String(url);
    const method = options?.method || "GET";
    if (method === "GET") {
      if (u.includes("/roadmap-proposals")) return res(proposalsBody);
      if (u.includes("/roadmaps")) return res(roadmap);
      if (u.includes("/goals")) return res(portfolioOk ? portfolioBody : { error: { message: "goals down" } }, portfolioOk);
      if (u.includes("/weeks")) return res(weekOk ? week : { error: { message: "week down" } }, weekOk);
      return res([]);
    }
    if (u.includes("/weeks/auto-plan")) return res(autoPlanOk ? week : { error: { message: autoPlanError } }, autoPlanOk);
    if (u.includes("/roadmap-proposals/")) return res(approveOk ? { id: "prop1", status: "approved" } : { error: { message: approveError } }, approveOk);
    if (u.includes("/goals/")) return res({ id: "g1", status: "paused" });
    if (u.includes("/inbox")) return res({ id: "inbox1" });
    if (u.includes("/tasks/")) return res({ id: "t1", scheduledFor: "2026-06-30" });
    return res({});
  });
}

test("portfolio shows the next action, five goal cards, overdue badge, and blocked attention", async () => {
  vi.stubGlobal("fetch", mockApi());
  render(<Goals />);
  expect(await screen.findByRole("heading", { name: "Goals" })).toBeInTheDocument();
  expect(screen.getByText("Highest-value next action")).toBeInTheDocument();
  expect(await screen.findAllByTestId("project-goal-card")).toHaveLength(5);
  expect(screen.getByText("Run verification")).toBeInTheDocument();
  expect(screen.getByText("Overdue")).toBeInTheDocument();
  expect(screen.getByText("waiting on adb")).toBeInTheDocument();
});

test("weekly tab shows weekdays, scheduled work, and the auto-plan button", async () => {
  vi.stubGlobal("fetch", mockApi());
  render(<Goals />);
  fireEvent.click(await screen.findByRole("tab", { name: "This week" }));
  expect(await screen.findByText("Monday")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Auto-plan week" })).toBeInTheDocument();
  expect(screen.getByText("Later task")).toBeInTheDocument();
});

test("arrow keys move between tabs", async () => {
  vi.stubGlobal("fetch", mockApi());
  render(<Goals />);
  const portfolioTab = await screen.findByRole("tab", { name: "Portfolio" });
  fireEvent.keyDown(portfolioTab, { key: "ArrowRight" });
  expect(await screen.findByText("Monday")).toBeInTheDocument();
});

test("auto-plan announces success", async () => {
  vi.stubGlobal("fetch", mockApi());
  render(<Goals />);
  fireEvent.click(await screen.findByRole("tab", { name: "This week" }));
  fireEvent.click(await screen.findByRole("button", { name: "Auto-plan week" }));
  expect(await screen.findByText("Week re-planned")).toBeInTheDocument();
});

test("auto-plan failure is announced", async () => {
  vi.stubGlobal("fetch", mockApi({ autoPlanOk: false }));
  render(<Goals />);
  fireEvent.click(await screen.findByRole("tab", { name: "This week" }));
  fireEvent.click(await screen.findByRole("button", { name: "Auto-plan week" }));
  expect((await screen.findAllByText("capacity exhausted")).length).toBeGreaterThan(0);
});

test("empty portfolio guides the user", async () => {
  vi.stubGlobal("fetch", mockApi({ portfolioBody: { nextAction: null, projects: [], attention: [], verifiedOutcomes: [] } }));
  render(<Goals />);
  expect(await screen.findByText(/No active goals/)).toBeInTheDocument();
  expect(screen.queryAllByTestId("project-goal-card")).toHaveLength(0);
});

test("a failed portfolio panel does not block the weekly tab", async () => {
  vi.stubGlobal("fetch", mockApi({ portfolioOk: false }));
  render(<Goals />);
  expect(await screen.findByText("goals down")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "This week" }));
  expect(await screen.findByText("Monday")).toBeInTheDocument();
});

test("opening a project shows goal, deadlines, numbered tasks, health, and recovery actions", async () => {
  vi.stubGlobal("fetch", mockApi());
  render(<Goals />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Ship result" }));
  expect(await screen.findByText("Verified result")).toBeInTheDocument();
  expect(screen.getByText("2026-07-31")).toBeInTheDocument();
  expect(screen.getByText("due 2026-07-05")).toBeInTheDocument();
  expect(screen.getByText("1.1")).toBeInTheDocument();
  expect(screen.getByText("Overdue")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm achieved" })).toBeInTheDocument();
  for (const name of ["Pause", "Abandon", "Recover", "Re-plan"]) {
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  }
});

test("proposal dialog lists Add/Link/Update and Escape restores trigger focus", async () => {
  vi.stubGlobal("fetch", mockApi());
  render(<Goals />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Ship result" }));
  const trigger = await screen.findByRole("button", { name: "Review proposal" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Add")).toBeInTheDocument();
  expect(within(dialog).getByText("Link")).toBeInTheDocument();
  expect(within(dialog).getByText("Update")).toBeInTheDocument();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(trigger);
});

test("rejection requires a reason; approval error keeps the dialog open", async () => {
  vi.stubGlobal("fetch", mockApi({ approveOk: false }));
  render(<Goals />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Ship result" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review proposal" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "Reject" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Approve roadmap" }));
  expect(await within(dialog).findByText("proposal is stale")).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("pausing a goal announces and returns to the portfolio", async () => {
  vi.stubGlobal("fetch", mockApi());
  render(<Goals />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Ship result" }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  expect(await screen.findByText("Goal paused")).toBeInTheDocument();
});
