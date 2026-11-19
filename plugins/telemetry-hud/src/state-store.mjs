import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { computeContextRunway } from "./modules/context-xray.mjs";

export const DEFAULT_PREFS = {
  pillVisible: true,
  pillMode: "compact",
  pillClickAction: "open-hud",
  smoothing: true,
  range: "today",
  contextWarnPct: 80,
  viewMode: "compact",
  theme: "mono",
};

const VALID_PILL_MODES = new Set(["compact", "detailed", "minimal"]);
const VALID_CLICK_ACTIONS = new Set(["open-hud", "cycle-mode"]);
const VALID_RANGES = new Set(["session", "today", "7d", "all"]);
const VALID_VIEW_MODES = new Set(["compact", "full"]);
const VALID_THEMES = new Set(["mono", "amber", "crt"]);
const MAX_CACHED_SESSIONS = 32;

function normalizePrefs(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    pillVisible: typeof input.pillVisible === "boolean" ? input.pillVisible : DEFAULT_PREFS.pillVisible,
    pillMode: VALID_PILL_MODES.has(input.pillMode) ? input.pillMode : DEFAULT_PREFS.pillMode,
    pillClickAction: VALID_CLICK_ACTIONS.has(input.pillClickAction)
      ? input.pillClickAction
      : DEFAULT_PREFS.pillClickAction,
    smoothing: typeof input.smoothing === "boolean" ? input.smoothing : DEFAULT_PREFS.smoothing,
    range: VALID_RANGES.has(input.range) ? input.range : DEFAULT_PREFS.range,
    contextWarnPct: typeof input.contextWarnPct === "number" && input.contextWarnPct >= 50 && input.contextWarnPct <= 99
      ? Math.round(input.contextWarnPct)
      : DEFAULT_PREFS.contextWarnPct,
    viewMode: VALID_VIEW_MODES.has(input.viewMode) ? input.viewMode : DEFAULT_PREFS.viewMode,
    theme: VALID_THEMES.has(input.theme) ? input.theme : DEFAULT_PREFS.theme,
  };
}

function mergeSubagents(sqliteSubagents, liveSubagents, nowMs) {
  const base = sqliteSubagents || {
    runningCount: 0,
    totalCount: 0,
    parentRunningAgentCalls: 0,
    totals: { requestCount: 0, toolCount: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 },
    items: [],
  };

  if (!Array.isArray(liveSubagents) || liveSubagents.length === 0) {
    return base;
  }

  const mergedById = new Map();
  for (const item of base.items || []) {
    mergedById.set(item.id, { ...item });
  }

  for (const ls of liveSubagents) {
    const key = ls.childSessionId || ls.id;
    const existing = mergedById.get(key);
    const liveStatus = ls.status === "running"
      ? "running"
      : (ls.status === "failed" ? "error" : (ls.status === "success" ? "completed" : ls.status));

    if (existing) {
      mergedById.set(key, {
        ...existing,
        status: liveStatus === "running" && existing.status !== "completed" ? "running" : existing.status,
        subagentType: ls.subagentType || existing.subagentType || null,
        backgrounded: ls.backgrounded === true,
        summaryText: ls.summaryText || null,
      });
    } else {
      const startedAt = ls.startedAt || nowMs;
      const endedAt = ls.endedAt || nowMs;
      mergedById.set(key, {
        id: key,
        shortId: key.replace(/^sess_subagent_agent_/, "").slice(0, 8),
        title: ls.summaryText || ls.subagentType || "Subagent",
        subagentType: ls.subagentType || null,
        backgrounded: ls.backgrounded === true,
        status: liveStatus,
        reqs: 0,
        tools: 0,
        runningTools: liveStatus === "running" ? 1 : 0,
        lastTool: null,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        retryCount: 0,
        rateLimitCount: 0,
        medianTps: null,
        lastTps: null,
        elapsedMs: Math.max(0, (liveStatus === "running" ? nowMs : endedAt) - startedAt),
        timeCreated: startedAt,
        lastActivityAt: endedAt,
      });
    }
  }

  const items = [...mergedById.values()];
  items.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return (b.timeCreated || 0) - (a.timeCreated || 0);
  });

  const runningCount = items.filter((item) => item.status === "running").length;
  return {
    ...base,
    runningCount,
    totalCount: Math.max(base.totalCount || 0, items.length),
    items: items.slice(0, 12),
  };
}

export function createStateStore(deps) {
  const {
    dataPath,
    throughput,
    contextXray,
    sqliteStats,
    liveSession = null,
    isSessionsReadGranted = () => false,
  } = deps;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const prefsFile = dataPath ? path.join(dataPath, "prefs.json") : null;

  let prefs = { ...DEFAULT_PREFS };
  let visibleSessions = [];
  let focusedSessionId = null;
  let saveChain = Promise.resolve();
  const sqliteCache = new Map();
  const inflightSqlite = new Map();
  const changeListeners = new Set();

  async function loadPrefs() {
    if (!prefsFile) return prefs;
    try {
      const content = await readFile(prefsFile, "utf8");
      prefs = normalizePrefs(JSON.parse(content));
    } catch {
      prefs = { ...DEFAULT_PREFS };
    }
    return { ...prefs };
  }

  async function writePrefsAtomic(payload) {
    if (!prefsFile) return;
    const tmpFile = `${prefsFile}.tmp.${process.pid}`;
    try {
      await mkdir(path.dirname(prefsFile), { recursive: true });
      await writeFile(tmpFile, payload, "utf8");
      await rename(tmpFile, prefsFile);
    } catch {
      try {
        await unlink(tmpFile);
      } catch {
      }
    }
  }

  function savePrefs() {
    if (!prefsFile) return Promise.resolve();
    const payload = `${JSON.stringify(prefs, null, 2)}\n`;
    const next = saveChain.then(() => writePrefsAtomic(payload));
    saveChain = next.catch(() => {});
    return next;
  }

  async function updatePrefs(patch) {
    prefs = normalizePrefs({ ...prefs, ...(patch && typeof patch === "object" ? patch : {}) });
    await savePrefs();
    emitChange({ kind: "prefs", prefs: { ...prefs } });
    return { ...prefs };
  }

  function getPrefs() {
    return { ...prefs };
  }

  function setVisibleSessions(sessions) {
    visibleSessions = Array.isArray(sessions) ? sessions.map((s) => ({ ...s })) : [];
    const focused = visibleSessions.find((s) => s.focused);
    if (focused?.sessionId) {
      focusedSessionId = focused.sessionId;
    } else if (visibleSessions.length > 0 && !visibleSessions.some((s) => s.sessionId === focusedSessionId)) {
      focusedSessionId = visibleSessions[0].sessionId;
    }
    emitChange({ kind: "workbench" });
  }

  function getVisibleSessions() {
    return visibleSessions.map((s) => ({ ...s }));
  }

  function resolveSessionId(preferredSessionId) {
    if (typeof preferredSessionId === "string" && preferredSessionId.trim()) {
      return preferredSessionId;
    }
    const focused = visibleSessions.find((s) => s.focused);
    if (focused?.sessionId) return focused.sessionId;
    if (focusedSessionId) return focusedSessionId;
    if (visibleSessions[0]?.sessionId) return visibleSessions[0].sessionId;
    return null;
  }

  function setSqliteOverview(sessionId, overview) {
    const key = sessionId || "__global__";
    if (sqliteCache.has(key)) {
      sqliteCache.delete(key);
    } else if (sqliteCache.size >= MAX_CACHED_SESSIONS) {
      const visibleIds = new Set(visibleSessions.map((s) => s.sessionId).filter(Boolean));
      let evictKey = null;
      for (const existingKey of sqliteCache.keys()) {
        if (!visibleIds.has(existingKey)) {
          evictKey = existingKey;
          break;
        }
      }
      if (evictKey === null) {
        evictKey = sqliteCache.keys().next().value;
      }
      if (evictKey !== undefined) sqliteCache.delete(evictKey);
    }
    sqliteCache.set(key, { overview, updatedAt: now() });
  }

  function getCachedSqliteOverview(sessionId) {
    const key = sessionId || "__global__";
    return sqliteCache.get(key) ?? null;
  }

  async function refreshSqlite(sessionId, range = prefs.range) {
    const inflightKey = `${sessionId || "__global__"}::${range}`;
    if (inflightSqlite.has(inflightKey)) {
      return inflightSqlite.get(inflightKey);
    }

    const promise = (async () => {
      try {
        const overview = await sqliteStats.getOverview(sessionId, range);
        setSqliteOverview(sessionId, overview);
        if (sessionId && overview.session?.recentRequests?.length) {
          throughput.hydrateHistory(sessionId, overview.session.recentRequests);
        }
        const baselineTokens = overview.session?.latestInputTokens ?? overview.session?.latest?.inputTokens ?? null;
        if (sessionId && baselineTokens && contextXray.setFallbackBaseline) {
          contextXray.setFallbackBaseline(sessionId, { inputTokens: baselineTokens });
        }
        return overview;
      } finally {
        inflightSqlite.delete(inflightKey);
      }
    })();

    inflightSqlite.set(inflightKey, promise);
    return promise;
  }

  async function buildSnapshot({ sessionId = null, range = prefs.range, forceSqlite = false } = {}) {
    const targetSessionId = resolveSessionId(sessionId);
    const effectiveRange = VALID_RANGES.has(range) ? range : prefs.range;
    const cached = getCachedSqliteOverview(targetSessionId);
    const cacheStale = !cached
      || cached.overview.range !== effectiveRange
      || (now() - cached.updatedAt > 1500);

    const rawSqlite = (forceSqlite || cacheStale)
      ? await refreshSqlite(targetSessionId, effectiveRange)
      : cached.overview;

    const tp = throughput.get(targetSessionId);
    const liveSnap = liveSession && targetSessionId ? liveSession.get(targetSessionId) : null;
    const mergedSubagents = mergeSubagents(rawSqlite.subagents, liveSnap?.liveSubagents, now());

    const rawCtx = targetSessionId ? contextXray.get(targetSessionId) : null;
    const ctxData = rawCtx
      ? {
          ...rawCtx,
          runway: computeContextRunway({
            usedTokens: rawCtx.usedTokens,
            contextWindow: rawCtx.contextWindow,
            tokensPerTurn: rawSqlite.session?.tokensPerTurn,
            warnPct: 85,
          }),
        }
      : null;

    return {
      generatedAt: now(),
      sessionId: targetSessionId,
      range: effectiveRange,
      prefs: getPrefs(),
      permissions: { sessionsRead: Boolean(isSessionsReadGranted()) },
      visibleSessions: getVisibleSessions(),
      throughput: tp,
      live: liveSnap,
      context: ctxData,
      sqlite: {
        ...rawSqlite,
        subagents: mergedSubagents,
      },
    };
  }

  function onChange(listener) {
    changeListeners.add(listener);
    return {
      dispose() {
        changeListeners.delete(listener);
      },
    };
  }

  function emitChange(event) {
    for (const listener of changeListeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }

  return {
    loadPrefs,
    updatePrefs,
    getPrefs,
    setVisibleSessions,
    getVisibleSessions,
    resolveSessionId,
    setSqliteOverview,
    getCachedSqliteOverview,
    refreshSqlite,
    buildSnapshot,
    onChange,
  };
}
