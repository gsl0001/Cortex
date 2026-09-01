import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import PortfolioDoctor from "./PortfolioDoctor.jsx";

afterEach(() => cleanup());

const report = {
  summary: {
    attention: 1, active: 0, unclassified: 2, missingContracts: 1,
    overdueRechecks: 1, verifiedRuns: 1, runs: 4,
  },
  rows: [
    {
      projectPath: "C:/work/app",
      name: "Shipping app",
      lifecycle: "unclassified",
      suggestedLifecycle: "waiting",
      lastActivityAt: "2026-07-30T00:00:00.000Z",
      lastVerifiedOutcome: { title: "Release check passed", at: "2026-07-29T00:00:00.000Z" },
      nextAction: { kind: "recheck", title: "Recheck: submit build" },
      tasks: { open: 2, evidenceContracts: 1 },
      runs: { total: 4, verified: 1 },
      issues: [
        { code: "overdue-recheck", severity: "blocker", message: "One is overdue." },
        { code: "lifecycle-unset", severity: "info", message: "Choose a state." },
      ],
    },
    {
      projectPath: "C:/work/quiet",
      name: "Quiet tool",
      lifecycle: "unclassified",
      suggestedLifecycle: "maintenance",
      lastActivityAt: null,
      lastVerifiedOutcome: null,
      nextAction: { kind: "goal", title: "Choose one measurable outcome" },
      tasks: { open: 0, evidenceContracts: 0 },
      runs: { total: 0, verified: 0 },
      issues: [{ code: "lifecycle-unset", severity: "info", message: "Choose a state." }],
    },
  ],
  identityIssues: [{ projectPath: "C:/Users/demo", sessions: 12 }],
};

test("portfolio doctor shows attention, proof, and applies a suggested lifecycle explicitly", async () => {
  let current = structuredClone(report);
  const fetchMock = vi.fn().mockImplementation((url, options = {}) => {
    const path = String(url);
    if (path.includes("/projects/lifecycle")) {
      const body = JSON.parse(options.body);
      current = {
        ...current,
        rows: current.rows.map((row) => row.projectPath === body.projectPath
          ? { ...row, lifecycle: body.state, suggestedLifecycle: body.state }
          : row),
      };
      return Promise.resolve({ ok: true, json: async () => ({ projectPath: body.projectPath, state: body.state }) });
    }
    if (path.includes("/portfolio/doctor")) {
      return Promise.resolve({ ok: true, json: async () => structuredClone(current) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PortfolioDoctor />);
  expect(await screen.findByRole("heading", { name: "Portfolio Doctor" })).toBeInTheDocument();
  expect(screen.getByText("Release check passed")).toBeInTheDocument();
  expect(screen.getByText("1/2 task proofs · 1/4 runs verified")).toBeInTheDocument();
  expect(screen.getByText("overdue recheck")).toBeInTheDocument();
  expect(screen.queryByText("Quiet tool")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Use waiting" }));
  await vi.waitFor(() => expect(screen.getByLabelText("Lifecycle for Shipping app")).toHaveValue("waiting"));
  const write = fetchMock.mock.calls.find(([url]) => String(url).includes("/projects/lifecycle"));
  expect(JSON.parse(write[1].body)).toEqual({ agent: "human", projectPath: "C:/work/app", state: "waiting" });

  fireEvent.change(screen.getByLabelText("Filter portfolio"), { target: { value: "all" } });
  expect(screen.getByText("Quiet tool")).toBeInTheDocument();
  fireEvent.click(screen.getByText("1 session path issue"));
  expect(within(screen.getByRole("list")).getByText("C:/Users/demo")).toBeInTheDocument();
});
