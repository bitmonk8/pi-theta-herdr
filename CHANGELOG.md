# Changelog

All notable changes to `@bitmonk8/pi-theta-herdr` will be documented here.
The format follows Keep a Changelog; the project adheres to Semantic Versioning.
The package versions independently of pi-theta against the registration
protocol's `apiVersion` (RFC 0012 §5).

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
