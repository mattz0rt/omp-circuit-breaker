# omp-error-circuit-breaker

Pause a running **Oh My Pi** (`omp`) / **Pi** session from making additional model calls once a configurable number of server errors is seen.

No existing `omp`/`pi` plugin on `npm`/`pi.dev` does this (checked `pi.dev/packages`, `npmjs`, GitHub `can1357/oh-my-pi` issues/Discuss on 2026-08-20 — closest is retry/fallback, not a circuit breaker). This fills that gap.

## What it does

- Counts provider errors **per-prompt** (ephemeral, same `threshold` each prompt):
  - `after_provider_response` with HTTP status matching `OMP_ERROR_BREAKER_STATUS_CODES` (default `400-599`; `0` = network failure also counts)
  - `auto_retry_start` for non-HTTP failures (parse/network/streaming)
  - Deduped 750 ms cross-source so one retry saga isn't double-counted
- On success (2xx) the consecutive counter resets within the same prompt (set `OMP_ERROR_BREAKER_COUNT_MODE=total` to count all errors in prompt).
- Optional sliding window: `OMP_ERROR_BREAKER_WINDOW_MS`.
- When `count >= threshold` (default `3`) **within that prompt**:
  - `ctx.abort()` — stops the in-flight turn
  - `ui.notify()` + `ui.setStatus()` + `ui.setWidget()` — visible pause banner
  - `before_provider_request` keeps aborting remaining calls in **that prompt**

State is per-session + per-prompt (`sessionManager.getSessionId()` + `before_agent_start`), so one session/prompt tripping doesn't affect another.

## Install

### Local (this repo)

```bash
# run with the extension for one session
omp --extension ./extensions/omp-error-circuit-breaker/index.ts

# or with Bun's jiti auto-transpile, any session:
omp --extension ./extensions/omp-error-circuit-breaker/index.ts "your prompt"
```

### Global (auto-load every session)

```bash
mkdir -p ~/.omp/agent/extensions
cp ./extensions/omp-error-circuit-breaker/index.ts ~/.omp/agent/extensions/error-circuit-breaker.ts
# or symlink:
ln -s $(pwd)/extensions/omp-error-circuit-breaker/index.ts ~/.omp/agent/extensions/error-circuit-breaker.ts
```

### As an `omp` plugin (npm publishable)

```bash
# publish (maintainer)
npm publish ./extensions/omp-error-circuit-breaker

# install
omp plugin install omp-error-circuit-breaker
```

Package is `type: module`, entry `index.ts` — `omp`'s jiti handles TS directly, no build step.

## Configuration

Priority: **flag** > **env** > **default**.

| Setting | Env | Flag | Default | Notes |
|---|---|---|---|---|
| Threshold | `OMP_ERROR_BREAKER_THRESHOLD` | `--error-breaker-threshold=3` | `3` | 1..100 |
| Statuses that count | `OMP_ERROR_BREAKER_STATUS_CODES` | `--error-breaker-status-codes=400-599` | `400-599` | csv/range, e.g. `429,500-599` or `all`/`*` |
| Count mode | `OMP_ERROR_BREAKER_COUNT_MODE` | — | `consecutive` | `consecutive` resets on 2xx; `total` never resets |
| Sliding window | `OMP_ERROR_BREAKER_WINDOW_MS` | `--error-breaker-window-ms=0` | `0` (off) | errors older than window fall off |
| Auto-resume | `OMP_ERROR_BREAKER_COOLDOWN_MS` | `--error-breaker-cooldown-ms=0` | `0` (manual) | ms after trip to auto-resume |
| Toast on each error | `OMP_ERROR_BREAKER_NOTIFY_EACH` | — | `0` | `1` = notify each error |

```bash
# env examples
OMP_ERROR_BREAKER_THRESHOLD=5 OMP_ERROR_BREAKER_STATUS_CODES=429,500-599 omp
OMP_ERROR_BREAKER_WINDOW_MS=60000 OMP_ERROR_BREAKER_COOLDOWN_MS=30000 omp
OMP_ERROR_BREAKER_COUNT_MODE=total omp
OMP_ERROR_BREAKER_NOTIFY_EACH=1 omp --extension ./extensions/omp-error-circuit-breaker/index.ts
```

## Commands

Both names work: `/error-breaker` and `/circuit-breaker` (no `resume`/`reset` — per-prompt).

```
/error-breaker status          # show config + counts (default when bare)
/error-breaker pause           # manually trip for testing
/error-breaker config 5        # set threshold for this process (writes env)
```

## How pause works

`before_provider_request` is *before* the fetch is sent. When tripped it calls `ctx.abort()` immediately and throttles the warning to once per 2 s. The fetch's `AbortSignal` is already aborted, so the request is cancelled before the body streams. The TUI stays in the session just stopped — you can inspect, then send a new prompt.
## Offline / tests

Provider listeners are pure — no network/file writes. The mock-provider test harness below can be run without credentials:

```ts
// inject via SimpleStreamOptions.onResponse style in a unit test
// or drive the extension with two synthetic after_provider_response events
// threshold=2 should trip on the second 500.
```

## Limitations

- `before_provider_request` cannot *replace* the request with a synthetic success; it can only abort. One extra request may have been created before abort takes effect in a tight agentic loop — the next one is blocked.
- `retry` auto-retry is not disabled process-wide; the breaker works above it by aborting the saga.
- Per-process `Map` state — restarting `omp` resets counts (use `OMP_ERROR_BREAKER_COUNT_MODE=total` + persistent store if you need cross-restart).

## License

MIT
