# Working notes — `@bitmonk8/pi-theta-herdr`

## Two suites

- `npm test` (`vitest.config.ts`) — the default gate. Offline, network-free,
  deterministic. Runs on Windows and POSIX.
- `npm run test:herdr` (`config/vitest/vitest.herdr.config.ts`, suite
  `tests/herdr-live/**`) — opt-in. Requires a running Herdr daemon and this
  process sitting in a Herdr pane. Run it whenever `src/herdr-client.ts` or
  `src/herdr-placement-backend.ts` changes, from inside a Herdr pane.

## No silent skipping

A missing pane environment fails the `test:herdr` suite loudly, naming the
missing `HERDR_*` variable. No `it.skip`, `describe.skip`, `test.todo`, or an
early `return` standing in for an assertion — a skipped test reports success
for something never checked.

## Client behaviour-identity rule

`src/herdr-client.ts`'s four pi-config-compatible functions (`herdrEnv`,
`herdrEndpoint`, `herdrRequest`, `firstPaneId`) may gain injection parameters
and typed wrappers, but a default-argument call must never change what it
returns or throws. pi-config's model-facing `subagent` tool imports these
functions directly and depends on that identity (§7 of the seam sheet).

## Import-specifier contract

pi-config imports this package as
`@bitmonk8/pi-theta-herdr/src/herdr-client.ts` — the deep `.ts` path, not a
package `exports` entry (this package defines none, matching pi-theta). Moving
or renaming `src/herdr-client.ts` breaks that import silently at pi-config's
build; treat the path as public API.

## No module-level mutable state (I3)

jiti loads each extension entry as its own module graph
(`moduleCache: false`), so `src/herdr-client.ts` may be evaluated more than
once in one pi process — once via pi-config's `subagent` extension, once via
this package's own `extensions/index.ts`. Nothing under `src/` may carry
module-level mutable state, and no code may assume `instanceof` holds across
graphs (a `HerdrRequestError` thrown in one graph is not the same class object
in the other). Reporter state lives in the factory closure; handlers are
released by the `active` latch at `session_shutdown`, not by unsubscription.

## Child-side reporting rules

- The child role reports only when `--theta-launch` is on `process.argv`
  **and** a Herdr pane env is present **and** `ctx.mode === "tui"`.
- Wording rule: describe Herdr's handling of `herdr:pi` as observed
  behaviour, never as mechanism.
