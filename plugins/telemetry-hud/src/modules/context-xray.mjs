const CATEGORY_LABELS = {
  system_prompt: "System prompt",
  meta_user_context: "Meta context",
  skills: "Skills",
  tool_prompt: "Tool prompt",
  system_tool_schemas: "System tools",
  mcp_tool_schemas: "MCP tools",
  app_tool_schemas: "App tools",
  deferred_tool_schemas: "Deferred tools",
  reminders: "Reminders",
  compact_summary: "Compact summary",
  messages: "Messages",
};

const MIN_CALIBRATION_RATIO = 0.3;
const MAX_CALIBRATION_RATIO = 1.4;
const MAX_TRACKED_SESSIONS = 64;

function roundOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function positiveNum(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function setBounded(map, key, value, limit = MAX_TRACKED_SESSIONS) {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= limit) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

export function computeContextRunway({ usedTokens, contextWindow, tokensPerTurn, warnPct = 85 } = {}) {
  const win = positiveNum(contextWindow);
  const perTurn = positiveNum(tokensPerTurn);
  if (win === null || perTurn === null) return null;

  const used = typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0
    ? usedTokens
    : 0;
  const warnThresholdTokens = Math.round(win * (warnPct / 100));
  const tokensToWarn = Math.max(0, warnThresholdTokens - used);
  const estTurnsLeft = tokensToWarn === 0 ? 0 : Math.max(0, Math.floor(tokensToWarn / perTurn));

  return {
    warnPct,
    warnThresholdTokens,
    tokensToWarn,
    tokensPerTurn: Math.round(perTurn),
    estTurnsLeft,
  };
}

export function normalizeComposition(raw, calibration = null) {
  if (!raw || typeof raw !== "object") return null;

  const rawWindow = positiveNum(raw.model?.contextWindow);
  const contextWindow = rawWindow
    ?? positiveNum(calibration?.lastContextWindow)
    ?? positiveNum(calibration?.fallbackContextWindow)
    ?? null;

  const estimatedTokens = typeof raw.estimatedTokens === "number" && raw.estimatedTokens >= 0
    ? raw.estimatedTokens
    : 0;
  const providerInputTokens = positiveNum(raw.providerInputTokens);
  const providerContextTokens = positiveNum(raw.providerContextTokens);
  const explicitProviderTokens = providerContextTokens ?? providerInputTokens;

  let usedTokens;
  let calibrated = false;
  if (explicitProviderTokens !== null) {
    usedTokens = explicitProviderTokens;
    calibrated = true;
  } else if (calibration?.ratio && estimatedTokens > 0) {
    usedTokens = Math.round(estimatedTokens * calibration.ratio);
    calibrated = true;
  } else if (positiveNum(calibration?.lastProviderTokens) !== null) {
    usedTokens = calibration.lastProviderTokens;
    calibrated = true;
  } else if (positiveNum(calibration?.fallbackInputTokens) !== null) {
    usedTokens = calibration.fallbackInputTokens;
    calibrated = true;
  } else {
    usedTokens = estimatedTokens;
  }

  if (contextWindow !== null && usedTokens > contextWindow && !explicitProviderTokens) {
    usedTokens = contextWindow;
  }

  const freeTokens = contextWindow !== null
    ? Math.max(0, contextWindow - usedTokens)
    : (typeof raw.freeTokens === "number" ? Math.max(0, raw.freeTokens) : null);

  const usedPct = contextWindow && contextWindow > 0
    ? Math.min(100, roundOneDecimal((usedTokens / contextWindow) * 100))
    : null;

  const rawCategories = Array.isArray(raw.categories) ? raw.categories : [];
  const totalCatTokens = rawCategories.reduce(
    (sum, cat) => sum + (typeof cat?.tokens === "number" && cat.tokens > 0 ? cat.tokens : 0),
    0,
  );

  const categories = rawCategories
    .map((cat) => {
      const rawTokens = typeof cat?.tokens === "number" && cat.tokens > 0 ? cat.tokens : 0;
      const chars = typeof cat?.chars === "number" && cat.chars > 0 ? cat.chars : 0;
      const sharePct = totalCatTokens > 0 ? roundOneDecimal((rawTokens / totalCatTokens) * 100) : 0;
      const windowPct = usedPct !== null ? roundOneDecimal((usedPct / 100) * sharePct) : 0;
      const tokens = totalCatTokens > 0 ? Math.round(usedTokens * (rawTokens / totalCatTokens)) : 0;

      return {
        id: String(cat?.id || "unknown"),
        label: CATEGORY_LABELS[cat?.id] || String(cat?.id || "Other"),
        tokens,
        rawTokens,
        chars,
        sharePct,
        windowPct,
        pct: sharePct,
        items: Array.isArray(cat?.items)
          ? cat.items.map((item) => ({
              name: String(item?.name || ""),
              tokens: typeof item?.tokens === "number" ? item.tokens : 0,
            }))
          : [],
      };
    })
    .filter((cat) => cat.rawTokens > 0 || cat.chars > 0)
    .sort((a, b) => b.tokens - a.tokens || b.chars - a.chars);

  return {
    sessionId: String(raw.sessionId || ""),
    revision: typeof raw.revision === "number" ? raw.revision : 0,
    phase: raw.phase === "draft-preview" ? "draft-preview" : "request",
    measuredAt: typeof raw.measuredAt === "number" ? raw.measuredAt : Date.now(),
    providerId: String(raw.model?.providerId || ""),
    modelId: String(raw.model?.modelId || ""),
    contextWindow,
    usedTokens,
    estimatedTokens,
    providerInputTokens,
    providerContextTokens,
    calibrated,
    freeTokens,
    usedPct,
    categories,
  };
}

export function createContextXrayTracker() {
  const cache = new Map();
  const calibrationBySession = new Map();
  const inflight = new Map();

  function getCalibration(sessionId) {
    let entry = calibrationBySession.get(sessionId);
    if (!entry) {
      entry = {
        ratio: null,
        lastProviderTokens: null,
        lastContextWindow: null,
        fallbackInputTokens: null,
        fallbackContextWindow: null,
      };
    }
    setBounded(calibrationBySession, sessionId, entry);
    return entry;
  }

  function updateCalibrationFromRaw(sessionId, raw) {
    if (!sessionId || !raw || typeof raw !== "object") return;
    const cal = getCalibration(sessionId);
    const win = positiveNum(raw.model?.contextWindow);
    if (win !== null) cal.lastContextWindow = win;

    const providerTokens = positiveNum(raw.providerContextTokens) ?? positiveNum(raw.providerInputTokens);
    const est = positiveNum(raw.estimatedTokens);
    if (providerTokens !== null) {
      cal.lastProviderTokens = providerTokens;
      if (est !== null) {
        cal.ratio = clamp(providerTokens / est, MIN_CALIBRATION_RATIO, MAX_CALIBRATION_RATIO);
      }
    }
  }

  function setFallbackBaseline(sessionId, baseline) {
    if (!sessionId || !baseline || typeof baseline !== "object") return;
    const cal = getCalibration(sessionId);
    const inputTokens = positiveNum(baseline.inputTokens);
    const contextWindow = positiveNum(baseline.contextWindow);
    if (inputTokens !== null) cal.fallbackInputTokens = inputTokens;
    if (contextWindow !== null) cal.fallbackContextWindow = contextWindow;

    const existing = cache.get(sessionId);
    if (existing && !existing.calibrated && inputTokens !== null) {
      setBounded(
        cache,
        sessionId,
        normalizeComposition(
          {
            ...existing,
            model: {
              providerId: existing.providerId,
              modelId: existing.modelId,
              contextWindow: existing.contextWindow,
            },
            categories: existing.categories.map((c) => ({
              id: c.id,
              tokens: c.rawTokens ?? c.tokens,
              chars: c.chars,
              items: c.items,
            })),
          },
          cal,
        ),
      );
    }
  }

  function ingest(sessionId, raw) {
    if (!sessionId || !raw) return cache.get(sessionId) ?? null;
    updateCalibrationFromRaw(sessionId, raw);
    const cal = getCalibration(sessionId);
    const normalized = normalizeComposition(raw, cal);
    if (normalized) {
      setBounded(cache, sessionId, normalized);
      return normalized;
    }
    return cache.get(sessionId) ?? null;
  }

  async function refresh(ctx, sessionId) {
    if (!ctx?.context?.get || !sessionId) return cache.get(sessionId) ?? null;
    if (inflight.has(sessionId)) {
      return inflight.get(sessionId);
    }

    const promise = (async () => {
      try {
        const raw = await ctx.context.get({ sessionId });
        return ingest(sessionId, raw);
      } catch {
        return cache.get(sessionId) ?? null;
      } finally {
        inflight.delete(sessionId);
      }
    })();

    inflight.set(sessionId, promise);
    return promise;
  }

  function get(sessionId) {
    return cache.get(sessionId) ?? null;
  }

  function clear(sessionId) {
    cache.delete(sessionId);
    calibrationBySession.delete(sessionId);
  }

  return {
    ingest,
    setFallbackBaseline,
    refresh,
    get,
    clear,
  };
}
