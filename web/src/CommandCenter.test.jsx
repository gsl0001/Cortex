import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import CommandCenter, { attentionItems, pulseDays } from "./CommandCenter.jsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function response(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body });
}

function mockPanels(overrides = {}) {
  const data = {
    stats: {
      records: { fix: 12, research: 2 }, captureTotal: 4,
      tokensPerDistinctCitation: 6435, recallCitedBriefSourced: 21, recallPulledCount: 3,
    },
    tasks: [{ id: "task-1", title: "Fix gate", status: "blocked", blockReason: "one test fails" }],
    inbox: [{ id: "inbox-1", message: "Clarify retention" }],
    activity: [],
    health: { ok: true, local: true },
    audit: { issues: [] },
    ...overrides,
  };
  const fetchMock = vi.fn((path) => {
    const key = Object.keys(data).find((name) => String(path).includes(`/${name}`));
    const value = data[key] ?? [];
    return value instanceof Error ? response({ error: { message: value.message } }, false) : response(value);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("groups repeated audit findings into one action", () => {
  const actions = attentionItems({
    audit: [
      { id: "a", code: "missing_evidence", message: "Fix has no verification evidence." },
      { id: "b", code: "missing_evidence", message: "Fix has no verification evidence." },
    ],
  });

  expect(actions).toHaveLength(1);
  expect(actions[0].item.count).toBe(2);
});

test("ranks inbox items and blocked tasks", async () => {
  mockPanels();
  render(<CommandCenter projectPath="C:/demo" onNavigate={vi.fn()} />);

  const queue = await screen.findByRole("region", { name: "Needs your attention" });
  expect(within(queue).getByText("Resolve human inbox item")).toBeInTheDocument();
  expect(within(queue).getByText("Fix gate")).toBeInTheDocument();
  expect(screen.getByText("12")).toBeInTheDocument();
});

test("shows recall economics with the over-ceiling state flagged", async () => {
  mockPanels();
  render(<CommandCenter projectPath="C:/demo" onNavigate={vi.fn()} />);

  const cost = await screen.findByText("6,435");
  expect(cost.closest("article")).toHaveClass("metric-attention"); // over the 5,000 ceiling
  expect(screen.getByText("Brief-sourced cites")).toBeInTheDocument();
  expect(screen.getByText("Stub pulls")).toBeInTheDocument();
  expect(screen.getByText("3")).toBeInTheDocument();
});

test("keeps useful panels visible when activity fails", async () => {
  mockPanels({ activity: new Error("activity unavailable") });
  render(<CommandCenter projectPath="C:/demo" onNavigate={vi.fn()} />);

  expect(await screen.findByText("12")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("activity unavailable");
  expect(screen.getByRole("button", { name: "Retry activity" })).toBeInTheDocument();
});

test("opens an action drawer and returns focus on Escape", async () => {
  mockPanels();
  render(<CommandCenter projectPath="C:/demo" onNavigate={vi.fn()} />);

  const review = await screen.findByRole("button", { name: "Resolve human inbox item" });
  review.focus();
  fireEvent.click(review);
  const dialog = screen.getByRole("dialog", { name: "Resolve human inbox item" });
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(review).toHaveFocus();
});

test("resolves a human inbox item from its drawer", async () => {
  const fetchMock = mockPanels();
  render(<CommandCenter projectPath="C:/demo" onNavigate={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Resolve human inbox item" }));
  fireEvent.click(screen.getByRole("button", { name: "Resolve inbox item" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/inbox/inbox-1",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ agent: "human", projectPath: "C:/demo", action: "resolve" }),
    }),
  ));
});

test("moves a blocked task to review from its drawer", async () => {
  const fetchMock = mockPanels();
  render(<CommandCenter projectPath="C:/demo" onNavigate={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Fix gate" }));
  fireEvent.click(screen.getByRole("button", { name: "Move task to review" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/tasks/task-1",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ agent: "human", action: "review" }),
    }),
  ));
});

test("pulseDays buckets activity into 14 days by type, ignoring older rows", () => {
  const now = Date.parse("2026-07-02T12:00:00Z");
  const days = pulseDays([
    { ts: "2026-07-02T09:00:00Z", type: "fix" },
    { ts: "2026-07-02T10:00:00Z", type: "fix" },
    { ts: "2026-07-01T10:00:00Z", type: "decision" },
    { ts: "2026-05-01T10:00:00Z", type: "fix" }, // older than the window
  ], now);

  expect(days).toHaveLength(14);
  expect(days[13].byType.fix).toBe(2);
  expect(days[12].byType.decision).toBe(1);
  expect(days.reduce((sum, day) => sum + day.total, 0)).toBe(3);
});

test("shows a project portfolio card with task progress", async () => {
  mockPanels({
    tasks: [
      { id: "t1", title: "Done thing", status: "done", projectPath: "C:/demo" },
      { id: "t2", title: "Open thing", status: "ready", projectPath: "C:/demo" },
    ],
  });
  render(<CommandCenter projectPath="C:/demo" projects={[{ projectPath: "C:/demo", name: "Demo" }]} onNavigate={vi.fn()} />);

  const portfolio = await screen.findByRole("region", { name: "Projects" });
  expect(within(portfolio).getByText("Demo")).toBeInTheDocument();
  expect(within(portfolio).getByText(/1 of 2 tasks done/)).toBeInTheDocument();
});

test("memory pulse renders a clickable day that opens the activity log", async () => {
  const onNavigate = vi.fn();
  mockPanels({ activity: [{ id: "e1", type: "fix", ts: new Date().toISOString(), title: "Fixed a thing", project: "C:/demo" }] });
  render(<CommandCenter projectPath="C:/demo" projects={[]} onNavigate={onNavigate} />);

  const pulse = await screen.findByRole("region", { name: /Memory pulse/ });
  expect(within(pulse).getByText(/1 memories captured|1 memor/)).toBeInTheDocument();
  fireEvent.click(within(pulse).getAllByRole("button", { name: /event/ })[0]);
  expect(onNavigate).toHaveBeenCalledWith("Activity log");
});
