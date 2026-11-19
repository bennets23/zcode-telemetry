# ZCode Telemetry HUD

Zero-dependency, emoji-free ZCode desktop extension (`engines.zcode: ^1.4.0`) that surfaces live generation throughput (including `Edit`/`Write` code-edit streaming), true `0 t/s` idle detection, stall/rate-limit wait detection, calibrated context window proportions with turn runway, cross-provider prompt cache efficiency and `In:Out` ratio, live + SQLite subagent tracing, turn time budgets, tool latency/output byte profiling, and model benchmarks (`P50`/`P95 TTFT` and error rate) without patching `app.asar` or modifying `~/.zcode`.

## Architecture

- **Live Model & Row Streams (`models.onDidGenerate` + `sessions.read`)**:
  - Combines `models.onDidGenerate` with `sessions.onDidChangeConversation` and `sessions.onDidChangeRows` (`protocols: { sessions: 1, rows: 4 }`).
  - Measures live `toolCall` `inputText` streaming during `Edit`/`Write` (`status: "inputStreaming"`), detects true `0 t/s` idle state (with graceful fallback when `sessions.read` is not granted), surfaces active tool/approval/wait states (`THINK`, `TEXT`, `EDIT`, `BASH`, `WAIT 18s`), and rejects buffered micro-bursts (`> 800 t/s`, `< 20` tokens, `< 300ms` decode) via a 3-sample median filter + EMA (`alpha = 0.22`).
- **Calibrated Context X-Ray (`context.get` / `context.onDidChange`)**:
  - Calibrates `draft-preview` estimates against prior provider token ratios (or SQLite `model_usage.input_tokens`), normalizes category shares to sum to `100%`, and estimates remaining turns (`runway`) until 85% compaction threshold.
- **Read-Only SQLite & Subagent Tracer (`~/.zcode/cli/db/db.sqlite`)**:
  - Uses cross-platform read-only `node:sqlite` (`DatabaseSync` with `readOnly: true`) with an automatic `sqlite3 -readonly -json` CLI fallback across `model_usage`, `turn_usage`, `tool_usage`, and child `session` rows (`parent_id`).
  - Reconciles OpenAI/Z.ai inclusive vs. Anthropic exclusive prompt cache accounting (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) via `provider_total_tokens`, tracks tool `output_bytes`, and reports `P50`/`P95 TTFT` plus retry/error rates.
- **UI Surfaces**:
  - `composer.status` pill (`live-pill`): Compact <=19-char readout (`* 148 t/s | 51%`, `WAIT 18s | 51%`, `0 t/s | 51% | 1A`) with rich hover tooltip and configurable click action (`open-hud` or `cycle-mode`).
  - `sidePane.launcher` view (`dashboard`): Monochrome/retro (`MONO`, `AMBER`, `CRT`) HTML/CSS/SVG instrument panel with **Compact** default and 1-click **Full** mode.

## Project Layout

```text
zcode-telemetry/
|-- LICENSE
|-- README.md
|-- marketplace.json
|-- plugins/
|   \-- telemetry-hud/
|       |-- .zcode-plugin/plugin.json
|       |-- src/
|       |   |-- extension.mjs
|       |   |-- state-store.mjs
|       |   |-- formatters.mjs
|       |   \-- modules/
|       |       |-- live-session.mjs
|       |       |-- throughput.mjs
|       |       |-- context-xray.mjs
|       |       \-- sqlite-stats.mjs
|       \-- views/
|           \-- dashboard.html
\-- test/
    |-- context-xray.test.mjs
    |-- extension.test.mjs
    |-- formatters.test.mjs
    |-- live-session.test.mjs
    |-- sqlite-stats.test.mjs
    \-- throughput.test.mjs
```

## Installing & Updating in ZCode

```bash
git clone https://github.com/bennets23/zcode-telemetry.git
```

1. In ZCode, open **Plugin Marketplace -> Add -> Add Plugin Marketplace** and select your cloned `zcode-telemetry` folder.
2. Install **Telemetry HUD** under **zcode-telemetry**.
3. To update after pulling changes: refresh `zcode-telemetry` under **Marketplace Sources**, then click **Update**.
4. Approve the one-time **`sessions.read`** permission prompt (either on activation/update or via `[GRANT]` inside the HUD) for `0 t/s` idle transitions, `Edit`/`Write` live streaming, and real-time subagent rows.

## Tests

```bash
node --test test/*.test.mjs
```

## License

MIT - see [LICENSE](./LICENSE).
