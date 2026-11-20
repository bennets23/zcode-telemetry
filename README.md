# ZCode Telemetry HUD

![Version](https://img.shields.io/badge/version-0.3.3-555555)
![ZCode API](https://img.shields.io/badge/ZCode_API-%5E1.4.0-0969da)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-0969da)
![Dependencies](https://img.shields.io/badge/dependencies-zero-2ea043)
![License](https://img.shields.io/badge/license-MIT-2ea043)

Live tokens-per-second throughput, calibrated context window X-ray, prompt cache efficiency, subagent tracing, and tool/model latency telemetry for ZCode Desktop. Built on ZCode's official Extension API (`engines.zcode: ^1.4.0`) with zero dependencies, zero `app.asar` patching, and strictly read-only local SQLite access.

```text
Composer Pill :  * 148 t/s | 51%   |   WAIT 18s | 51%   |   0 t/s | 51% | 1A

Telemetry HUD :  [IDLE] glm-5.3-flash                    [+ FULL] [MONO] [COPY] [R]
                 0.0 t/s    last 142.6 | med 138.4 | peak 214.0 | ttft 620ms | out 1.4K
                 CONTEXT    51.1%  134K / 262K  (runway: ~7 turns to 85%)
                 SUBAGENTS  1 RUNNING / 2 TOTAL
```

## Features

| Feature | Details |
| :--- | :--- |
| **Live Throughput** | Tracks `models.onDidGenerate` plus live `Edit`/`Write` `inputStreaming`, true `0 t/s` idle and `ASK`/`APPROVE`/`INPUT` user-wait detection, stall `WAIT` alerts (`>= 8s`), and 3-sample median + EMA smoothing (`alpha = 0.22`). |
| **Context X-Ray** | Calibrates `draft-preview` estimates against prior provider token ratios, normalizes category shares to `100%`, and estimates remaining turn `runway` to the 85% threshold. |
| **Subagent Tracer** | Merges real-time `subagent` row events with child SQLite sessions (`parent_id`): state (`RUN`/`DONE`/`ERR`), task, active tool, request/tool counts, output tokens, median `tok/s`, and elapsed time. |
| **Tokens & Cache** | Reconciles OpenAI/Z.ai inclusive and Anthropic exclusive prompt cache accounting via `provider_total_tokens`, surfacing fresh input, cache read/write, reasoning %, and `in:out` ratio. |
| **Turn Budget & Tools** | Breaks latest turn wall time into Decode / Tools / TTFT / Retry-Wait and profiles per-tool calls, avg/max latency, `OUT` byte volume, truncations, and errors. |
| **Model Benchmarks** | Compares models across `session`, `today`, `7d`, and `all` windows with median `tok/s`, `P50`/`P95 TTFT`, error/retry rate (`ERR%`), cache hit %, and output tokens. |
| **Retro HUD & Export** | Compact default + 1-click Full mode, `MONO` / `AMBER` / `CRT` themes, configurable pill click action (`open-hud` or `cycle-mode`), and plain-text ASCII clipboard export. |

## Installation

```bash
git clone https://github.com/bennets23/zcode-telemetry.git
```

1. Open ZCode Desktop -> **Plugin Marketplace -> Add -> Add Plugin Marketplace** and select your cloned `zcode-telemetry` folder.
2. Install **Telemetry HUD** under **zcode-telemetry**.
3. Approve the one-time **`sessions.read`** prompt (or click `[GRANT]` inside the HUD).

### Updating

Pull the latest changes in your cloned folder (`git pull`), refresh **zcode-telemetry** under **Marketplace Sources**, and click **Update**.

## Permissions & Privacy

- **100% Local & Read-Only:** Makes zero network requests and never modifies `app.asar` or `~/.zcode/cli/db/db.sqlite` (reads via `node:sqlite` `DatabaseSync` with `readOnly: true` and automatic `sqlite3 -readonly -json` fallback).
- **`sessions.read` Grant:** Requested once per plugin ID (stored globally by ZCode across new chats and updates). Enables live `Edit`/`Write` code-edit `tok/s`, live `BASH`/`APPROVE`/`WAIT` states, instant `0 t/s` idle detection, and real-time subagent rows. Core throughput, context X-ray, and SQLite stats/benchmarks still run if declined.

## Commands

| Command ID | Title | Description |
| :--- | :--- | :--- |
| `open-dashboard` | Open Telemetry HUD | Always opens the HUD view (you can also reopen it anytime from Side Pane `+` -> **Telemetry HUD** when `CLICK: CYCLE` or `PILL: OFF` is active). |
| `pill-click` | Telemetry Pill Click | Composer pill click target: opens HUD (`CLICK: HUD`) or cycles pill mode (`CLICK: CYCLE`). |
| `cycle-pill-mode` | Cycle Status Pill Mode | Cycles composer pill layout across `compact`, `detailed`, and `minimal`. |
| `toggle-pill` | Toggle Status Pill | Shows or hides the `composer.status` pill item. |

## Development

```text
zcode-telemetry/
|-- LICENSE
|-- README.md
|-- marketplace.json
|-- plugins/telemetry-hud/
|   |-- .zcode-plugin/plugin.json
|   |-- src/
|   |   |-- extension.mjs
|   |   |-- state-store.mjs
|   |   |-- formatters.mjs
|   |   \-- modules/
|   |       |-- live-session.mjs
|   |       |-- throughput.mjs
|   |       |-- context-xray.mjs
|   |       \-- sqlite-stats.mjs
|   \-- views/dashboard.html
\-- test/*.test.mjs
```

Run the test suite (Node built-in test runner, zero external packages):

```bash
node --test test/*.test.mjs
```

## License

MIT - see [LICENSE](./LICENSE).
