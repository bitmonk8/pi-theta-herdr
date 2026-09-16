# @bitmonk8/pi-theta-herdr

## What it is

`@bitmonk8/pi-theta-herdr` is a pi package that registers the `herdr`
subagent placement backend with `@bitmonk8/pi-theta` (RFC 0012 §5, decision
D5). With it loaded, every subagent child pi-theta launches — a `mode:
subagent` slash command, an `invoke(...)` call, a `.theta` callable, a `par
for` iteration, or a `subagent fn` call — opens as a tab in the parent's
Herdr workspace instead of running headless: the tab closes itself when the
child returns `Ok`, and lingers, un-retitled, when it returns `Err` (v0.1.0).
The same repository is the home of the Herdr NDJSON client that pi-config's
`subagent` tool imports (`src/herdr-client.ts`).

## Requirements

- Herdr 0.8.x (API `protocol: 20`, `herdr api schema --json`).
- Pi with `pi.events` (≥ 0.34; verified against 0.80.10 and 0.85.1).
- pi-theta ≥ 0.475.0 — the placement seam, registration protocol
  `apiVersion: 1`.
- Windows: Herdr's control socket is a named pipe
  (`\\.\pipe\<HERDR_SOCKET_PATH>`); the client handles this transparently.

## Install

There is no npm publish for this package. Install it as a git dependency:

```
pi install git:github.com/bitmonk8/pi-theta-herdr
pi install https://github.com/bitmonk8/pi-theta-herdr
```

Try it once, without installing:

```
pi -e git:github.com/bitmonk8/pi-theta-herdr
```

From a local checkout:

```
pi install C:/UnitySrc/pi-theta-herdr
pi -e C:/UnitySrc/pi-theta-herdr
```

pi-config users install nothing directly — the package arrives as one of
pi-config's own dependencies.

## How it works

- **Detection.** `detect()` reads the four pane markers Herdr injects into a
  process it spawns: `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`,
  `HERDR_WORKSPACE_ID`. All four present, or the backend reports itself
  unavailable.
- **Placement.** `place()` issues one `layout.apply` request: an argv spawn,
  a `cwd`, an environment overlay (D4), `tab_label` set to the callee's
  label, `focus: false`, and the parent's `workspace_id` — the child opens as
  a background tab in the same workspace, never stealing focus.
- **Priority and `auto`.** pi-theta's `auto` placement selection orders
  candidate backends and picks `herdr` when its `detect()` succeeds inside a
  Herdr pane, falling back to the built-in `pipe` backend otherwise.
- **Visible tabs.** A cap on simultaneously visible children —
  `theta.subagentPlacementMaxVisible` — keeps a wide `par for` fan-out from
  opening one tab per iteration.
- **`kill()`** issues `pane.close` against the pane Herdr assigned to the
  child.
- **Exit and lifecycle.** `Ok` closes the child's own tab; `Err` leaves the
  tab open and un-retitled in v0.1.0 so its output stays inspectable. The
  backend reports `observesExit: false`: pi-theta settles the child from its
  own loopback result channel rather than from process exit, with a
  heartbeat-silence budget of 30 seconds, so a lingering `Err` tab is never
  torn down by teardown logic.
- **Environment overlay (D4).** The child inherits the parent's environment
  plus an overlay of string-valued variables the caller supplied; Herdr's own
  pane injection (`HERDR_PANE_ID`, etc.) always wins for the child's own
  identity.

## Settings

This package defines no settings of its own. It responds to pi-theta's:

- `theta.subagentPlacement: "herdr"` — pin the backend; outside a Herdr pane
  this fails closed with `theta/load/subagent-placement-unavailable`.
- `theta.subagentPlacement: "auto"` — the default; `herdr` is chosen when
  detected, otherwise `pipe`.
- `theta.subagentPlacementMaxVisible` — cap on visible tabs (default 8).
- `PI_THETA_SUBAGENT_PLACEMENT` — a one-run environment override of the
  setting (e.g. `PI_THETA_SUBAGENT_PLACEMENT=pipe` to force headless for a
  single invocation).

## Using the client from another extension

pi-config's `subagent` tool imports the client directly from its deep path:

```ts
import { firstPaneId, herdrEnv, herdrRequest } from "@bitmonk8/pi-theta-herdr/src/herdr-client.ts";
```

The four pi-config-compatible functions are `herdrEnv`, `herdrEndpoint`,
`herdrRequest`, and `firstPaneId`; `createHerdrClient` builds an injectable
client for tests and alternate transports. Every rejection surfaces as a
`HerdrRequestError` whose `kind` names the failure (`not-in-pane`,
`unreachable`, `timeout`, `closed`, `unparseable`, `refused`,
`unexpected-result`) and whose `message` matches the text pi-config's
original inline implementation threw for the same condition.

## Development

- `npm test` — the default, offline suite (`vitest.config.ts`); network-free
  and deterministic.
- `npm run test:herdr` — opt-in; requires a running Herdr daemon and this
  process to sit in a Herdr pane (`config/vitest/vitest.herdr.config.ts`).
  Run it whenever the client or backend changes.
- `npm run typecheck` — `tsc -p tsconfig.json --noEmit`.

Neither suite silently skips: a missing pane environment fails the opt-in
suite loudly, naming the missing variable, rather than returning early or
marking a test skipped.

## Troubleshooting

- **No tab appears.** Confirm the four `HERDR_*` variables are set in the
  parent pi process's environment. `/theta-status` should read `live in
  herdr <pane>` for the child while it runs. A `theta-system-note` reading
  `subagent child spawn failed: cannot place '<label>' in a herdr tab: …`
  names Herdr's own refusal.
- **`herdr unreachable`.** The daemon was restarted, which changes its socket
  path; restart pi from a fresh Herdr pane.
- **A tab opens but the child dies after roughly 30 seconds.** The child
  never dialled the result channel (`HEARTBEAT_SILENCE`); read the pane for
  what it was doing at the time.
- **A duplicate-registration warning** (`ignoring subagent placement
  registration 'herdr'…`) means two copies of this package loaded in the same
  process; run `pi list` to find the second one.
- **Pinned outside Herdr fails closed.** `theta.subagentPlacement: "herdr"`
  set while not in a Herdr pane produces
  `theta/load/subagent-placement-unavailable` at compose time; the accompanying
  `layout.apply` refusal, when it reaches the point of an actual spawn attempt,
  reports "the backend is not detected in this environment".

## Verified on real Herdr

Recorded 2026-09-16 against Herdr 0.8.0 (Windows, named pipe
`C:\Users\thomasa\AppData\Roaming\herdr\herdr.sock`), pi 0.85.1, pi-theta
0.476.0, this package at commit `4fd5ee3`. Driver: the seam sheet's §8.2
`herdr-smoke.theta` (`par for` over two `herdr-smoke-worker` calls with
`max 2`, then one `herdr-smoke-failing-worker`), run from inside a Herdr
pane as `MSYS_NO_PATHCONV=1 PI_THETA_HERDR_SMOKE=1 pi --approve --no-session
-e … -p "/herdr-smoke"`, observed with a 2-second `herdr pane list` poller.

### Version and detection

- Herdr version and API `protocol` observed: 0.8.0; `herdr api schema --json`
  → `protocol: 20`.
- Registration is quiet on a normal TUI start with the companion loaded: no
  `ignoring subagent placement registration` warning and no
  `theta/load/subagent-placement-unavailable` note; the companion appears in
  pi's `[Extensions]` list.

### Placement and pane identity

- `place()` opened two new panes (`w1:p2T5`, `w1:p2T6`) in the parent's
  workspace by t+4 s (2 s poller granularity), `focused: false`, cwd equal
  to the project directory.
- The Herdr sidebar does not detect a theta child by process state: `herdr
  agent list` did not list the child panes at all, and `herdr pane list`
  reported `agent: null`, `agent_status: "unknown"`, `display_agent: null`
  for them, versus `agent: "pi"` (source `herdr:pi`) for top-level pi panes.
  `place()` reports nothing to Herdr's agent tracking in v0.1.0.
- Instead, the sidebar surface that does move is the pane title: it went
  `pi` → `π - herdr-smoke-worker - herdr-smoke` at t+8 s, carrying pi's
  `--name` label. `herdr tab list` reports the tab `label` as the callee
  slug (e.g. `herdr-smoke-failing-worker`); sibling fan-out tabs from the
  same `par for` share one label — a pi-theta gap (F4) fixed upstream in
  pi-theta 0.477.0 by appending `#<id8>`.
- The `Err` child (`herdr-smoke-failing-worker`) opened a pane
  (`w1:p2T7`) at t+12 s and is not retitled `FAILED …`; see Exit and
  lifecycle below (v0.1.0; OQ5).

### Environment overlay (D4)

- Confirmed reaching the child process: `!echo` inside the lingering `Err`
  pane printed `SMOKE=1` (the parent's `PI_THETA_HERDR_SMOKE` arrived
  through `layout.apply`'s `root.env` overlay), `PANE=w1:p2T7` (Herdr's own
  injection — the overlay strips `HERDR_*`), and an empty
  `PI_THETA_SUBAGENT_ENTRY` (pi-theta scrubs its own control-plane variable
  after reading the launch file).

### Wall times and lifecycle

- Both `Ok` tabs closed themselves at t+12 s, roughly 8 s after appearing,
  once their result envelopes landed; the parent issued no `pane.close`.
  Parent wall time for all three children was 27 s; the parent's own
  arithmetic check reported `ok: herdr-smoke-worker summed correctly` twice.
- The `Err` child's tab stayed open — the turn's answer and session footer
  visible — until closed by hand 3 minutes later, well past the parent's
  exit and the 30-second `HEARTBEAT_SILENCE` teardown budget; no
  `subagent-teardown-timeout` note appeared, matching `observesExit: false`
  keeping teardown off a lingering pane.

### Placement overrides observed

- `PI_THETA_SUBAGENT_PLACEMENT=pipe` with the companion loaded: no new panes
  appeared during a 28 s run; the same three result lines came back, and the
  failing child was torn down headless.
- `theta.subagentPlacement` pinned to `"herdr"` with `HERDR_*` unset: with
  the companion loaded, both `mode: subagent` thetas refused at load with
  `theta/load/subagent-placement-unavailable: subagent placement 'herdr' is
  unavailable: the backend is not detected in this environment` (hint text
  present), and `/herdr-smoke`'s callable launches failed at runtime as `Err
  invoke_infra`; without the companion loaded the reason read `no registered
  backend has this name` instead.

### Windows-specific observations

- The named pipe path observed was `C:\Users\thomasa\AppData\Roaming\herdr\herdr.sock`
  (via `\\.\pipe\<HERDR_SOCKET_PATH>` per `detect()`).
- The run required `MSYS_NO_PATHCONV=1` ahead of the `pi` invocation to keep
  the MSYS shell from rewriting the `-p "/herdr-smoke"` argument as a path.

### Cross-process boundaries

- A child pane loads pi-config's extensions, including pi-theta, but not the
  `-e`-loaded companion — pi does not propagate `-e` to children — so a
  grandchild spawned from that pane falls through to `pipe` until the
  companion is installed as a package (pi-config Phase 2E).
- Two load notes surfaced inside the child that are unrelated to placement,
  recorded here for pi-theta: `theta/load/unknown-tool: unknown Pi tool
  'theta_progress'` for the prompt-mode driver theta when discovered inside a
  subagent child, and `theta/load/binder-model-unresolved` for the typed-query
  worker (no `bind_model` set).

### Opt-in suite

- `npm run test:herdr` from inside a Herdr pane: 6 rows (J1-J6), all real
  tests, `npm run test:herdr` → 6 passed. With `HERDR_ENV` unset, the suite
  throws at module top level naming the missing variable rather than
  skipping.

## Licence

Dual-licensed under either MIT OR Apache-2.0, matching pi-theta. See
`LICENSE-MIT` and `LICENSE-APACHE`.
