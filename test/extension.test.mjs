import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { activate, deactivate } from "../plugins/telemetry-hud/src/extension.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "telemetry-hud");
const ASCII_ONLY_RE = /^[\x09\x0A\x0D\x20-\x7E]*$/;
const PERSONAL_PATH_RE = new RegExp(["bennet" + "\\.speh", "/U" + "sers/", "bi" + "orce"].join("|"), "i");

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function createMinimalDb(dir) {
  const dbPath = path.join(dir, "db.sqlite");
  const now = Date.now();
  const sql = `
    CREATE TABLE session (id text primary key, parent_id text, title text, task_type text, time_created integer, time_updated integer, last_outcome text);
    CREATE TABLE model_usage (id text primary key, logical_request_id text, attempt_index integer, session_id text, turn_id text, query_source text, provider_id text, model_id text, status text, started_at integer, first_token_at integer, completed_at integer, duration_ms integer, time_to_first_token_ms integer, finish_reason text, tool_call_count integer, input_tokens integer, output_tokens integer, reasoning_tokens integer, cache_creation_input_tokens integer, cache_read_input_tokens integer, provider_total_tokens integer, computed_total_tokens integer, retry_count integer, error_type text);
    CREATE TABLE turn_usage (session_id text, turn_id text, status text, started_at integer, first_token_at integer, completed_at integer, duration_ms integer, time_to_first_token_ms integer, model_request_count integer, model_retry_count integer, tool_call_count integer, tool_error_count integer, input_tokens integer, output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer);
    CREATE TABLE tool_usage (id text primary key, session_id text, turn_id text, tool_call_id text, tool_name text, status text, started_at integer, completed_at integer, duration_ms integer, output_bytes integer, truncated integer);

    INSERT INTO session VALUES ('sess_live', NULL, 'Main', 'interactive', ${now - 60000}, ${now}, NULL);
    INSERT INTO session VALUES ('sess_subagent_agent_abc', 'sess_live', 'Verify edge cases', 'subagent_child', ${now - 10000}, ${now - 1000}, NULL);
    INSERT INTO tool_usage VALUES ('tu1', 'sess_live', 'turn1', 'c1', 'Agent', 'running', ${now - 10000}, NULL, NULL, 0, 0);
    INSERT INTO tool_usage VALUES ('tu2', 'sess_subagent_agent_abc', 'turn_s', 'c2', 'Bash', 'running', ${now - 2000}, NULL, NULL, 0, 0);
  `;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return dbPath;
}

function createHarness(dbPath, { allowGrant = false } = {}) {
  const slotUpdates = [];
  const openedViews = [];
  const commands = new Map();
  const views = new Map();
  let grantAllowed = allowGrant;
  const listeners = {
    onDidGenerate: null,
    onContextChange: null,
    onWorkbenchChange: null,
    onConvChange: null,
    onConvErr: null,
    onRowsChange: null,
    onRowsErr: null,
    onListChange: null,
    onListErr: null,
  };

  const mockCtx = {
    extension: { id: "telemetry-hud@zcode-telemetry", version: "0.3.3", path: PLUGIN_ROOT, dataPath: path.dirname(dbPath) },
    log: { info() {}, warn() {}, error() {} },
    models: {
      onDidGenerate(fn) {
        listeners.onDidGenerate = fn;
        return { dispose() { listeners.onDidGenerate = null; } };
      },
    },
    sessions: {
      onDidChangeList(fn, onErr) {
        if (!grantAllowed) {
          onErr?.({ code: "not-granted", message: "sessions.onDidChangeList needs sessions.read" });
          return { dispose() {} };
        }
        listeners.onListChange = fn;
        listeners.onListErr = onErr;
        return { dispose() { listeners.onListChange = null; } };
      },
      onDidChangeConversation(_input, fn, onErr) {
        if (!grantAllowed) {
          onErr?.({ code: "not-granted", message: "sessions.onDidChangeConversation needs sessions.read" });
          return { dispose() {} };
        }
        listeners.onConvChange = fn;
        listeners.onConvErr = onErr;
        return { dispose() { listeners.onConvChange = null; } };
      },
      onDidChangeRows(_input, fn, onErr) {
        if (!grantAllowed) {
          onErr?.({ code: "not-granted", message: "sessions.onDidChangeRows needs sessions.read" });
          return { dispose() {} };
        }
        listeners.onRowsChange = fn;
        listeners.onRowsErr = onErr;
        return { dispose() { listeners.onRowsChange = null; } };
      },
    },
    grants: {
      async request() {
        grantAllowed = true;
        return { granted: ["sessions.read"] };
      },
    },
    context: {
      async get({ sessionId }) {
        return {
          sessionId,
          revision: 1,
          phase: "request",
          measuredAt: Date.now(),
          model: { providerId: "z-ai", modelId: "glm-5.3-flash", contextWindow: 262000 },
          tokenMethod: "estimated",
          estimatedTokens: 200000,
          providerInputTokens: 131000,
          freeTokens: 131000,
          categories: [{ id: "messages", tokens: 200000, chars: 800000 }],
        };
      },
      onDidChange(fn) {
        listeners.onContextChange = fn;
        return { dispose() { listeners.onContextChange = null; } };
      },
    },
    workbench: {
      async visibleSessions() {
        return [{ sessionId: "sess_live", workspace: { workspacePath: "/tmp/ws" }, isDraft: false, focused: true }];
      },
      onDidChange(fn) {
        listeners.onWorkbenchChange = fn;
        return { dispose() { listeners.onWorkbenchChange = null; } };
      },
    },
    slots: {
      update(itemId, patch, scope) {
        slotUpdates.push({ itemId, patch, scope });
      },
    },
    commands: {
      register(id, fn) {
        commands.set(id, fn);
        return { dispose() { commands.delete(id); } };
      },
    },
    views: {
      register(id, def) {
        views.set(id, def);
        return { dispose() { views.delete(id); } };
      },
      async open(viewId, scope) {
        openedViews.push({ viewId, scope });
      },
    },
  };

  return { mockCtx, slotUpdates, openedViews, commands, views, listeners };
}

test("manifests conform to ZCode 3.18.2 strict extension and slot schemas at 0.3.3", () => {
  const market = JSON.parse(readFileSync(path.join(REPO_ROOT, "marketplace.json"), "utf8"));
  const manifest = JSON.parse(
    readFileSync(path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  const licenseText = readFileSync(path.join(REPO_ROOT, "LICENSE"), "utf8");

  assert.match(licenseText, ASCII_ONLY_RE);
  assert.ok(licenseText.includes("MIT License"));
  assert.equal(market.name, "zcode-telemetry");
  assert.equal(manifest.version, "0.3.3");
  assert.equal(manifest.author?.name, "bennets23");
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, manifest.name);
  assert.equal(market.plugins[0].version, manifest.version);
  assert.equal(market.plugins[0].source, "./plugins/telemetry-hud");

  const ext = manifest.extension;
  assert.match(ext.engines.zcode, /^(\^)?(\d+)\.(\d+)\.(\d+)$/);
  assert.equal(ext.main, "src/extension.mjs");
  assert.deepEqual(ext.activationEvents, ["onAvailable"]);
  assert.deepEqual(ext.grants, ["sessions.read"]);
  assert.deepEqual(ext.protocols, { sessions: 1, rows: 4 });

  const cmdIds = new Set(ext.contributes.commands.map((c) => c.id));
  assert.ok(cmdIds.has("pill-click"));
  const viewIds = new Set(ext.contributes.views.map((v) => v.id));
  for (const id of [...cmdIds, ...viewIds]) {
    assert.match(id, /^[a-z0-9._-]{1,64}$/);
  }
  assert.equal(ext.contributes.views[0].icon, "activity");

  assert.equal(manifest.slots["composer.status"].length, 1);
  const pill = manifest.slots["composer.status"][0];
  assert.match(pill.id, /^[a-z0-9._-]{1,64}$/);
  assert.equal(pill.target.command, "pill-click");
  assert.ok(cmdIds.has(pill.target.command));

  assert.equal(manifest.slots["sidePane.launcher"].length, 1);
  const launcher = manifest.slots["sidePane.launcher"][0];
  assert.match(launcher.id, /^[a-z0-9._-]{1,64}$/);
  assert.ok(viewIds.has(launcher.target.view));
  assert.equal(launcher.icon, "activity");
});

test("entire repository contains zero emojis, non-ASCII chars, comments, or personal paths", () => {
  const allFiles = walkFiles(REPO_ROOT).filter(
    (f) => /\.(json|mjs|html|md)$/.test(f) || path.basename(f) === "LICENSE",
  );
  assert.ok(allFiles.length >= 12);
  for (const file of allFiles) {
    const content = readFileSync(file, "utf8");
    assert.match(content, ASCII_ONLY_RE, `Non-ASCII character found in ${file}`);
    assert.equal(PERSONAL_PATH_RE.test(content), false, `Personal path reference found in ${file}`);
  }

  const codeFiles = walkFiles(REPO_ROOT).filter((f) => /\.(mjs|html)$/.test(f));
  for (const file of codeFiles) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.replace(/(?:https?|telemetry):\/\//g, "");
      const isHtml = file.endsWith(".html");
      const commentStartRe = isHtml ? /^\s*(?:\/\/|\/\*|<!--)/ : /^\s*(?:\/\/|\/\*|--\s|\*)/;
      assert.equal(commentStartRe.test(stripped), false, `Comment line at ${file}:${i + 1}`);
      assert.equal(/\s\/\/\s/.test(stripped), false, `Inline comment at ${file}:${i + 1}`);
      if (isHtml) {
        assert.equal(stripped.includes("/*") || stripped.includes("<!--"), false, `HTML/CSS comment at ${file}:${i + 1}`);
      }
    }
  }
});

test("dashboard.html implements MCP Apps handshake, pro metric tables, session pin, and click config", () => {
  const html = readFileSync(path.join(PLUGIN_ROOT, "views", "dashboard.html"), "utf8");
  assert.ok(html.includes('"ui/initialize"'));
  assert.ok(html.includes('"0.3.3"'));
  assert.ok(html.includes('"ui/notifications/initialized"'));
  assert.ok(html.includes('"resources/subscribe"'));
  assert.ok(html.includes('"telemetry://snapshot"'));
  assert.ok(html.includes('"ui/notifications/host-context-changed"'));
  assert.ok(html.includes("request_grants"));
  assert.ok(html.includes("btn-pill-click"));
  assert.ok(html.includes("ctx-runway"));
  assert.ok(html.includes("pinnedSessionId"));
  assert.ok(html.includes("P95 TTFT"));
  assert.ok(html.includes("CACHE WRITE"));
});

test("activate(ctx) streams Edit toolCall deltas, drops to 0 t/s when idle, and handles not-granted -> grant", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "zcode-telemetry-ext-"));
  const dbPath = createMinimalDb(dataDir);
  const { mockCtx, slotUpdates, openedViews, commands, views, listeners } = createHarness(dbPath);

  try {
    await activate(mockCtx, { sqliteOptions: { dbPath } });
    await new Promise((r) => setTimeout(r, 80));

    const viewDef = views.get("dashboard");
    const fakeView = {
      id: "inst_1",
      viewId: "dashboard",
      scope: { kind: "session", workspace: { workspacePath: "/tmp/ws" }, sessionId: "sess_live" },
      sessionId: "sess_live",
      notify() {},
      onDidClose() { return { dispose() {} }; },
    };
    viewDef.onDidOpen(fakeView);

    const preGrantSnap = await viewDef.tools.get_snapshot.run({ range: "session" }, { view: fakeView });
    assert.equal(preGrantSnap.permissions.sessionsRead, false);

    const postGrantSnap = await viewDef.tools.request_grants.run({}, { view: fakeView });
    assert.equal(postGrantSnap.permissions.sessionsRead, true);
    assert.ok(listeners.onConvChange);
    assert.ok(listeners.onRowsChange);

    listeners.onConvChange({ sessionId: "sess_live", logEpoch: "e1", revision: 1, phase: "running" });
    listeners.onRowsChange({
      kind: "rows",
      logEpoch: "e1",
      revision: 2,
      upserted: [{ kind: "toolCall", rowId: 1, toolCallId: "tc1", toolName: "Edit", status: "inputStreaming", inputText: "a".repeat(200) }],
    });
    await new Promise((r) => setTimeout(r, 380));
    listeners.onRowsChange({
      kind: "rows",
      logEpoch: "e1",
      revision: 3,
      upserted: [{ kind: "toolCall", rowId: 1, toolCallId: "tc1", toolName: "Edit", status: "inputStreaming", inputText: "a".repeat(400) }],
    });

    const editPill = slotUpdates.at(-1).patch.text;
    assert.ok(editPill.includes("t/s") && editPill.includes("*"), `Expected live Edit t/s pill, got "${editPill}"`);

    listeners.onConvChange({ sessionId: "sess_live", logEpoch: "e1", revision: 4, phase: "completedSuccess" });
    const idlePill = slotUpdates.at(-1).patch.text;
    assert.ok(idlePill.startsWith("0 t/s"), `Expected 0 t/s when idle, got "${idlePill}"`);
    assert.ok(idlePill.includes("1A"), `Expected 1A subagent indicator, got "${idlePill}"`);

    await viewDef.tools.set_preferences.run({ pillClickAction: "cycle-mode" }, { view: fakeView });
    const openCountBefore = openedViews.length;
    await commands.get("pill-click")({
      scope: { kind: "session", workspace: { workspacePath: "/tmp/ws" }, sessionId: "sess_live" },
    });
    assert.equal(openedViews.length, openCountBefore);
    await commands.get("open-dashboard")({
      scope: { kind: "session", workspace: { workspacePath: "/tmp/ws" }, sessionId: "sess_live" },
    });
    assert.equal(openedViews.length, openCountBefore + 1);

    deactivate();
    assert.equal(commands.size, 0);
    assert.equal(views.size, 0);
    assert.equal(listeners.onConvChange, null);
  } finally {
    deactivate();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("when sessions.read is not granted, models.onDidGenerate final drops cleanly back to 0 t/s idle", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "zcode-telemetry-nogrant-"));
  const dbPath = createMinimalDb(dataDir);
  const { mockCtx, slotUpdates, views, listeners } = createHarness(dbPath, { allowGrant: false });

  try {
    await activate(mockCtx, { sqliteOptions: { dbPath } });
    await new Promise((r) => setTimeout(r, 80));

    listeners.onDidGenerate({
      sessionId: "sess_live",
      requestId: "req_ng_1",
      phase: "streaming",
      model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
      outputTokensPerSecond: 145,
    });
    assert.ok(slotUpdates.at(-1).patch.text.includes("*"), "Expected live indicator during streaming");

    listeners.onDidGenerate({
      sessionId: "sess_live",
      requestId: "req_ng_1",
      phase: "final",
      model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
      outputTokensPerSecond: 148,
      outputTokens: 320,
      timeToFirstTokenMs: 420,
    });

    const finalPill = slotUpdates.at(-1).patch.text;
    assert.ok(finalPill.startsWith("0 t/s"), `Expected 0 t/s after final without grant, got "${finalPill}"`);

    const viewDef = views.get("dashboard");
    const snap = await viewDef.tools.get_snapshot.run(
      { sessionId: "sess_live", range: "session" },
      { view: { id: "v1", sessionId: "sess_live" } },
    );
    assert.equal(snap.live.isActiveTurn, false);
    assert.equal(snap.live.stalledWaitMs, 0);
  } finally {
    deactivate();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("AskUserQuestion row and sessions.onDidChangeList needs_attention drop speed to 0 and surface ASK/INPUT", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "zcode-telemetry-ask-"));
  const dbPath = createMinimalDb(dataDir);
  const { mockCtx, slotUpdates, views, listeners } = createHarness(dbPath, { allowGrant: true });

  try {
    await activate(mockCtx, { sqliteOptions: { dbPath } });
    await new Promise((r) => setTimeout(r, 80));

    listeners.onConvChange({ sessionId: "sess_live", logEpoch: "e1", revision: 1, phase: "running" });
    listeners.onDidGenerate({
      sessionId: "sess_live",
      requestId: "req_ask_1",
      phase: "streaming",
      model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
      outputTokensPerSecond: 215,
    });
    assert.ok(slotUpdates.at(-1).patch.text.includes("*"), "Expected live streaming pill before question");

    listeners.onRowsChange({
      kind: "rows",
      logEpoch: "e1",
      revision: 2,
      upserted: [
        { kind: "toolCall", rowId: 4, toolCallId: "tc_ask", toolName: "AskUserQuestion", status: "running", inputText: "{}" },
      ],
    });

    const askPill = slotUpdates.at(-1).patch.text;
    assert.ok(askPill.startsWith("ASK"), `Expected ASK pill when question tool runs, got "${askPill}"`);

    const viewDef = views.get("dashboard");
    const askSnap = await viewDef.tools.get_snapshot.run(
      { sessionId: "sess_live", range: "session" },
      { view: { id: "v_ask", sessionId: "sess_live" } },
    );
    assert.equal(askSnap.live.waitingForUser, true);
    assert.equal(askSnap.live.activity.label, "ASK");
    assert.equal(askSnap.throughput.phase, "idle");

    listeners.onRowsChange({
      kind: "rows",
      logEpoch: "e1",
      revision: 3,
      upserted: [
        { kind: "toolCall", rowId: 4, toolCallId: "tc_ask", toolName: "AskUserQuestion", status: "success", inputText: "{}" },
      ],
    });
    listeners.onDidGenerate({
      sessionId: "sess_live",
      requestId: "req_ask_2",
      phase: "streaming",
      model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
      outputTokensPerSecond: 190,
    });
    assert.ok(slotUpdates.at(-1).patch.text.includes("*"), "Expected live streaming pill after question answered");

    listeners.onListChange({
      kind: "delta",
      rev: 5,
      upserted: [{ session: { sessionId: "sess_live" }, status: "needs_attention", title: "Main" }],
      removed: [],
    });

    const inputPill = slotUpdates.at(-1).patch.text;
    assert.ok(inputPill.startsWith("INPUT"), `Expected INPUT pill on needs_attention, got "${inputPill}"`);
    const inputSnap = await viewDef.tools.get_snapshot.run(
      { sessionId: "sess_live", range: "session" },
      { view: { id: "v_ask", sessionId: "sess_live" } },
    );
    assert.equal(inputSnap.live.waitingForUser, true);
    assert.equal(inputSnap.throughput.phase, "idle");
  } finally {
    deactivate();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
