# @bitmonk8/pi-theta-herdr

## What it is

`@bitmonk8/pi-theta-herdr` is a pi package that registers the `herdr`
subagent placement backend with `@bitmonk8/pi-theta` (RFC 0012 §5, decision
D5). With it loaded, every subagent child pi-theta launches — a `mode:
subagent` slash command, an `invoke(...)` call, a `.theta` callable, a `par
for` iteration, or a `subagent fn` call — opens as a tab in the parent's
Herdr workspace instead of running headless: the tab closes itself when the
child returns `Ok`, and lingers, retitled `FAILED <label>` in Herdr's agents
list, when it returns `Err` (pi-theta ≥ 0.478.0).
The same repository is the home of the Herdr NDJSON client that pi-config's
`subagent` tool imports (`src/herdr-client.ts`).

## Requirements

- Herdr 0.8.x (API `protocol: 20`, `herdr api schema --json`).
- Pi with `pi.events` (≥ 0.34; verified against 0.80.10 and 0.85.1).
- pi-theta ≥ 0.475.0 for placement; **≥ 0.478.0 for the retitle** (the child
  outcome event `pi-theta:subagent-child:outcome:v1`); older pi-theta
  degrades to 0.2.0 behaviour after the bounded hold (at most 20 s of
  `working` after a turn settles) and never retitles.
- Windows: Herdr's control socket is a named pipe
  (`\\.\pipe\<HERDR_SOCKET_PATH>`); the client handles this transparently.
- pi-config ≥ `2d6ffb0` for child-side reporting (*Agents-list
  integration*) — the companion must be loaded inside the child's own
  `pi.extensions`, not carried in via a parent's `-e`.

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
- **Placement.** `place()` issues a `layout.apply` request: an argv spawn,
  a `cwd`, an environment overlay (D4), `tab_label` set to the callee's
  label, `focus: false`, and the parent's `workspace_id` — the child opens as
  a background tab in the same workspace, never stealing focus. Immediately
  after `layout.apply` resolves, `place()` also issues one unawaited
  `pane.report_metadata { display_agent: <label> }` so the pane carries its
  label in Herdr's agents list from the first frame — see *Agents-list
  integration*.
- **Priority and `auto`.** pi-theta's `auto` placement selection orders
  candidate backends and picks `herdr` when its `detect()` succeeds inside a
  Herdr pane, falling back to the built-in `pipe` backend otherwise.
- **Visible tabs.** A cap on simultaneously visible children —
  `theta.subagentPlacementMaxVisible` — keeps a wide `par for` fan-out from
  opening one tab per iteration.
- **`kill()`** issues `pane.close` against the pane Herdr assigned to the
  child.
- **Exit and lifecycle.** `Ok` closes the child's own tab. `Err` leaves the
  tab open and, since 0.3.0, retitles it `FAILED <label>` and reports the
  pane idle with the message `theta returned Err` — the child's pi-theta
  (≥ 0.478.0) emits `pi-theta:subagent-child:outcome:v1` on the
  process-local `pi.events` bus after every terminal envelope, and this
  package consumes it inside the child. The backend still reports
  `observesExit: false`:
  pi-theta settles the child from its own loopback result channel rather than
  from process exit, with a heartbeat-silence budget of 30 seconds, so a
  lingering `Err` tab is never torn down by teardown logic.
- **Environment overlay (D4).** The child inherits the parent's environment
  plus an overlay of string-valued variables the caller supplied; Herdr's own
  pane injection (`HERDR_PANE_ID`, etc.) always wins for the child's own
  identity.

## Agents-list integration

### Why the companion reports

Herdr's own pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`,
`source: herdr:pi`) loads inside every pi process on this machine that does
not pass `-ne` — theta children included. Observed on Herdr 0.8.0:
`herdr:pi`'s reports from inside a theta child were acknowledged but not
applied (`agent: null`, `agent_status: unknown` in the 0.1.0 smoke — see
*Verified on real Herdr*), while reports under a custom `source` on the same
kind of node-rooted pane are applied (pi-config's `pi-subagent` panes and the
`probe:cli` control). A control report issued with
`herdr pane report-agent … --source herdr:pi` on such a pane was
acknowledged and not applied, and the same report under `--source probe:cli`
was applied (coordinator experiment, 2026-09-16, Herdr 0.8.0 protocol 20).
pi-config attributes this to root-process detection; the companion pins the
observation with the opt-in suite's real-Herdr rows and does not depend on
the cause. Because pi-config's `pi.extensions` loads this package inside the
child too, the child reports from inside its own pane under
`source: "pi-theta-herdr"`, `agent: "pi"`.

### What is reported, when

`place()` issues `pane.report_metadata { display_agent: <label> }` right
after `layout.apply` resolves, so the tab carries its label before the child
boots. The child — only when `--theta-launch` is on its argv, the four
`HERDR_*` pane markers are set, and `ctx.mode === "tui"` — reports at
`session_start`: `display_agent`, the session id (plus the session file path
when one exists), and `idle`/`working` from `ctx.isIdle()`; `working` at
every `agent_start`; `idle` at every `agent_settled` that leaves the session
idle. `PI_THETA_HERDR_REPORT=0` in the environment (inherited by children
through the D4 overlay) turns the companion's child-side reporting off
without uninstalling the package.

Observed on Herdr 0.8.0 (protocol 20): the child's `pane.report_agent_session`
under `source: "pi-theta-herdr"` is acknowledged, but `pane.get` shows no
`agent_session` for the pane; `display_agent`, `agent` and `agent_status` from
the same source are applied. The companion sends the session report
regardless and does not depend on it.

`PaneMetadata` deliberately carries no `agent` field (`agent: "pi"` travels
only on `pane.report_agent` and `pane.report_agent_session`; `pane.report_metadata`
carries `source`, `seq`, `display_agent`) — observed on Herdr 0.8.0: a
`pane.report_metadata` with `agent: "pi"` on a pane Herdr does not recognise
as pi was acknowledged and not applied, while the same report without `agent`
was applied. `seq` = `Date.now()*1000 + n` per session — observed on Herdr
0.8.0: reports with small literal `seq` values (1..4) were acknowledged and
not applied; wall-clock-based values are applied.

From the child's first model turn (`agent_start`) until pi-theta's outcome
event, the badge is held at `working`: `agent_settled` between turns no
longer reports `idle`, because a theta runs code, tools and child fan-outs
between its own turns. The hold is bounded: 20 s after a turn settles with
no further turn and no outcome, the pane is reported `idle` anyway
(`HOLD_TIMEOUT_MS`), and the next turn re-asserts `working` — a gap longer
than 20 s therefore reads `done` for its remainder, as every gap did in
0.2.0. `ok` → `pane.report_agent { state: idle }` (observed: Herdr then
renders `done`) right before the tab closes. `err` → `pane.rename { label:
"FAILED <label>" }` then `pane.report_agent { state: idle, message: "theta
returned Err" }`. `<label>` is the pane's `display_agent` (the child's
`--name`); when the child has no name, the theta's slug from the event. A
theta that fails before any turn is retitled the same way and reads `idle`.
Without a `pi.events` bus nothing is subscribed and the 0.2.0 behaviour
stands.

### What the sidebar shows over a child's life

`idle` at boot → `working` from the first model turn, held across the
theta's tool calls, `invoke`s and `par for` children (for up to 20 s past
each turn's settle; a longer stretch shows `done` until the next turn) → at
`Ok`: `done` (observed derivation from `working → idle`) for the ≈1–2 s
before the tab closes itself → at `Err`: the tab label becomes `FAILED
<label>` and the badge reads `done` (or `idle` when no turn ever ran); the
tab stays for a human to read or continue, and their turns then flip
`working`/`done` as before. The `FAILED` label is never restored. The
`message` is not visible through `pane.get` (no field carries it; observed on
Herdr 0.8.0: `state_labels` undefined; the rename is visible only in
`label`).

### Coexistence with `herdr:pi`

Today `herdr:pi`'s reports on a theta pane are acknowledged but ignored, so
the companion is the only source Herdr applies. If a later Herdr version
honours `herdr:pi` on node-rooted panes too, both sources publish the same
`working`/`idle` transitions from the same pi events; `pane.get`'s
`agent_session.source` shows which source Herdr took — when Herdr records
one: on Herdr 0.8.0 none appeared for the companion's own reports.
`display_agent` comes only from the companion — `herdr:pi` never calls
`pane.report_metadata`. `herdr:pi` knows nothing of the outcome event; if a
later Herdr honours it on these panes, its per-turn `idle` would flicker
`done` between turns while the companion holds `working` — the two sources
would then disagree between turns. Pinned by J9; revisit if it reds.

### Caveats

`-e` is not propagated to children: a checkout smoke (`pi -e <checkout>`)
exercises only the parent-side label from `place()`; child-side reporting
needs the companion installed as a package in the child's own configuration
(pi-config ≥ `2d6ffb0`). Failures are silent by design — a TUI child must
not write to its own pane — so verify with `herdr pane get <id>` or
`npm run test:herdr`. `blocked` is never reported: nothing on this machine
emits a `blocked` state for a pi process. An `exec`-placed child inside a
Herdr pane inherits its mux server's `HERDR_*` variables and would report
onto that pane instead of its own — an exposure shared with every Herdr
integration. Windows `agent_session_path` resume behaviour is unverified
(the session report is not applied by Herdr 0.8.0 anyway). A child whose
marked root refuses at load (a bad frontmatter, a hash mismatch) writes a
refusal envelope and emits no outcome event at the pi-theta 0.478.0 pin —
its pane stays `idle` and is not retitled. When an emitter does report a
load-pass refusal during an earlier `session_start` handler, the companion
retains the first valid outcome until its initial activation decision. An
activated child queues it after normal startup reports; a refused activation,
`detach`, or shutdown discards it without reopening capture in later sessions.
The rename remains advisory and may lose to pane closure. Two copies of this
package loaded in one child each rename and report once — harmless duplicates.

### Expected `herdr agent list` timeline (0.3.0 — observed 2026-09-16; see
*Verified on real Herdr (0.3.0)*)

Drawn from the Phase 2D-bis smoke procedure's `herdr-smoke.theta` driver
(`par for … max 2` over two `Ok` workers, then one `Err` worker), polled
every 2 seconds; times are relative to the parent's dispatch. `W1`/`W2` are
the `Ok` workers, `E` is the `Err` worker.

| t | Pane | Expected row | Source of the change |
|---|---|---|---|
| ≈+1 s | W1, W2 appear | `display_agent` already set; `agent_status: unknown`; `agent`: absent until the child's first `pane.report_agent` (observed) | parent `place()` |
| ≈+4 s | W1, W2 | `agent: "pi"`, `agent_status: idle` | child `session_start` |
| ≈+5 s | W1, W2 | `agent_status: working` — held | first `@` turn → `agent_start` |
| ≈+8–12 s | W1, W2 | `agent_status: done` briefly, then the pane disappears | `agent_settled` → `idle` (0.3.0: only at the `Ok` outcome); `Ok` → tab closes |
| ≈+12 s | E appears | as W1/W2 at +1 s, label `herdr-smoke-failing-worker#<id8>` | parent `place()` |
| ≈+16 s | E | `idle` | child `session_start` |
| ≈+17 s | E | `working` | its one `@` turn |
| ≈+20 s | E | the turn settled — **still `working`** | held (0.3.0: `agent_settled` is mute while holding) |
| ≈+21 s | E | `label: FAILED herdr-smoke-failing-worker#<id8>`, `agent_status: done` | the `err` outcome event: `pane.rename` then `idle` |
| +30 s … +∞ | E | unchanged: `FAILED …`, `done`, labelled; persists in `herdr agent list` until closed by hand | the outcome event closes OQ5's retitle half |

No fallback `idle` (the 20 s bound) is expected anywhere in this timeline —
the fixtures' code stretches are shorter than 20 s.

### Verified on real Herdr (0.2.0)

Observed timeline from the 2026-09-16 smoke (pi-config carrying companion
0.2.0, Herdr 0.8.0 protocol 20, pi 0.85.1, pi-theta 0.477.0; three children
from `herdr-smoke.theta`; `herdr pane list` polled every second):

- t+3.2 s — pane `w1:p2YS` appears with `display_agent:
  herdr-smoke-worker#26bda3f5` already set by the parent's `place()` metadata
  (`agent: null`, `agent_status: unknown`, title `node.exe`).
- t+4.2 s — title `pi`.
- t+5.3 s — `agent: pi`, `agent_status: working` (the child's own
  `session_start`/`agent_start` reports).
- t+7.6–8.8 s — `done` after the turn (title `π - herdr-smoke-worker#… -
  herdr-smoke`).
- t+11.4 s — both `Ok` panes gone.

The `Err` child `w1:p2YT`: t+12.5 s `display_agent:
herdr-smoke-failing-worker#7c5be1c5`; t+14.6 s `agent: pi`, `idle`; t+15.7 s
`working`; t+16.7 s `done`; then lingers as `done` (no `FAILED` retitle in
0.2.0 — retitled since 0.3.0).

`herdr agent list` listed all three children while alive. Opt-in suite
`npm run test:herdr`: 9 rows green (J7's F25 pin: `pane.agent` is `undefined`
after metadata alone; J8: `agent_session` absent).

### Verified on real Herdr (0.3.0)

Observed timeline from the 2026-09-16 smoke (pi-config carrying pi-theta
0.478.0 + companion 0.3.0, Herdr 0.8.0 protocol 20, `herdr pane list` polled
every second):

The two `Ok` children `w1:p33B`/`w1:p33C`: t+4.2 s `display_agent:
herdr-smoke-worker#cd4c0921` / `#188d949c` (`agent: null`, `agent_status:
unknown`); t+5.3 s `agent: pi`, `agent_status: working`; still `working` at
t+7.4 s after the turn's tool finished (title back to `π -
herdr-smoke-worker#… - herdr`) — no between-turn `done`; `w1:p33C` gone at
t+9.4 s, `w1:p33B` at t+12.6 s. No `done` was caught on either `Ok` pane at
1 s polling: the `Ok` `idle` window is below the poll resolution (not
distinguished from a report not applied before the pane closed — the
offline rows S3/S18 pin the report).

The `Err` child `w1:p33D`: t+12.6 s `display_agent:
herdr-smoke-failing-worker#0061de67`; t+13.6 s `agent: pi`, `working` (the
`session_start` `idle` fell between polls); t+14.6 s `label: FAILED
herdr-smoke-failing-worker#0061de67`, `agent_status: done`, `display_agent`
unchanged; unchanged until closed by hand. Wall time from `working` to the
`FAILED` label: ≤ 1 s. No pane showed the D34 fallback `idle`.

The rename lands on `PaneInfo.label`; `title`/`terminal_title` kept
tracking the terminal. J10 readout: `state_labels` undefined on the
retitled pane; the `err` message `theta returned Err` is visible on no
`pane.get`/`pane list` field. Opt-in suite `npm run test:herdr`: J0–J10
green.

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
  Run it whenever the client or backend changes. Rows J7–J10 exercise the
  agents-list derivation on a node-rooted pane, the child role end to end,
  and the `herdr:pi` premise this package's reporting depends on; J10
  drives a real pi + pi-theta child (the devDependencies, pi-theta ≥
  0.478.0) into the child regime with a fabricated launch file and asserts
  the `FAILED` retitle. The pi-theta devDependency must be ≥ 0.478.0 for
  the conformance rows (`npm update @bitmonk8/pi-theta`).
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
- **A failed child's tab is not retitled `FAILED`.** Either the child's
  pi-theta is older than 0.478.0 (no outcome event — the badge then reads
  `working` for up to 20 s after each turn and `done` after that; nothing
  is ever retitled), or the companion is not loaded inside the child (`-e`
  is not propagated; check pi-config's `pi.extensions`), or
  `PI_THETA_HERDR_REPORT=0` is set.
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
  `place()` reports nothing to Herdr's agent tracking in v0.1.0 (0.2.0
  reports — see *Agents-list integration*).
- Instead, the sidebar surface that does move is the pane title: it went
  `pi` → `π - herdr-smoke-worker - herdr-smoke` at t+8 s, carrying pi's
  `--name` label. `herdr tab list` reports the tab `label` as the callee
  slug (e.g. `herdr-smoke-failing-worker`); sibling fan-out tabs from the
  same `par for` share one label — a pi-theta gap (F4) fixed upstream in
  pi-theta 0.477.0 by appending `#<id8>`.
- The `Err` child (`herdr-smoke-failing-worker`) opened a pane
  (`w1:p2T7`) at t+12 s and is not retitled `FAILED …`; see Exit and
  lifecycle below (v0.1.0/0.2.0; retitled since 0.3.0 — see *Verified on
  real Herdr (0.3.0)*).

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
