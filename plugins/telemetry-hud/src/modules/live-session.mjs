import { MAX_PLAUSIBLE_TPS } from "./throughput.mjs";

const DEFAULT_CHARS_PER_TOKEN = 3.8;
const DEFAULT_STALL_THRESHOLD_MS = 8000;
const EDIT_WINDOW_MS = 2000;
const MIN_EDIT_SPAN_MS = 350;
const MAX_TRACKED_SESSIONS = 64;
const MAX_ROW_LENGTHS = 2000;

const ACTIVE_PHASES = new Set(["running", "prewarming"]);
const QUESTION_TOOL_RE = /^(?:ask_?user_?question|ask_?question|ask_?user)$/i;

export function isQuestionTool(toolName) {
  return QUESTION_TOOL_RE.test(String(toolName || "").trim());
}

export function shortToolLabel(toolName) {
  const name = String(toolName || "").trim();
  if (!name) return "TOOL";
  if (isQuestionTool(name)) return "ASK";
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "EDIT";
  if (name === "Write") return "WRITE";
  if (name === "Bash") return "BASH";
  if (name === "Read" || name === "Grep" || name === "Glob") return "READ";
  if (name === "Agent") return "AGENT";
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "TOOL";
}

function createEmptyEntry(sessionId) {
  return {
    sessionId,
    conversationPhase: null,
    isActiveTurn: false,
    turnStartedAt: null,
    lastChunkAt: null,
    needsAttention: false,
    attentionSinceAt: null,
    activity: { kind: "idle", label: "IDLE", toolName: null, sinceAt: 0 },
    rowLengths: new Map(),
    editWindow: [],
    liveSubagents: new Map(),
  };
}

function setRowLength(entry, rowId, len) {
  if (entry.rowLengths.has(rowId)) {
    entry.rowLengths.delete(rowId);
  } else if (entry.rowLengths.size >= MAX_ROW_LENGTHS) {
    const oldestKey = entry.rowLengths.keys().next().value;
    if (oldestKey !== undefined) entry.rowLengths.delete(oldestKey);
  }
  entry.rowLengths.set(rowId, len);
}

function cleanSummary(text) {
  return String(text || "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

export function createLiveSessionTracker(options = {}) {
  const charsPerToken = typeof options.charsPerToken === "number" && options.charsPerToken > 0
    ? options.charsPerToken
    : DEFAULT_CHARS_PER_TOKEN;
  const stallThresholdMs = typeof options.stallThresholdMs === "number" && options.stallThresholdMs > 0
    ? options.stallThresholdMs
    : DEFAULT_STALL_THRESHOLD_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  const entries = new Map();

  function getOrCreate(sessionId) {
    let entry = entries.get(sessionId);
    if (entry) {
      entries.delete(sessionId);
      entries.set(sessionId, entry);
      return entry;
    }
    if (entries.size >= MAX_TRACKED_SESSIONS) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
    entry = createEmptyEntry(sessionId);
    entries.set(sessionId, entry);
    return entry;
  }

  function isEntryWaitingForUser(entry) {
    return entry.needsAttention || entry.activity.kind === "question" || entry.activity.kind === "approval";
  }

  function snapshot(entry) {
    const ts = now();
    const turnElapsedMs = entry.isActiveTurn && entry.turnStartedAt !== null
      ? Math.max(0, ts - entry.turnStartedAt)
      : 0;

    const waitingForUser = isEntryWaitingForUser(entry);
    const waitAnchor = (entry.activity.kind === "question" || entry.activity.kind === "approval")
      ? (entry.activity.sinceAt || entry.attentionSinceAt)
      : entry.attentionSinceAt;
    const userWaitMs = waitingForUser && waitAnchor != null ? Math.max(0, ts - waitAnchor) : 0;

    let stalledWaitMs = 0;
    if (
      entry.isActiveTurn
      && !waitingForUser
      && entry.activity.kind !== "tool_running"
    ) {
      const waitRef = entry.lastChunkAt ?? entry.turnStartedAt;
      if (waitRef !== null) {
        const elapsed = Math.max(0, ts - waitRef);
        if (elapsed >= stallThresholdMs) {
          stalledWaitMs = elapsed;
        }
      }
    }

    return {
      sessionId: entry.sessionId,
      conversationPhase: entry.conversationPhase,
      isActiveTurn: entry.isActiveTurn,
      isIdle: entry.conversationPhase !== null && !entry.isActiveTurn,
      needsAttention: entry.needsAttention,
      waitingForUser,
      userWaitMs,
      turnStartedAt: entry.turnStartedAt,
      turnElapsedMs,
      lastChunkAt: entry.lastChunkAt,
      stalledWaitMs,
      activity: { ...entry.activity },
      liveSubagents: [...entry.liveSubagents.values()].map((s) => ({ ...s })),
    };
  }

  function upsertSubagentRow(entry, row) {
    const key = row.childSessionId || `row_${row.rowId}`;
    entry.liveSubagents.set(key, {
      id: key,
      childSessionId: row.childSessionId ? String(row.childSessionId) : null,
      parentToolCallId: row.parentToolCallId ? String(row.parentToolCallId) : null,
      subagentType: String(row.subagentType || "subagent"),
      status: String(row.status || "running"),
      summaryText: cleanSummary(row.summaryText),
      backgrounded: row.backgrounded === true,
      startedAt: typeof row.startedAt === "number" ? row.startedAt : null,
      endedAt: typeof row.endedAt === "number" ? row.endedAt : null,
    });
  }

  function seedActivityFromRows(entry, rows, ts) {
    if (!entry.isActiveTurn || !Array.isArray(rows)) return;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row || typeof row !== "object") continue;
      if (row.kind === "toolCall") {
        if (row.status === "pendingApproval") {
          entry.activity = { kind: "approval", label: "APPROVE", toolName: row.toolName || null, sinceAt: ts };
          return;
        }
        if (row.status === "running") {
          if (isQuestionTool(row.toolName)) {
            entry.activity = { kind: "question", label: "ASK", toolName: row.toolName || null, sinceAt: ts };
            return;
          }
          entry.activity = { kind: "tool_running", label: `TOOL:${row.toolName || "tool"}`, toolName: row.toolName || null, sinceAt: ts };
          return;
        }
        if (row.status === "inputStreaming") {
          entry.activity = { kind: "tool_input", label: shortToolLabel(row.toolName), toolName: row.toolName || null, sinceAt: ts };
          return;
        }
      } else if (row.kind === "reasoning" && row.state === "streaming") {
        entry.activity = { kind: "thinking", label: "THINK", toolName: null, sinceAt: ts };
        return;
      } else if (row.kind === "assistantText" && row.state === "streaming") {
        entry.activity = { kind: "text", label: "TEXT", toolName: null, sinceAt: ts };
        return;
      }
    }
  }

  function onConversationChange(event) {
    if (!event || typeof event.sessionId !== "string" || !event.sessionId) {
      return { becameIdle: false, becameActive: false, state: null };
    }
    const entry = getOrCreate(event.sessionId);
    const ts = now();
    const prevActive = entry.isActiveTurn;
    const nextPhase = String(event.phase || "draft");
    const nextActive = ACTIVE_PHASES.has(nextPhase);

    entry.conversationPhase = nextPhase;
    entry.isActiveTurn = nextActive;

    const becameActive = !prevActive && nextActive;
    const becameIdle = prevActive && !nextActive;

    if (becameActive) {
      entry.turnStartedAt = ts;
      entry.lastChunkAt = null;
      entry.editWindow = [];
      if (!entry.needsAttention) {
        entry.activity = { kind: "waiting", label: "WAIT", toolName: null, sinceAt: ts };
      }
    } else if (!nextActive) {
      entry.turnStartedAt = null;
      entry.editWindow = [];
      entry.needsAttention = false;
      entry.attentionSinceAt = null;
      entry.activity = { kind: "idle", label: "IDLE", toolName: null, sinceAt: ts };
    }

    return { becameIdle, becameActive, state: snapshot(entry) };
  }

  function onListChange(event) {
    if (!event || typeof event !== "object") {
      return { changedIds: [] };
    }
    const ts = now();
    const changedIds = new Set();

    const listItems = event.kind === "snapshot" && Array.isArray(event.sessions)
      ? event.sessions
      : (event.kind === "delta" && Array.isArray(event.upserted) ? event.upserted : []);

    for (const item of listItems) {
      const sid = item?.session?.sessionId;
      if (typeof sid !== "string" || !sid) continue;
      const nextAttention = item.status === "needs_attention";
      if (!nextAttention && !entries.has(sid)) continue;

      const entry = getOrCreate(sid);
      if (entry.needsAttention !== nextAttention) {
        entry.needsAttention = nextAttention;
        entry.attentionSinceAt = nextAttention ? ts : null;
        changedIds.add(sid);
        if (nextAttention) {
          entry.editWindow = [];
          if (entry.activity.kind !== "question" && entry.activity.kind !== "approval") {
            entry.activity = { kind: "question", label: "INPUT", toolName: null, sinceAt: ts };
          }
        } else if (entry.activity.kind === "question" && entry.activity.label === "INPUT") {
          entry.activity = entry.isActiveTurn
            ? { kind: "waiting", label: "WAIT", toolName: null, sinceAt: ts }
            : { kind: "idle", label: "IDLE", toolName: null, sinceAt: ts };
          if (entry.isActiveTurn) {
            entry.lastChunkAt = ts;
          }
        }
      }
    }

    if (event.kind === "delta" && Array.isArray(event.removed)) {
      for (const ref of event.removed) {
        const sid = ref?.sessionId;
        if (typeof sid !== "string" || !sid || !entries.has(sid)) continue;
        const entry = entries.get(sid);
        if (entry.needsAttention) {
          entry.needsAttention = false;
          entry.attentionSinceAt = null;
          changedIds.add(sid);
          if (entry.activity.kind === "question" && entry.activity.label === "INPUT") {
            entry.activity = entry.isActiveTurn
              ? { kind: "waiting", label: "WAIT", toolName: null, sinceAt: ts }
              : { kind: "idle", label: "IDLE", toolName: null, sinceAt: ts };
          }
        }
      }
    }

    return { changedIds: [...changedIds] };
  }

  function onRowsChange(sessionId, event) {
    if (!sessionId || !event || typeof event !== "object") {
      return { toolInputTps: null, toolName: null, subagentsChanged: false, waitingForUser: false, state: null };
    }
    const entry = getOrCreate(sessionId);
    const ts = now();

    if (event.kind === "reset") {
      entry.rowLengths.clear();
      entry.editWindow = [];
      entry.liveSubagents.clear();
      const rows = Array.isArray(event.rows) ? event.rows : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        if (row.kind === "toolCall") {
          setRowLength(entry, row.rowId, typeof row.inputText === "string" ? row.inputText.length : 0);
        } else if (row.kind === "reasoning" || row.kind === "assistantText") {
          setRowLength(entry, row.rowId, typeof row.text === "string" ? row.text.length : 0);
        } else if (row.kind === "subagent") {
          upsertSubagentRow(entry, row);
        }
      }
      seedActivityFromRows(entry, rows, ts);
      return {
        toolInputTps: null,
        toolName: null,
        subagentsChanged: entry.liveSubagents.size > 0,
        waitingForUser: isEntryWaitingForUser(entry),
        state: snapshot(entry),
      };
    }

    if (event.kind !== "rows" || !Array.isArray(event.upserted)) {
      return {
        toolInputTps: null,
        toolName: null,
        subagentsChanged: false,
        waitingForUser: isEntryWaitingForUser(entry),
        state: snapshot(entry),
      };
    }

    let toolInputTps = null;
    let activeToolName = null;
    let subagentsChanged = false;

    for (const row of event.upserted) {
      if (!row || typeof row !== "object") continue;

      if (row.kind === "toolCall") {
        const len = typeof row.inputText === "string" ? row.inputText.length : 0;
        const prev = entry.rowLengths.get(row.rowId);
        setRowLength(entry, row.rowId, len);

        if (row.status === "inputStreaming") {
          const delta = prev !== undefined
            ? Math.max(0, len - prev)
            : (len > 0 && len <= 4000 ? len : 0);
          const sameTool = entry.activity.kind === "tool_input" && entry.activity.toolName === row.toolName;
          entry.activity = {
            kind: "tool_input",
            label: shortToolLabel(row.toolName),
            toolName: row.toolName || null,
            sinceAt: sameTool ? entry.activity.sinceAt : ts,
          };

          if (delta > 0) {
            entry.lastChunkAt = ts;
            entry.editWindow.push({ t: ts, chars: delta });
            while (entry.editWindow.length > 0 && ts - entry.editWindow[0].t > EDIT_WINDOW_MS) {
              entry.editWindow.shift();
            }
            if (entry.editWindow.length >= 2) {
              const spanMs = ts - entry.editWindow[0].t;
              if (spanMs >= MIN_EDIT_SPAN_MS) {
                let sumChars = 0;
                for (let k = 1; k < entry.editWindow.length; k++) {
                  sumChars += entry.editWindow[k].chars;
                }
                const tps = (sumChars / charsPerToken) / (spanMs / 1000);
                if (Number.isFinite(tps) && tps > 0 && tps <= MAX_PLAUSIBLE_TPS) {
                  toolInputTps = tps;
                  activeToolName = row.toolName || null;
                }
              }
            }
          }
        } else if (row.status === "running") {
          entry.editWindow = [];
          if (isQuestionTool(row.toolName)) {
            const sameQuestion = entry.activity.kind === "question" && entry.activity.toolName === row.toolName;
            entry.activity = {
              kind: "question",
              label: "ASK",
              toolName: row.toolName || null,
              sinceAt: sameQuestion ? entry.activity.sinceAt : ts,
            };
          } else {
            const sameTool = entry.activity.kind === "tool_running" && entry.activity.toolName === row.toolName;
            entry.activity = {
              kind: "tool_running",
              label: `TOOL:${row.toolName || "tool"}`,
              toolName: row.toolName || null,
              sinceAt: sameTool ? entry.activity.sinceAt : ts,
            };
          }
        } else if (row.status === "pendingApproval") {
          entry.editWindow = [];
          const sameApproval = entry.activity.kind === "approval" && entry.activity.toolName === row.toolName;
          entry.activity = {
            kind: "approval",
            label: "APPROVE",
            toolName: row.toolName || null,
            sinceAt: sameApproval ? entry.activity.sinceAt : ts,
          };
        } else {
          entry.editWindow = [];
          if (entry.isActiveTurn && entry.activity.toolName === row.toolName) {
            entry.activity = entry.needsAttention
              ? { kind: "question", label: "INPUT", toolName: null, sinceAt: entry.attentionSinceAt || ts }
              : { kind: "waiting", label: "WAIT", toolName: null, sinceAt: ts };
            entry.lastChunkAt = ts;
          }
        }
      } else if (row.kind === "reasoning") {
        const len = typeof row.text === "string" ? row.text.length : 0;
        const prev = entry.rowLengths.get(row.rowId);
        setRowLength(entry, row.rowId, len);
        if (row.state === "streaming") {
          if (prev === undefined || len > prev) entry.lastChunkAt = ts;
          entry.activity = {
            kind: "thinking",
            label: "THINK",
            toolName: null,
            sinceAt: entry.activity.kind === "thinking" ? entry.activity.sinceAt : ts,
          };
        }
      } else if (row.kind === "assistantText") {
        const len = typeof row.text === "string" ? row.text.length : 0;
        const prev = entry.rowLengths.get(row.rowId);
        setRowLength(entry, row.rowId, len);
        if (row.state === "streaming") {
          if (prev === undefined || len > prev) entry.lastChunkAt = ts;
          entry.activity = {
            kind: "text",
            label: "TEXT",
            toolName: null,
            sinceAt: entry.activity.kind === "text" ? entry.activity.sinceAt : ts,
          };
        }
      } else if (row.kind === "subagent") {
        upsertSubagentRow(entry, row);
        subagentsChanged = true;
      }
    }

    return {
      toolInputTps,
      toolName: activeToolName,
      subagentsChanged,
      waitingForUser: isEntryWaitingForUser(entry),
      state: snapshot(entry),
    };
  }

  function noteModelChunk(sessionId) {
    if (!sessionId) return;
    const entry = getOrCreate(sessionId);
    entry.lastChunkAt = now();
    if (!entry.isActiveTurn) {
      entry.isActiveTurn = true;
      if (entry.turnStartedAt === null) entry.turnStartedAt = entry.lastChunkAt;
    }
  }

  function noteModelFinal(sessionId) {
    if (!sessionId) {
      return { becameIdle: false, state: null };
    }
    const entry = getOrCreate(sessionId);
    const ts = now();
    entry.lastChunkAt = ts;
    if (entry.conversationPhase === null) {
      entry.isActiveTurn = false;
      entry.turnStartedAt = null;
      entry.editWindow = [];
      entry.needsAttention = false;
      entry.attentionSinceAt = null;
      entry.activity = { kind: "idle", label: "IDLE", toolName: null, sinceAt: ts };
      return { becameIdle: true, state: snapshot(entry) };
    }
    return { becameIdle: false, state: snapshot(entry) };
  }

  function get(sessionId) {
    if (!sessionId) return snapshot(createEmptyEntry(""));
    const entry = entries.get(sessionId);
    return entry ? snapshot(entry) : snapshot(createEmptyEntry(sessionId));
  }

  function clear(sessionId) {
    entries.delete(sessionId);
  }

  return {
    onConversationChange,
    onListChange,
    onRowsChange,
    noteModelChunk,
    noteModelFinal,
    get,
    clear,
  };
}
