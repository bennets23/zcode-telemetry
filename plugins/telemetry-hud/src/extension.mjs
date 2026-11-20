import {
  formatAsciiReport,
  formatPillText,
  formatPillTooltip,
} from "./formatters.mjs";
import { createContextXrayTracker } from "./modules/context-xray.mjs";
import { createLiveSessionTracker } from "./modules/live-session.mjs";
import { createSqliteStatsReader } from "./modules/sqlite-stats.mjs";
import { createThroughputTracker } from "./modules/throughput.mjs";
import { createStateStore } from "./state-store.mjs";

const SNAPSHOT_RESOURCE_URI = "telemetry://snapshot";
const PILL_MODES = ["compact", "detailed", "minimal"];
const SQLITE_FLUSH_DELAY_MS = 250;
const VIEW_NOTIFY_DEBOUNCE_MS = 140;
const LIVE_POLL_INTERVAL_MS = 2500;
const ACTIVE_TICK_INTERVAL_MS = 1000;

let activeRuntime = null;

function toViewOpenScope(commandScope) {
  if (!commandScope || typeof commandScope !== "object") return undefined;
  if (commandScope.kind === "session" && commandScope.sessionId) {
    return { sessionId: commandScope.sessionId };
  }
  if (commandScope.kind === "workspace" && commandScope.workspace) {
    return { workspace: commandScope.workspace };
  }
  return undefined;
}

function getNextPillMode(current) {
  const idx = PILL_MODES.indexOf(current);
  return PILL_MODES[(idx + 1) % PILL_MODES.length];
}

function isNotGrantedError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.code === "not-granted") return true;
  return typeof err.message === "string" && /not-granted|needs sessions\.read/i.test(err.message);
}

export async function activate(ctx, overrides = {}) {
  if (activeRuntime) {
    await deactivate();
  }

  const setTimer = overrides.timers?.setTimeout || setTimeout;
  const clearTimer = overrides.timers?.clearTimeout || clearTimeout;
  const setLoop = overrides.timers?.setInterval || setInterval;
  const clearLoop = overrides.timers?.clearInterval || clearInterval;

  const throughput = createThroughputTracker({ alpha: 0.22, historyLimit: 40 });
  const contextXray = createContextXrayTracker();
  const liveSession = createLiveSessionTracker();
  const sqliteStats = createSqliteStatsReader(overrides.sqliteOptions);

  let sessionsReadState = "unknown";

  const store = createStateStore({
    dataPath: ctx?.extension?.dataPath,
    throughput,
    contextXray,
    sqliteStats,
    liveSession,
    isSessionsReadGranted: () => sessionsReadState !== "denied",
  });

  await store.loadPrefs();

  const disposables = [];
  const openViews = new Map();
  const viewCloseSubs = new Map();
  const sqliteFlushTimers = new Map();
  const sessionSubs = new Map();
  let listSub = null;
  let viewNotifyTimer = null;
  let livePollTimer = null;
  let activeTickTimer = null;
  let pollInFlight = false;

  function updateSlotForSession(sessionId) {
    if (!sessionId || !ctx?.slots?.update) return;
    const prefs = store.getPrefs();
    const tp = throughput.get(sessionId);
    const context = contextXray.get(sessionId);
    const liveSnap = liveSession.get(sessionId);
    const cached = store.getCachedSqliteOverview(sessionId);
    const sqliteSession = cached?.overview?.session ?? null;
    const subagents = cached?.overview?.subagents ?? null;

    const text = formatPillText({
      throughput: tp,
      context,
      sqliteSession,
      sqliteLatest: sqliteSession?.latest ?? null,
      subagents,
      liveSession: liveSnap,
      prefs,
    });
    const tooltip = formatPillTooltip({
      throughput: tp,
      context,
      sqliteSession,
      sqliteLatest: sqliteSession?.latest ?? null,
      subagents,
      liveSession: liveSnap,
      prefs,
    });

    try {
      ctx.slots.update(
        "live-pill",
        {
          text,
          tooltip,
          visible: prefs.pillVisible,
        },
        { sessionId },
      );
    } catch (err) {
      ctx?.log?.warn?.("slots.update failed", err instanceof Error ? err.message : String(err));
    }
  }

  function updateAllVisiblePills() {
    for (const sess of store.getVisibleSessions()) {
      if (sess.sessionId) {
        updateSlotForSession(sess.sessionId);
      }
    }
  }

  function hasActiveSubagents() {
    for (const sess of store.getVisibleSessions()) {
      const cached = sess.sessionId ? store.getCachedSqliteOverview(sess.sessionId) : null;
      if (cached?.overview?.subagents?.runningCount > 0) return true;
      const liveSnap = sess.sessionId ? liveSession.get(sess.sessionId) : null;
      if (liveSnap?.liveSubagents?.some((a) => a.status === "running")) return true;
    }
    return false;
  }

  function hasActiveTurn() {
    for (const sess of store.getVisibleSessions()) {
      if (!sess.sessionId) continue;
      const live = liveSession.get(sess.sessionId);
      if (live.isActiveTurn || live.waitingForUser) return true;
      if (throughput.get(sess.sessionId).phase === "streaming") return true;
    }
    return false;
  }

  function syncTimers() {
    const shouldPoll = openViews.size > 0 || hasActiveSubagents();
    if (shouldPoll && livePollTimer === null) {
      livePollTimer = setLoop(() => {
        void runPollTick();
      }, LIVE_POLL_INTERVAL_MS);
    } else if (!shouldPoll && livePollTimer !== null) {
      clearLoop(livePollTimer);
      livePollTimer = null;
    }

    const shouldTick = hasActiveTurn();
    if (shouldTick && activeTickTimer === null) {
      activeTickTimer = setLoop(() => {
        for (const sess of store.getVisibleSessions()) {
          if (!sess.sessionId) continue;
          const live = liveSession.get(sess.sessionId);
          if (live.isActiveTurn || live.waitingForUser) {
            updateSlotForSession(sess.sessionId);
          }
        }
        if (openViews.size > 0) {
          scheduleViewNotification();
        }
        if (!hasActiveTurn()) {
          syncTimers();
        }
      }, ACTIVE_TICK_INTERVAL_MS);
    } else if (!shouldTick && activeTickTimer !== null) {
      clearLoop(activeTickTimer);
      activeTickTimer = null;
    }
  }

  async function runPollTick() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const targetSessions = new Set();
      for (const sess of store.getVisibleSessions()) {
        if (sess.focused && sess.sessionId) targetSessions.add(sess.sessionId);
      }
      for (const entry of openViews.values()) {
        const sid = store.resolveSessionId(entry.view.sessionId);
        if (sid) targetSessions.add(sid);
      }
      if (targetSessions.size === 0) {
        const fallback = store.resolveSessionId(null);
        if (fallback) targetSessions.add(fallback);
      }

      for (const sid of targetSessions) {
        await store.refreshSqlite(sid);
        updateSlotForSession(sid);
      }
      if (openViews.size > 0) {
        scheduleViewNotification();
      }
      syncTimers();
    } catch {
    } finally {
      pollInFlight = false;
    }
  }

  function scheduleViewNotification() {
    if (openViews.size === 0 || viewNotifyTimer !== null) return;
    viewNotifyTimer = setTimer(() => {
      viewNotifyTimer = null;
      for (const entry of openViews.values()) {
        try {
          entry.view.notify(SNAPSHOT_RESOURCE_URI);
        } catch {
        }
      }
    }, VIEW_NOTIFY_DEBOUNCE_MS);
  }

  function scheduleSqliteRefresh(sessionId) {
    if (!sessionId) return;
    const prev = sqliteFlushTimers.get(sessionId);
    if (prev !== undefined) clearTimer(prev);
    const timer = setTimer(async () => {
      sqliteFlushTimers.delete(sessionId);
      await store.refreshSqlite(sessionId);
      updateSlotForSession(sessionId);
      scheduleViewNotification();
      syncTimers();
    }, SQLITE_FLUSH_DELAY_MS);
    sqliteFlushTimers.set(sessionId, timer);
  }

  function unsubscribeSession(sessionId) {
    const sub = sessionSubs.get(sessionId);
    if (sub) {
      sessionSubs.delete(sessionId);
      try {
        sub.dispose();
      } catch {
      }
    }
  }

  function clearListSub() {
    if (listSub) {
      const sub = listSub;
      listSub = null;
      try {
        sub.dispose?.();
      } catch {
      }
    }
  }

  function clearAllSessionSubs() {
    clearListSub();
    for (const sessionId of [...sessionSubs.keys()]) {
      unsubscribeSession(sessionId);
    }
  }

  function ensureListSubscription() {
    if (listSub || sessionsReadState === "denied" || !ctx?.sessions?.onDidChangeList) {
      return;
    }

    let subFailed = false;
    const handleListError = (err) => {
      subFailed = true;
      if (isNotGrantedError(err)) {
        sessionsReadState = "denied";
        clearAllSessionSubs();
        scheduleViewNotification();
        return;
      }
      clearListSub();
    };

    try {
      const sub = ctx.sessions.onDidChangeList((ev) => {
        sessionsReadState = "granted";
        const { changedIds } = liveSession.onListChange(ev);
        for (const sid of changedIds) {
          if (liveSession.get(sid).waitingForUser) {
            throughput.markIdle(sid);
          }
          updateSlotForSession(sid);
        }
        if (changedIds.length > 0) {
          scheduleViewNotification();
          syncTimers();
        }
      }, handleListError);

      if (subFailed || sessionsReadState === "denied") {
        sub?.dispose?.();
        return;
      }
      listSub = sub;
    } catch (err) {
      handleListError(err);
    }
  }

  function subscribeSession(sessionId) {
    if (
      !sessionId
      || sessionSubs.has(sessionId)
      || sessionsReadState === "denied"
      || !ctx?.sessions?.onDidChangeConversation
      || !ctx?.sessions?.onDidChangeRows
    ) {
      return;
    }

    let subFailed = false;
    const handleSubError = (err) => {
      subFailed = true;
      if (isNotGrantedError(err)) {
        sessionsReadState = "denied";
        clearAllSessionSubs();
        scheduleViewNotification();
        return;
      }
      unsubscribeSession(sessionId);
    };

    try {
      const convSub = ctx.sessions.onDidChangeConversation(
        { sessionId },
        (ev) => {
          sessionsReadState = "granted";
          const res = liveSession.onConversationChange(ev);
          if (res.becameIdle) {
            throughput.markIdle(sessionId);
            scheduleSqliteRefresh(sessionId);
          }
          updateSlotForSession(sessionId);
          scheduleViewNotification();
          syncTimers();
        },
        handleSubError,
      );

      if (subFailed || sessionsReadState === "denied") {
        convSub?.dispose?.();
        return;
      }

      const rowsSub = ctx.sessions.onDidChangeRows(
        { sessionId },
        (ev) => {
          sessionsReadState = "granted";
          const res = liveSession.onRowsChange(sessionId, ev);
          if (res.waitingForUser) {
            throughput.markIdle(sessionId);
          } else if (res.toolInputTps !== null) {
            throughput.recordStreamSample(sessionId, {
              tps: res.toolInputTps,
              channel: "tool_input",
              toolName: res.toolName,
            });
          }
          updateSlotForSession(sessionId);
          scheduleViewNotification();
          syncTimers();
        },
        handleSubError,
      );

      if (subFailed || sessionsReadState === "denied") {
        convSub?.dispose?.();
        rowsSub?.dispose?.();
        return;
      }

      sessionSubs.set(sessionId, {
        dispose() {
          convSub?.dispose?.();
          rowsSub?.dispose?.();
        },
      });
    } catch (err) {
      handleSubError(err);
    }
  }

  function syncSessionSubscriptions(sessions) {
    ensureListSubscription();
    const activeIds = new Set(
      (sessions || [])
        .filter((s) => s?.sessionId && !s.isDraft)
        .map((s) => s.sessionId),
    );
    for (const existingId of [...sessionSubs.keys()]) {
      if (!activeIds.has(existingId)) {
        unsubscribeSession(existingId);
      }
    }
    for (const id of activeIds) {
      subscribeSession(id);
    }
  }

  async function hydrateSession(sessionId) {
    if (!sessionId) return;
    await store.refreshSqlite(sessionId);
    await contextXray.refresh(ctx, sessionId);
    updateSlotForSession(sessionId);
    scheduleViewNotification();
    syncTimers();
  }

  function handleVisibleSessions(sessions) {
    const previousIds = new Set(store.getVisibleSessions().map((s) => s.sessionId));
    store.setVisibleSessions(sessions);
    syncSessionSubscriptions(sessions);
    for (const sess of store.getVisibleSessions()) {
      if (!sess.sessionId) continue;
      updateSlotForSession(sess.sessionId);
      if (!previousIds.has(sess.sessionId)) {
        void hydrateSession(sess.sessionId);
      }
    }
    scheduleViewNotification();
    syncTimers();
  }

  if (ctx?.models?.onDidGenerate) {
    disposables.push(
      ctx.models.onDidGenerate((event) => {
        if (!event?.sessionId) return;
        throughput.recordEvent(event);
        if (event.phase === "streaming") {
          liveSession.noteModelChunk(event.sessionId);
        } else if (event.phase === "final") {
          const res = liveSession.noteModelFinal(event.sessionId);
          if (res.becameIdle) {
            throughput.markIdle(event.sessionId);
          }
          scheduleSqliteRefresh(event.sessionId);
        }
        updateSlotForSession(event.sessionId);
        scheduleViewNotification();
        syncTimers();
      }),
    );
  }

  if (ctx?.context?.onDidChange) {
    disposables.push(
      ctx.context.onDidChange(async (event) => {
        if (!event?.sessionId) return;
        await contextXray.refresh(ctx, event.sessionId);
        updateSlotForSession(event.sessionId);
        scheduleViewNotification();
      }),
    );
  }

  if (ctx?.workbench?.onDidChange) {
    disposables.push(
      ctx.workbench.onDidChange((event) => {
        handleVisibleSessions(event?.sessions || []);
      }),
    );
  }

  if (ctx?.commands?.register) {
    disposables.push(
      ctx.commands.register("open-dashboard", async ({ scope }) => {
        await ctx.views.open("dashboard", toViewOpenScope(scope));
      }),
    );

    disposables.push(
      ctx.commands.register("pill-click", async ({ scope }) => {
        const action = store.getPrefs().pillClickAction;
        if (action === "cycle-mode") {
          const current = store.getPrefs().pillMode;
          await store.updatePrefs({ pillMode: getNextPillMode(current) });
          updateAllVisiblePills();
          scheduleViewNotification();
          return;
        }
        await ctx.views.open("dashboard", toViewOpenScope(scope));
      }),
    );

    disposables.push(
      ctx.commands.register("cycle-pill-mode", async () => {
        const current = store.getPrefs().pillMode;
        await store.updatePrefs({ pillMode: getNextPillMode(current) });
        updateAllVisiblePills();
        scheduleViewNotification();
      }),
    );

    disposables.push(
      ctx.commands.register("toggle-pill", async () => {
        const current = store.getPrefs().pillVisible;
        await store.updatePrefs({ pillVisible: !current });
        updateAllVisiblePills();
        scheduleViewNotification();
      }),
    );
  }

  if (ctx?.views?.register) {
    disposables.push(
      ctx.views.register("dashboard", {
        entry: "views/dashboard.html",
        tools: {
          get_snapshot: {
            description: "Return live and historical telemetry snapshot for the active session.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: { type: "string" },
                range: { type: "string", enum: ["session", "today", "7d", "all"] },
                forceSqlite: { type: "boolean" },
              },
            },
            run: async (args, callCtx) => {
              const entry = openViews.get(callCtx?.view?.id);
              const range = args?.range || entry?.range || store.getPrefs().range;
              if (entry && args?.range) entry.range = args.range;
              const targetSessionId = args?.sessionId || callCtx?.view?.sessionId || null;
              if (targetSessionId) {
                await contextXray.refresh(ctx, targetSessionId);
              }
              const snap = await store.buildSnapshot({
                sessionId: targetSessionId,
                range,
                forceSqlite: Boolean(args?.forceSqlite),
              });
              syncTimers();
              return snap;
            },
          },
          set_preferences: {
            description: "Update Telemetry HUD preferences such as smoothing, pill mode, click action, view mode, theme, or range.",
            inputSchema: {
              type: "object",
              properties: {
                pillVisible: { type: "boolean" },
                pillMode: { type: "string", enum: ["compact", "detailed", "minimal"] },
                pillClickAction: { type: "string", enum: ["open-hud", "cycle-mode"] },
                smoothing: { type: "boolean" },
                range: { type: "string", enum: ["session", "today", "7d", "all"] },
                contextWarnPct: { type: "number" },
                viewMode: { type: "string", enum: ["compact", "full"] },
                theme: { type: "string", enum: ["mono", "amber", "crt"] },
              },
            },
            run: async (args, callCtx) => {
              const prefs = await store.updatePrefs(args);
              const entry = openViews.get(callCtx?.view?.id);
              if (entry && args?.range) entry.range = prefs.range;
              updateAllVisiblePills();
              scheduleViewNotification();
              return store.buildSnapshot({
                sessionId: callCtx?.view?.sessionId || null,
                range: entry?.range || prefs.range,
                forceSqlite: true,
              });
            },
          },
          request_grants: {
            description: "Request sessions.read permission from ZCode so Telemetry HUD can track idle 0 t/s and live Edit streaming.",
            inputSchema: {
              type: "object",
              properties: {},
            },
            run: async (_args, callCtx) => {
              if (ctx?.grants?.request) {
                const res = await ctx.grants.request();
                if (Array.isArray(res?.granted) && res.granted.includes("sessions.read")) {
                  sessionsReadState = "granted";
                  syncSessionSubscriptions(store.getVisibleSessions());
                  updateAllVisiblePills();
                  scheduleViewNotification();
                }
              }
              return store.buildSnapshot({
                sessionId: callCtx?.view?.sessionId || null,
                forceSqlite: true,
              });
            },
          },
          export_ascii_report: {
            description: "Format current telemetry snapshot as a plain-text ASCII report.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: { type: "string" },
                range: { type: "string", enum: ["session", "today", "7d", "all"] },
              },
            },
            run: async (args, callCtx) => {
              const entry = openViews.get(callCtx?.view?.id);
              const range = args?.range || entry?.range || store.getPrefs().range;
              const snapshot = await store.buildSnapshot({
                sessionId: args?.sessionId || callCtx?.view?.sessionId || null,
                range,
                forceSqlite: true,
              });
              return { report: formatAsciiReport(snapshot) };
            },
          },
        },
        resources: {
          [SNAPSHOT_RESOURCE_URI]: {
            mimeType: "application/json",
            read: async ({ view }) => {
              const entry = openViews.get(view?.id);
              const snapshot = await store.buildSnapshot({
                sessionId: view?.sessionId || null,
                range: entry?.range || store.getPrefs().range,
              });
              return JSON.stringify(snapshot);
            },
          },
        },
        onDidOpen(view) {
          const prevCloseSub = viewCloseSubs.get(view.id);
          if (prevCloseSub) {
            viewCloseSubs.delete(view.id);
            try {
              prevCloseSub.dispose?.();
            } catch {
            }
          }
          const entry = { view, range: store.getPrefs().range };
          openViews.set(view.id, entry);
          const sub = view.onDidClose(() => {
            openViews.delete(view.id);
            const stored = viewCloseSubs.get(view.id);
            if (stored) {
              viewCloseSubs.delete(view.id);
              try {
                stored.dispose?.();
              } catch {
              }
            }
            syncTimers();
          });
          viewCloseSubs.set(view.id, sub);

          const sessionId = store.resolveSessionId(view.sessionId);
          if (sessionId) {
            void hydrateSession(sessionId);
          } else {
            syncTimers();
          }
        },
      }),
    );
  }

  if (ctx?.workbench?.visibleSessions) {
    try {
      const initial = await ctx.workbench.visibleSessions();
      handleVisibleSessions(initial);
    } catch (err) {
      ctx?.log?.warn?.("visibleSessions failed", err instanceof Error ? err.message : String(err));
    }
  }

  activeRuntime = {
    dispose() {
      clearAllSessionSubs();
      if (activeTickTimer !== null) {
        clearLoop(activeTickTimer);
        activeTickTimer = null;
      }
      if (livePollTimer !== null) {
        clearLoop(livePollTimer);
        livePollTimer = null;
      }
      if (viewNotifyTimer !== null) {
        clearTimer(viewNotifyTimer);
        viewNotifyTimer = null;
      }
      for (const timer of sqliteFlushTimers.values()) {
        clearTimer(timer);
      }
      sqliteFlushTimers.clear();
      for (const sub of viewCloseSubs.values()) {
        try {
          sub?.dispose?.();
        } catch {
        }
      }
      viewCloseSubs.clear();
      openViews.clear();
      while (disposables.length) {
        const d = disposables.pop();
        try {
          d?.dispose?.();
        } catch {
        }
      }
    },
  };

  ctx?.log?.info?.("Telemetry HUD 0.3.3 activated");
  return activeRuntime;
}

export function deactivate() {
  if (activeRuntime) {
    activeRuntime.dispose();
    activeRuntime = null;
  }
}
