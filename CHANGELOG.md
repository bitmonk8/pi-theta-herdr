# Changelog

All notable changes to `@bitmonk8/pi-theta-herdr` will be documented here.
The format follows Keep a Changelog; the project adheres to Semantic Versioning.
The package versions independently of pi-theta against the registration
protocol's `apiVersion` (RFC 0012 §5).

## [0.3.0]

### Added
- The child role consumes pi-theta's subagent-child outcome event
  (`pi-theta:subagent-child:outcome:v1`, payload `{ apiVersion: 1, outcome: "ok" | "err",
  slug }`, pi-theta ≥ 0.478.0; RFC 0012 §7, §Open questions 5 close-out). Subscribed on the
  process-local `pi.events` bus at attach, in the child role only; released at
  `session_shutdown`. From the child's first `agent_start` until the event, `agent_settled`
  no longer reports `idle` (the theta is running between its own turns); the hold is
  bounded — `HOLD_TIMEOUT_MS` (20 s) after a settle with no further turn and no event, the
  0.2.0 `idle` goes out anyway and the next turn re-holds. `ok` →
  `pane.report_agent { state: "idle" }` (Herdr observed to render `done`) before the tab
  closes; `err` → `pane.rename { label: "FAILED <label>" }` then `pane.report_agent
  { state: "idle", message: "theta returned Err" }` — `<label>` is the child's display label,
  else the event's `slug`. Exactly one terminal report per session; a terminal report is
  sent even for a theta that failed before any turn; duplicate, garbled or other-version
  payloads are ignored; a refused rename never suppresses the state report.
- `src/protocol.ts`: `SUBAGENT_CHILD_OUTCOME_CHANNEL`, `SUBAGENT_CHILD_OUTCOME_API_VERSION`,
  `SubagentChildOutcome`, `SubagentChildOutcomePayload`, `isSubagentChildOutcomePayload`,
  pinned equal to pi-theta's exports by the conformance suite.
- `ChildReporterDeps.events` (the probed `pi.events`), `ChildReporterDeps.holdTimeoutMs`,
  `HerdrChildReporter.subscribed`, `ERR_OUTCOME_MESSAGE`, `FAILED_TITLE_PREFIX`,
  `HOLD_TIMEOUT_MS`, `OutcomeEventBus`.
- Live row J10: a real pi + pi-theta child in the child regime (fabricated launch file, a
  `.theta` returning `Err` without a model turn) ends `FAILED <label>` / `idle`.

### Changed
- Requirements: pi-theta ≥ 0.478.0 for the retitle; older pi-theta degrades to 0.2.0
  behaviour after the bounded hold (at most 20 s of `working` after a turn settles) and is
  never retitled — install both packages together (pi-config does).
- `HerdrClient` unchanged; the four pi-config-compatible functions are byte-identical in
  behaviour. `place()` and `kill()` unchanged.
- devDependency `@bitmonk8/pi-theta` bumped to the 0.478.0 commit `079ddb67` (lockfile).

### Verified
- (fill from the 0.3.0 smoke and J10, §8 of the seam sheet)

## [0.2.0]

### Added
- Child-side Herdr lifecycle reporting (`src/herdr-child-reporter.ts`). Observed on Herdr
  0.8.0: `herdr:pi`'s reports from inside a theta child were acknowledged but not applied
  (`agent: null`, `agent_status: unknown` in the 0.1.0 smoke), while reports under a custom
  `source` on the same kind of node-rooted pane are applied (pi-config's `pi-subagent`
  panes and the `probe:cli` control) — pi-config attributes this to root-process detection;
  this package pins the observation and does not depend on the cause. So
  a placed child now reports its own pane under `source: "pi-theta-herdr"`,
  `agent: "pi"` (`agent: "pi"` travels only on `pane.report_agent` and
  `pane.report_agent_session`; `pane.report_metadata` carries `source`, `seq`,
  `display_agent`): `pane.report_metadata { display_agent: <label> }`,
  `pane.report_agent_session` (session id, plus the path when a session file exists) and
  `pane.report_agent` (`idle`/`working` from `ctx.isIdle()`) at `session_start`; `working`
  at `agent_start`; `idle` at an `agent_settled` that leaves the session idle. Child role =
  `--theta-launch` on argv + the four `HERDR_*` markers + `ctx.mode === "tui"`;
  `PI_THETA_HERDR_REPORT=0` opts out. Serial fire-and-forget sends, every failure swallowed,
  5 s per-request deadline, `seq` = `Date.now()*1000 + n` per session — observed on Herdr
  0.8.0: reports with small literal `seq` values (1..4) were acknowledged and not applied;
  wall-clock-based values are applied; on
  `session_shutdown { reason: "quit" }` the last in-flight report gets at most 1.5 s to land.
- Client wrappers `paneReportAgent`, `paneReportAgentSession` (+ module-level forms),
  `HerdrAgentState` (`idle|working|blocked|unknown` — `done` is server-derived and not
  sendable), `HERDR_REPORT_SOURCE`, `HERDR_REPORT_AGENT`; `PaneMetadata` gains optional
  `seq`; it deliberately carries no `agent` — observed on Herdr 0.8.0 (protocol 20): a
  `pane.report_metadata` with `agent: "pi"` on a pane Herdr does not recognise as pi was
  acknowledged and not applied, while the same report without `agent` was applied.
- `place()` reports `pane.report_metadata { display_agent: <label> }` right after
  `layout.apply` (fire-and-forget), so the tab is labelled before the child boots.
- `SUBAGENT_LAUNCH_FLAG` / `findLaunchFlagOnArgv` carried as own literals in
  `src/protocol.ts`, pinned equal to pi-theta's by the conformance suite.
- Opt-in real-Herdr rows: `working → idle` renders `done` on a node-rooted pane; a
  look-alike child (pi + pi-theta from the devDependencies) reports its own pane; the
  `herdr:pi` premise is pinned.

### Changed
- `HerdrClient` gains two members (implementers of the interface must add them); the four
  pi-config-compatible functions are byte-identical in behaviour.
- `place()` now issues two requests (`layout.apply`, then one unawaited
  `pane.report_metadata`), superseding 0.1.0's "exactly one request". `kill()` unchanged.
- An `Err` child's tab still lingers un-retitled (no outcome signal reaches the child); it
  is now labelled and shows pi-level `idle`/`working`/`done` in Herdr's agents list.

### Verified
- Real-Herdr smoke against Herdr 0.8.0 protocol 20 (pi-config carrying companion 0.2.0,
  pi 0.85.1, pi-theta 0.477.0, 2026-09-16): three children from `herdr-smoke.theta`,
  `herdr pane list` polled every second. The two `Ok` children reached `display_agent`
  at t+3.2 s (parent `place()`), title `pi` at t+4.2 s, `agent: pi` / `agent_status: working`
  at t+5.3 s (the child's own `session_start`/`agent_start` reports), `done` at t+7.6–8.8 s,
  both panes gone by t+11.4 s. The `Err` child got `display_agent` at t+12.5 s, `agent: pi` /
  `idle` at t+14.6 s, `working` at t+15.7 s, `done` at t+16.7 s, then lingers as `done` — no
  `FAILED` retitle in 0.2.0 (arrives with the pi-theta outcome hook in 0.3.0). `herdr agent
  list` listed all three children while alive. Opt-in suite `npm run test:herdr`: 9 rows
  green (J7's F25 pin: `pane.agent` is `undefined` after metadata alone; J8: `agent_session`
  absent). Full readout in README's *Verified on real Herdr (0.2.0)*.

## [0.1.0]

### Added
- Herdr placement backend for pi-theta (RFC 0012 §5, registration protocol
  `apiVersion: 1`): `name: "herdr"`, `auto`-detected from the pane environment
  (`HERDR_ENV=1` + `HERDR_SOCKET_PATH` + `HERDR_PANE_ID` + `HERDR_WORKSPACE_ID`),
  places each subagent child as a tab in the parent's workspace via
  `layout.apply` (argv spawn, `cwd`, string-valued env overlay, `tab_label` =
  the child's label, `focus: false`), `kill()` = `pane.close`. Capabilities
  `visible: true`, `inheritsEnv: true`; the placed child reports
  `observesExit: false` so pi-theta settles from its result channel and a child
  lingering on `Err` is never killed by teardown. Registers by calling the
  discover payload's `register` once per session.
- The Herdr NDJSON client factored out of pi-config's verified transport
  (`herdrEnv`, `herdrEndpoint`, `herdrRequest`, `firstPaneId`) with byte-identical
  behaviour (5 s / 15 s deadlines, one request per fresh connection, first-line
  read, same error messages), plus `createHerdrClient` for injection and typed
  wrappers `layoutApplyPane`, `paneClose`, `paneRename`, `paneReportMetadata`.
  Hardening delta (D2): a valid-JSON non-object first line rejects `unparseable`
  instead of throwing out of the socket listener.
- Offline test suite (fake Herdr daemon over `node:net`; conformance against
  `@bitmonk8/pi-theta`'s real seam) and the opt-in `npm run test:herdr`
  real-Herdr suite.

### Verified
- Real-Herdr smoke against Herdr 0.8.0 on Windows (commit `4fd5ee3`,
  2026-09-16): `place()` opens the tab, the D4 environment overlay reaches
  the child, `Ok` closes its own tab and `Err` lingers un-retitled past the
  30-second `HEARTBEAT_SILENCE` budget, and `herdr agent list`/`herdr pane
  list` do not surface theta children (`agent: null`). Full readout in
  README's "Verified on real Herdr".
