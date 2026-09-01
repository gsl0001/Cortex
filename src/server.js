import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { localToday, normalizeProjectPath } from "./storage.js";
import { createNotifier } from "./notify.js";
import { runNextDistillJob } from "./distill.js";
import { portfolioStalls } from "./planning.js";
import { projectLifecycle } from "./portfolio.js";
import { TIERS, isPinnedWatch, projectTier, setProjectTier } from "./tiers.js";

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Memory governance records its verdict as a sentinel-prefixed block reason (hard block) or
// review evidence (soft warn), e.g. "Memory Guard [block]: touches a fragile file". One shared
// string format lets the deterministic Memory Guard write verdicts and this surfacing layer read
// them back — no schema migration, and plain-text consumers (brief, CLI) still print something
// readable. The matched memory context isn't stored: it's recalled live from the memory store.
const GUARD_RE = /^Memory Guard \[(block|warn)\]:\s*([\s\S]*)$/;
export function parseGuardVerdict(text) {
  const match = GUARD_RE.exec(String(text || "").trim());
  return match ? { kind: match[1], reason: match[2].trim() } : null;
}

function fail(message, code = "invalid_request") {
  const error = new Error(message);
  error.httpCode = code;
  return error;
}

// Config the Control Center persists. These are NOT yet consumed by the capture
// pipeline (capturePolicy.js still owns real capture decisions) — they're stored
// so the dashboard's toggles/sliders survive a reload. Fixed booleans + the signal
// threshold, plus any dynamic tokenBudget.<projectPath> number.
const SETTINGS_DEFAULTS = {
  "capturePolicy.durableFixes": true,
  "capturePolicy.researchNotes": true,
  "capturePolicy.decisions": true,
  "capturePolicy.genericChatter": false,
  "capturePolicy.signalThreshold": 60,
};
const settingKeyAllowed = (key) =>
  Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)
  || String(key).startsWith("tokenBudget.");

function authOk(request) {
  const token = process.env.CORTEX_TOKEN || "";
  if (!token) return false; // default-deny: no configured token means no authenticated callers exist
  const provided = Buffer.from(request.headers["authorization"] || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJson(request) {
  const contentType = (request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw fail("content-type must be application/json");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length; // chunk is a Buffer -> byte length, not UTF-16 string length
    if (bytes > 64_000) {
      // the for-await loop stops here, leaving unread bytes still in flight on the socket.
      // On a kept-alive connection those leftover bytes desync the NEXT request's parsing.
      // Marked so the caller closes the connection after this response instead of reusing
      // the socket — destroying it here would also kill this response before it's sent.
      const error = fail("Request body is too large");
      error.closeConnection = true;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw fail("Malformed JSON body");
  }
}

export function createCortexServer({ hub, notifier = createNotifier(), host = "127.0.0.1", port = 0, allowRemote = false, staticDir = resolve("web/dist") } = {}) {
  if (!allowRemote && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Cortex server requires a loopback host unless allowRemote is explicit");
  }
  if (allowRemote && !(process.env.CORTEX_TOKEN || "")) {
    throw new Error("allowRemote requires CORTEX_TOKEN to be set");
  }
  const resolvedStaticDir = resolve(staticDir);
  const indexPath = join(resolvedStaticDir, "index.html");

  function recordRejected(projectPath, reason, pathname, agent) {
    try { hub.storage.recordMetric("write_rejected", projectPath || process.cwd(), { agent, reason, path: pathname }); } catch { /* observability is best-effort */ }
  }

  // Each handler receives the validated body (agent guaranteed non-empty) and returns { status, body }.
  async function handleWrite(httpMethod, pathname, body) {
    if (httpMethod === "DELETE" && pathname.startsWith("/api/v1/tasks/")) {
      const id = decodeURIComponent(pathname.slice("/api/v1/tasks/".length));
      if (!id) throw fail("task id is required");
      return { status: 200, body: hub.deleteTask({ id, agent: body.agent }) };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/capture") {
      // policy-only: knowledge records must pass dedup/supersede/chatter-discard, never raw insert
      return { status: 201, body: hub.captureCandidate(body) };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/tasks") {
      return { status: 201, body: hub.addTask(body) }; // addTask requires title -> throws -> 400
    }
    if (httpMethod === "PATCH" && pathname.startsWith("/api/v1/tasks/")) {
      const id = decodeURIComponent(pathname.slice("/api/v1/tasks/".length));
      if (!id) throw fail("task id is required");
      // scheduling is roadmap planning metadata, not a status transition -> handle before the transition map
      if (body.action === "schedule") return { status: 200, body: hub.scheduleTask({ id, scheduledFor: body.scheduledFor }) };
      const transitions = { claim: "claimTask", block: "blockTask", review: "reviewTask", complete: "completeTask", edit: "editTask" };
      const transition = transitions[body.action];
      if (!transition) throw fail("action must be one of claim|block|review|complete|edit");
      // routes through the transition methods directly so required side-fields stay enforced
      // (claim->agent, block->reason, complete->evidence). NOT taskUpdater, which defaults them away.
      return { status: 200, body: hub[transition]({ ...body, id }) };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/links") {
      if (!body.fromEntityId || !body.toEntityId || !body.linkType) throw fail("fromEntityId, toEntityId, and linkType are required");
      if (typeof body.fromEntityId !== "string" || typeof body.toEntityId !== "string") {
        throw fail("fromEntityId and toEntityId must be strings");
      }
      const same = body.fromEntityId === body.toEntityId;
      const entityCount = hub.storage.db.prepare("SELECT COUNT(*) AS count FROM entities WHERE id IN (?, ?)").get(body.fromEntityId, body.toEntityId).count;
      if (entityCount !== (same ? 1 : 2)) throw fail("Both link entities must exist");
      const link = hub.storage.linkRecords({ fromEntityId: body.fromEntityId, toEntityId: body.toEntityId, linkType: body.linkType, source: "manual", confidence: 1 });
      // agent provenance lives in metrics (links table has no agent column)
      const project = hub.storage.db.prepare("SELECT project_path AS p FROM entities WHERE id = ?").get(body.fromEntityId)?.p;
      try { hub.storage.recordMetric("link_created", project || process.cwd(), { agent: body.agent, linkType: body.linkType }); } catch { /* best-effort */ }
      return { status: 201, body: link };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/projects") {
      if (!String(body.projectPath || "").trim()) throw fail("projectPath is required");
      return { status: 200, body: hub.upsertProjectProfile(body) }; // requires name + mode -> throws -> 400
    }
    if (httpMethod === "POST" && pathname === "/api/v1/projects/lifecycle") {
      return { status: 200, body: hub.setProjectLifecycle(body) };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/projects/tier") {
      // Autonomy tier per project (watch|plan|assist|auto). Takes one {projectPath, tier} or a
      // batch {projects:[{projectPath, tier}]}, and rejects PER ITEM: the Control screen sends
      // its whole selection, and a validation throw used to 400 the entire batch (15 failed
      // enrollments in live data). A request where nothing landed is still a 4xx, so a lone
      // pinned repo gets a clear error instead of a silent success.
      const items = body.projects !== undefined ? body.projects : [{ projectPath: body.projectPath, tier: body.tier }];
      if (!Array.isArray(items) || items.length === 0) {
        throw fail(`projects must be a non-empty array of {projectPath, tier} — tier is one of ${TIERS.join("|")}`);
      }
      const updated = [];
      const rejected = [];
      for (const item of items) {
        const raw = String(item?.projectPath || "").trim();
        if (!raw) { rejected.push({ projectPath: item?.projectPath ?? null, reason: "projectPath is required" }); continue; }
        // normalize BEFORE the pin check: "C:/work/master/" is not the pinned key, "C:/work/master" is
        const projectPath = normalizeProjectPath(raw);
        try {
          updated.push({ projectPath, tier: setProjectTier(hub.storage, projectPath, item?.tier) });
        } catch (error) {
          rejected.push({ projectPath, reason: error.message });
        }
      }
      if (!updated.length) throw fail(rejected[0]?.reason || "no project tiers were set");
      return { status: 200, body: { updated, rejected } };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/lessons") {
      // explicit agent-authored lesson: direct insert (like inbox), not gated capture
      if (!String(body.projectPath || "").trim()) throw fail("projectPath is required");
      const lesson = hub.addLesson({ projectPath: body.projectPath, lesson: body.lesson });
      try { hub.storage.recordMetric("lesson_added", body.projectPath, { agent: body.agent, statement: String(body.lesson).slice(0, 120) }); } catch { /* best-effort */ }
      return { status: 201, body: { action: "accepted", ...lesson } };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/inbox") {
      // human note: direct insert (NOT gated capture); agent field = author
      if (!String(body.message || "").trim()) throw fail("message is required");
      if (!String(body.projectPath || "").trim()) throw fail("projectPath is required");
      return { status: 201, body: hub.addInboxItem({ projectPath: body.projectPath, author: body.agent, message: body.message }) };
    }
    if (httpMethod === "PATCH" && pathname.startsWith("/api/v1/inbox/")) {
      const id = decodeURIComponent(pathname.slice("/api/v1/inbox/".length));
      if (!id) throw fail("inbox id is required");
      if (body.action !== "resolve") throw fail("action must be resolve");
      if (!String(body.projectPath || "").trim()) throw fail("projectPath is required");
      return { status: 200, body: hub.resolveInbox({ projectPath: body.projectPath, id }) }; // not-found -> 404
    }
    if (httpMethod === "POST" && pathname === "/api/v1/roadmap-proposals") {
      return { status: 201, body: hub.createRoadmapProposal({ projectPath: body.projectPath, agent: body.agent, payload: body.payload }) };
    }
    if (httpMethod === "PATCH" && pathname.startsWith("/api/v1/roadmap-proposals/")) {
      const id = decodeURIComponent(pathname.slice("/api/v1/roadmap-proposals/".length));
      if (!id) throw fail("proposal id is required");
      if (body.action === "approve") return { status: 200, body: hub.approveRoadmapProposal({ id, agent: body.agent }) };
      if (body.action === "reject") return { status: 200, body: hub.rejectRoadmapProposal({ id, agent: body.agent, reason: body.reason }) };
      throw fail("action must be approve|reject");
    }
    if (httpMethod === "PATCH" && pathname.startsWith("/api/v1/goals/")) {
      const id = decodeURIComponent(pathname.slice("/api/v1/goals/".length));
      if (!id) throw fail("goal id is required");
      if (body.action === "achieve") return { status: 200, body: hub.confirmGoalAchieved({ id }) };
      if (body.action === "update") {
        return { status: 200, body: hub.updateGoal({ id, status: body.status, activeRank: body.activeRank, targetDate: body.targetDate, weeklyCapacity: body.weeklyCapacity }) };
      }
      throw fail("action must be update|achieve");
    }
    if (httpMethod === "PATCH" && pathname.startsWith("/api/v1/milestones/")) {
      const id = decodeURIComponent(pathname.slice("/api/v1/milestones/".length));
      if (!id) throw fail("milestone id is required");
      return { status: 200, body: hub.updateMilestone({ id, title: body.title, sortOrder: body.sortOrder, dueDate: body.dueDate }) };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/weeks/auto-plan") {
      return { status: 200, body: hub.autoPlanWeeklyTasks({ weekStart: body.weekStart, totalCapacity: body.totalCapacity, agent: body.agent }) };
    }
    if (httpMethod === "POST" && pathname === "/api/v1/settings") {
      const { key, value } = body;
      if (typeof key !== "string" || !settingKeyAllowed(key)) throw fail("key is not an allowed setting");
      hub.storage.setSetting(key, value);
      return { status: 200, body: { key, value } };
    }
    throw fail("Route not found", "not_found");
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      // Fail-closed for proxied requests. `tailscale serve` proxies to loopback (so the
      // allowRemote guard never fires) and always adds x-forwarded-for; direct local
      // clients don't. Static files and /api/v1/health stay open so a phone can load the
      // SPA (api.js's 401 prompt then collects the token) and see a clear state.
      // Require auth on reads too whenever the hub is reachable beyond loopback —
      // either proxied (x-forwarded-for) or bound to a public interface (allowRemote).
      // Otherwise a direct LAN client (no x-forwarded-for) could read all memory,
      // project paths, and raw run logs with no token. Loopback-only stays open.
      const proxied = Boolean(request.headers["x-forwarded-for"]);
      if ((proxied || allowRemote) && url.pathname.startsWith("/api/") && url.pathname !== "/api/v1/health") {
        const token = process.env.CORTEX_TOKEN || "";
        if (!token) {
          recordRejected(process.cwd(), "proxy_no_token", url.pathname);
          return json(response, 401, { error: { code: "unauthorized", message: "CORTEX_TOKEN must be set before exposing the hub beyond loopback" } });
        }
        if (!authOk(request)) {
          recordRejected(process.cwd(), "unauthorized", url.pathname);
          return json(response, 401, { error: { code: "unauthorized", message: "Valid bearer token required" } });
        }
      }
      const isWrite = request.method === "POST" || request.method === "PATCH" || request.method === "DELETE";
      if (isWrite) {
        // default-deny even on loopback: an unset token silently drops every capture
        // (clients don't fall back on HTTP rejection), so name the fix in the message
        if (!(process.env.CORTEX_TOKEN || "")) {
          recordRejected(process.cwd(), "no_token", url.pathname);
          return json(response, 401, { error: { code: "unauthorized", message: "Writes are disabled until CORTEX_TOKEN is set on the server — see SETUP.md" } });
        }
        if (!authOk(request)) {
          recordRejected(process.cwd(), "unauthorized", url.pathname);
          return json(response, 401, { error: { code: "unauthorized", message: "Valid bearer token required" } });
        }
        let body;
        try { body = await readJson(request); }
        catch (error) {
          if (error.closeConnection) response.setHeader("Connection", "close");
          return json(response, 400, { error: { code: error.httpCode || "invalid_request", message: error.message } });
        }
        if (!String(body.agent || "").trim()) {
          recordRejected(body.projectPath, "missing_agent", url.pathname);
          return json(response, 400, { error: { code: "invalid_request", message: "agent is required" } });
        }
        try {
          const { status, body: out } = await handleWrite(request.method, url.pathname, body);
          return json(response, status, out);
        } catch (error) {
          const message = error.message || "Write failed";
          const status = error.httpCode === "not_found" || /not found/i.test(message) ? 404 : 400;
          recordRejected(body.projectPath, message, url.pathname, body.agent);
          return json(response, status, { error: { code: status === 404 ? "not_found" : "invalid_request", message } });
        }
      }

      if (request.method !== "GET") return json(response, 405, { error: { code: "method_not_allowed", message: "Method not supported." } });
      return await handleRead(url, response);
    } catch (error) {
      return json(response, 500, { error: { code: "internal_error", message: error.message } });
    }
  });

  // Route validators (requireIsoDate, weekBounds, etc.) throw plain Errors on bad client input,
  // same as the write path's handlers — without this try/catch those surfaced as 500s (looks
  // like a server crash to anyone monitoring error rates) instead of a 400.
  async function handleRead(url, response) {
    try {
      if (url.pathname === "/api/v1/health") return json(response, 200, { ok: true, local: true });
      if (url.pathname === "/api/v1/config") return json(response, 200, {
        host, port: server.address()?.port ?? port, allowRemote,
        dbPath: hub.storage.dbPath,
        authEnabled: Boolean(process.env.CORTEX_TOKEN || ""), // boolean only — never the token
        metricsRetentionDays: Number(process.env.CORTEX_METRICS_RETENTION_DAYS || 90),
      });
      if (url.pathname === "/api/v1/search") {
        const query = url.searchParams.get("query");
        const projectPath = url.searchParams.get("project");
        if (!query || !projectPath) return json(response, 400, { error: { code: "invalid_request", message: "project and query are required" } });
        await hub.embeddingProvider.prepare?.(query); // enables cosine scoring; silent MinHash fallback if Ollama is down
        return json(response, 200, hub.search({ projectPath, query, maxTokens: Number(url.searchParams.get("maxTokens") || 1500) }));
      }
      if (url.pathname === "/api/v1/record") {
        const prefix = url.searchParams.get("prefix");
        if (!prefix) return json(response, 400, { error: { code: "invalid_request", message: "prefix is required" } });
        const record = hub.getRecord({ idPrefix: prefix, agent: url.searchParams.get("agent") || undefined });
        if (!record) return json(response, 404, { error: { code: "not_found", message: `no record matches [m:${prefix}]` } });
        return json(response, 200, record);
      }
      if (url.pathname === "/api/v1/projects") {
        // tier/pinned ride along on the existing read so the Control Center's per-project
        // autonomy control needs no second (per-project, N+1) endpoint.
        return json(response, 200, hub.storage.db.prepare(`SELECT project_path AS projectPath, name, mode, summary, updated_at AS updatedAt FROM project_profiles ORDER BY name`).all()
          .map((row) => ({
            ...row,
            tier: projectTier(hub.storage, row.projectPath),
            pinned: isPinnedWatch(row.projectPath),
            lifecycle: projectLifecycle(hub.storage, row.projectPath),
          })));
      }
      if (url.pathname === "/api/v1/portfolio/doctor") {
        return json(response, 200, hub.portfolioDoctor({ today: url.searchParams.get("today") || undefined }));
      }
      if (url.pathname === "/api/v1/entities") return json(response, 200, hub.storage.db.prepare(`SELECT id, label, entity_type AS entityType, project_path AS projectPath FROM entities ORDER BY entity_type, label`).all());
      // ponytail: no ?project = central dashboard across every project; small N, reuse per-project methods
      // dedupe by normalized path: separator/case variants AND linked worktrees of one repo share a git root
      const allProjectPaths = () => {
        const seen = new Set();
        return hub.storage.db.prepare("SELECT project_path AS p FROM project_profiles").all()
          .map((r) => r.p)
          .filter((p) => { const key = normalizeProjectPath(p).toLowerCase(); return !seen.has(key) && seen.add(key); });
      };
      if (url.pathname === "/api/v1/tasks") {
        const project = url.searchParams.get("project");
        const list = (p) => hub.listTasks({ projectPath: p });
        return json(response, 200, project ? list(project) : allProjectPaths().flatMap(list));
      }
      if (url.pathname === "/api/v1/overview") {
        // KPI counts for the Control Center, from existing indexed tables.
        // capturedToday: fixes + research created since local midnight (created_at is ISO,
        // compared against the local-day start rendered as ISO so UTC skew doesn't misbucket).
        const startOfLocalDay = new Date(`${localToday()}T00:00:00`).toISOString();
        const db = hub.storage.db;
        const capturedToday =
          db.prepare("SELECT COUNT(*) AS c FROM fix_entries WHERE created_at >= ?").get(startOfLocalDay).c +
          db.prepare("SELECT COUNT(*) AS c FROM research_entries WHERE created_at >= ?").get(startOfLocalDay).c;
        const durableMemories = db.prepare("SELECT COUNT(*) AS c FROM fix_entries").get().c;
        const blockedTasks = db.prepare("SELECT COUNT(*) AS c FROM workflow_tasks WHERE status = 'blocked'").get().c;
        return json(response, 200, { capturedToday, durableMemories, blockedTasks });
      }
      if (url.pathname === "/api/v1/settings") {
        // fixed allowlisted keys start from defaults; any persisted tokenBudget.* is merged in
        const out = { ...SETTINGS_DEFAULTS };
        // sentinel, not undefined: getSetting's default param coerces an explicit undefined to null
        const MISSING = Symbol("missing");
        for (const key of Object.keys(SETTINGS_DEFAULTS)) {
          const stored = hub.storage.getSetting(key, MISSING);
          if (stored !== MISSING) out[key] = stored;
        }
        for (const row of hub.storage.db.prepare("SELECT key, value_json AS v FROM hub_settings WHERE key LIKE 'tokenBudget.%'").all()) {
          out[row.key] = JSON.parse(row.v);
        }
        return json(response, 200, out);
      }
      if (url.pathname === "/api/v1/needs-you") {
        const today = localToday();
        const paths = allProjectPaths();
        const reviews = paths.flatMap((p) => hub.listTasks({ projectPath: p, statuses: ["review"] }));
        const blocked = paths.flatMap((p) => hub.listTasks({ projectPath: p, statuses: ["blocked"] }));
        // Memory Guard verdicts, enriched with the memory context that triggered them, so a human
        // can approve/edit/retry/leave-blocked with the same evidence the guard saw. A hard block
        // carries the verdict in blockReason; a soft warn ran and carries it in review evidence.
        const guard = [...blocked, ...reviews].flatMap((task) => {
          const verdict = parseGuardVerdict(task.status === "blocked" ? task.blockReason : task.evidence);
          if (!verdict) return [];
          const query = [task.title, task.acceptanceCriteria].filter(Boolean).join(" ");
          const memories = hub.search({ projectPath: task.projectPath, query, maxTokens: 500 }).results
            .slice(0, 3)
            .map((r) => ({ id: r.id, recordType: r.recordType, title: r.title, excerpt: r.excerpt }));
          return [{ ...task, guard: { ...verdict, memories } }];
        });
        // Portfolio view: which projects are being worked on but have nothing to pick up next.
        // 21 projects produce records and 4 carry any task, so this is where intake is missing.
        const lastRecordAt = (p) => hub.storage.db.prepare(
          "SELECT MAX(created_at) AS at FROM (SELECT created_at FROM fix_entries WHERE project_path = ?1 UNION ALL SELECT created_at FROM research_entries WHERE project_path = ?1 UNION ALL SELECT created_at FROM decision_entries WHERE project_path = ?1)",
        ).get(normalizeProjectPath(p))?.at ?? null;
        const stalls = portfolioStalls(
          paths.map((p) => ({
            projectPath: p,
            tier: projectTier(hub.storage, p),
            lastRecordAt: lastRecordAt(p),
            tasks: hub.listTasks({ projectPath: p }),
          })),
          { today },
        );
        return json(response, 200, {
          reviews,
          inbox: paths.flatMap((p) => hub.listInbox({ projectPath: p, limit: 50 })),
          rechecks: blocked.filter((t) => t.recheckAt && t.recheckAt <= today),
          guard,
          stalls,
        });
      }
      if (url.pathname === "/api/v1/links") return json(response, 200, hub.storage.db.prepare(`
        SELECT link.id, link.from_entity_id AS fromEntityId, source_entity.label AS fromLabel,
          source_entity.entity_type AS fromType, link.to_entity_id AS toEntityId,
          target_entity.label AS toLabel, target_entity.entity_type AS toType,
          link.link_type AS linkType, link.source, link.confidence,
          link.origin_record_id AS originRecordId
        FROM links AS link
        JOIN entities AS source_entity ON source_entity.id = link.from_entity_id
        JOIN entities AS target_entity ON target_entity.id = link.to_entity_id
        ORDER BY link.created_at DESC
      `).all());
      if (url.pathname === "/api/v1/activity") {
        const projectPath = url.searchParams.get("project");
        if (!projectPath) return json(response, 400, { error: { code: "invalid_request", message: "project is required" } });
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
        return json(response, 200, hub.storage.listMetrics(projectPath, { limit }));
      }
      if (url.pathname === "/api/v1/activity-log") {
        const p = url.searchParams;
        const types = p.get("types");
        return json(response, 200, hub.storage.activityLog({
          projectPath: p.get("project") || null,
          types: types ? types.split(",").filter(Boolean) : null,
          agent: p.get("agent") || null,
          since: p.get("since") || null,
          query: p.get("q") || null,
          limit: p.get("limit"),
        }));
      }
      if (url.pathname === "/api/v1/runs") {
        const project = url.searchParams.get("project");
        const list = (p) => hub.listRuns({ projectPath: p });
        return json(response, 200, project ? list(project) : allProjectPaths().flatMap(list));
      }
      if (url.pathname.startsWith("/api/v1/runs/") && url.pathname.endsWith("/log")) {
        // Tail of the run's .jsonl so a failed overnight run is diagnosable from the UI.
        // Missing/unreadable log is a normal state (pre-progress crash, rotated disk) —
        // report it as `missing`, never as an error.
        const id = decodeURIComponent(url.pathname.slice("/api/v1/runs/".length, -"/log".length));
        const run = hub.storage.getRun(id);
        if (!run) return json(response, 404, { error: { code: "not_found", message: "Run not found" } });
        const wanted = Math.min(500, Math.max(1, Number(url.searchParams.get("lines")) || 100));
        if (!run.logPath) return json(response, 200, { runId: id, logPath: null, missing: true, lines: [] });
        try {
          const text = await readFile(run.logPath, "utf8");
          return json(response, 200, { runId: id, logPath: run.logPath, missing: false, lines: text.split(/\r?\n/).filter(Boolean).slice(-wanted) });
        } catch {
          return json(response, 200, { runId: id, logPath: run.logPath, missing: true, lines: [] });
        }
      }
      if (url.pathname === "/api/v1/costs") {
        return json(response, 200, hub.storage.costSummary({ since: url.searchParams.get("since") }));
      }
      if (url.pathname === "/api/v1/inbox") {
        const projectPath = url.searchParams.get("project");
        if (!projectPath) return json(response, 400, { error: { code: "invalid_request", message: "project is required" } });
        return json(response, 200, hub.listInbox({ projectPath, includeResolved: url.searchParams.get("includeResolved") === "true" }));
      }
      if (url.pathname === "/api/v1/stats") {
        const projectPath = url.searchParams.get("project");
        if (!projectPath) return json(response, 400, { error: { code: "invalid_request", message: "project is required" } });
        return json(response, 200, hub.stats({ projectPath }));
      }
      if (url.pathname === "/api/v1/audit") return json(response, 200, hub.audit({ projectPath: url.searchParams.get("project") || undefined }));
      if (url.pathname === "/api/v1/goals") {
        const today = url.searchParams.get("today") || new Date().toISOString().slice(0, 10);
        return json(response, 200, hub.getGoalsPortfolio({ today }));
      }
      if (url.pathname === "/api/v1/roadmaps") {
        const project = url.searchParams.get("project");
        if (!project) return json(response, 400, { error: { code: "invalid_request", message: "project is required" } });
        return json(response, 200, hub.getRoadmap({ projectPath: project }));
      }
      if (url.pathname === "/api/v1/weeks") {
        const weekStart = url.searchParams.get("start");
        if (!weekStart) return json(response, 400, { error: { code: "invalid_request", message: "start is required" } });
        const capacity = url.searchParams.get("capacity");
        return json(response, 200, hub.getWeeklyPlan({ weekStart, totalCapacity: capacity ? Number(capacity) : undefined }));
      }
      if (url.pathname === "/api/v1/roadmap-proposals") {
        const project = url.searchParams.get("project");
        if (!project) return json(response, 400, { error: { code: "invalid_request", message: "project is required" } });
        return json(response, 200, hub.listRoadmapProposals({ projectPath: project, status: url.searchParams.get("status") || undefined }));
      }
      if (!url.pathname.startsWith("/api/")) {
        const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const candidate = resolve(join(resolvedStaticDir, requested));
        const rel = relative(resolvedStaticDir, candidate);
        let served = (!rel.startsWith("..") && !isAbsolute(rel)) ? candidate : indexPath;
        let content;
        try { content = await readFile(served); }
        catch { served = indexPath; content = await readFile(indexPath); }
        const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
        response.writeHead(200, { "content-type": `${types[extname(served)] || "application/octet-stream"}; charset=utf-8` });
        return response.end(content);
      }
      return json(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const message = error.message || "Read failed";
      const status = error.httpCode === "not_found" || /not found/i.test(message) ? 404 : 400;
      return json(response, status, { error: { code: status === 404 ? "not_found" : "invalid_request", message } });
    }
  }
  // hourly best-effort sweep so a long-lived server reaps old logs / metrics without
  // waiting for the next process restart; unref'd so it never keeps the process alive.
  let sweepTimer = null;
  // Transcript distillation drain: one queued job per tick, never overlapping (a model call
  // can outlive the interval). Best-effort — a wedged distill must never touch serving.
  let distillTimer = null;
  let distilling = false;
  // Embedding sweep: prune orphan vectors, embed new search_chunks (bounded per tick).
  // Non-overlapping like distill — a CPU embed batch can outlive the interval.
  let embedTimer = null;
  let embedding = false;
  const drainEmbeddings = async () => {
    if (embedding) return;
    embedding = true;
    try { await hub.embeddingProvider.embedMissing?.(); } catch { /* Ollama down — retry next tick */ }
    finally { embedding = false; }
  };
  const drainDistill = async () => {
    if (distilling) return;
    distilling = true;
    try { await runNextDistillJob(hub); } catch { /* job row keeps its error status */ }
    finally { distilling = false; }
  };
  // Capture-liveness alarm (value audit V): the Aug 9–12 blackout ran ~5 days unnoticed.
  // One Telegram ping when trailing-24h captures fall under the floor, at most one per ~20h.
  // The baseline guard keeps fresh or low-traffic installs from alarming on normal quiet.
  let lastLivenessAlert = 0;
  const checkCaptureLiveness = () => {
    const floor = Number(process.env.CORTEX_CAPTURE_FLOOR_PER_DAY || 40);
    const baselinePerDay = hub.storage.countRecentMetrics("capture_outcome", 14 * 86_400_000) / 14;
    if (baselinePerDay < floor * 2) return;
    const last24h = hub.storage.countRecentMetrics("capture_outcome", 86_400_000);
    if (last24h >= floor || Date.now() - lastLivenessAlert < 72_000_000) return;
    lastLivenessAlert = Date.now();
    notifier.push("capture-liveness",
      `⚠️ Memory hub capture may be down: ${last24h} captures in 24h (floor ${floor}, normal ~${Math.round(baselinePerDay)}). Run /hub-doctor.`,
    ).catch(() => {});
  };
  return {
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        sweepTimer = setInterval(() => {
          try { hub.sweep(); } catch { /* best-effort */ }
          try { checkCaptureLiveness(); } catch { /* best-effort */ }
        }, 3_600_000);
        sweepTimer.unref?.();
        distillTimer = setInterval(() => { drainDistill(); }, Number(process.env.CORTEX_DISTILL_INTERVAL_MS || 60_000));
        distillTimer.unref?.();
        // Embedding indexer parked (value audit V): 4,660 GPU-resident vectors were serving
        // 5 searches a fortnight, and the hybrid-vs-lexical bar (≥20% better) was never met
        // because the A/B never ran. Existing vectors stay on disk and still serve search;
        // opt back in with CORTEX_EMBEDDINGS=1 once the A/B justifies it.
        if (process.env.CORTEX_EMBEDDINGS === "1") {
          embedTimer = setInterval(() => { drainEmbeddings(); }, Number(process.env.CORTEX_EMBED_INTERVAL_MS || 60_000));
          embedTimer.unref?.();
          drainEmbeddings(); // kick the backfill immediately on boot rather than waiting a tick
        }
        resolve({ host, port: address.port });
      });
    }),
    stop: async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      if (distillTimer) clearInterval(distillTimer);
      distillTimer = null;
      if (embedTimer) clearInterval(embedTimer);
      embedTimer = null;
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
    server,
  };
}
