import test from "node:test";
import assert from "node:assert/strict";
import { withinWindow, notBeforeReached, compareTasks } from "../src/scheduler.js";

test("withinWindow handles day filter and midnight crossing", () => {
  const at = (iso) => new Date(iso);
  assert.equal(withinWindow(at("2026-07-09T23:00:00"), null), true); // null = always on
  const overnight = { start: "22:00", end: "07:00", days: [0,1,2,3,4,5,6] };
  assert.equal(withinWindow(at("2026-07-09T23:30:00"), overnight), true);
  assert.equal(withinWindow(at("2026-07-09T03:00:00"), overnight), true);  // after midnight
  assert.equal(withinWindow(at("2026-07-09T12:00:00"), overnight), false);
  const weekdays = { start: "09:00", end: "17:00", days: [1,2,3,4,5] };
  assert.equal(withinWindow(at("2026-07-11T10:00:00"), weekdays), false); // Sat (day 6)
});

test("an overnight window's after-midnight tail belongs to the day it started", () => {
  const at = (iso) => new Date(iso);
  // Fri 22:00 - 07:00, weeknights only: 2026-07-10 is a Friday, 07-11 a Saturday.
  const weeknights = { start: "22:00", end: "07:00", days: [1,2,3,4,5] };
  assert.equal(withinWindow(at("2026-07-10T23:00:00"), weeknights), true);  // Fri night
  assert.equal(withinWindow(at("2026-07-11T02:00:00"), weeknights), true);  // Sat 02:00 = Friday's tail
  assert.equal(withinWindow(at("2026-07-11T23:00:00"), weeknights), false); // Sat night: not enrolled
  assert.equal(withinWindow(at("2026-07-12T02:00:00"), weeknights), false); // Sun 02:00 = Saturday's tail
});

test("notBeforeReached and compareTasks ordering", () => {
  const now = new Date("2026-07-09T05:00:00");
  assert.equal(notBeforeReached({ notBefore: null }, now), true);
  assert.equal(notBeforeReached({ notBefore: "2026-07-09T06:00:00" }, now), false);
  const urgent = { priority: "urgent", scheduledFor: "2026-07-09", createdAt: "2026-07-01T00:00:00Z" };
  const normalEarly = { priority: "normal", scheduledFor: "2026-07-08", createdAt: "2026-07-01T00:00:00Z" };
  assert.ok(compareTasks(urgent, normalEarly) < 0);           // priority wins
  const a = { priority: "normal", scheduledFor: "2026-07-08", createdAt: "2026-07-02T00:00:00Z" };
  const b = { priority: "normal", scheduledFor: "2026-07-09", createdAt: "2026-07-01T00:00:00Z" };
  assert.ok(compareTasks(a, b) < 0);                          // earlier scheduled wins on equal priority
});
