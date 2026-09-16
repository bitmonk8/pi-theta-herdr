# Changelog

All notable changes to `@bitmonk8/pi-theta-herdr` will be documented here.
The format follows Keep a Changelog; the project adheres to Semantic Versioning.
The package versions independently of pi-theta against the registration
protocol's `apiVersion` (RFC 0012 §5).

## [0.2.0]

### Added
- Child-side Herdr lifecycle reporting (`src/herdr-child-reporter.ts`). Observed on Herdr
  0.8.0: `herdr:pi`'s reports from inside a theta child were acknowledged but not applied
  (`agent: null`, `agent_status: unknown` in the 0.1.0 smoke), while reports under a custom
  `source` on the same kind of node-rooted pane are applied (pi-config's `pi-subagent`
  panes and the `probe:cli` control) — pi-config attributes this to root-process detection;
  this package pins the observation and does not depend on the cause. So
  a placed child now reports its own pane under `source: "pi-theta-herdr"`,
  `agent: "pi"`: `pane.report_metadata { display_agent: <label> }`,
  `pane.report_agent_session` (session id, plus the path when a session file exists) and
  `pane.report_agent` (`idle`/`working` from `ctx.isIdle()`) at `session_start`; `working`
  at `agent_start`; `idle` at an `agent_settled` that leaves the session idle. Child role =
  `--theta-launch` on argv + the four `HERDR_*` markers + `ctx.mode === "tui"`;
  `PI_THETA_HERDR_REPORT=0` opts out. Serial fire-and-forget sends, every failure swallowed,
  5 s per-request deadline, `seq` = `Date.now()*1000 + n` per session; on
  `session_shutdown { reason: "quit" }` the last in-flight report gets at most 1.5 s to land.
- Client wrappers `paneReportAgent`, `paneReportAgentSession` (+ module-level forms),
  `HerdrAgentState` (`idle|working|blocked|unknown` — `done` is server-derived and not
  sendable), `HERDR_REPORT_SOURCE`, `HERDR_REPORT_AGENT`; `PaneMetadata` gains optional
  `agent` and `seq`.
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
- (fill from the 0.2.0 smoke, README's *Agents-list integration* → *Expected `herdr
  agent list` timeline*)

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
