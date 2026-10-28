import {
  createHerdrClient,
  herdrEnv,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  HERDR_REQUEST_TIMEOUT_MS,
  type HerdrAgentState,
  type HerdrClient,
} from "./herdr-client.ts";
import {
  findLaunchFlagOnArgv,
  isSubagentChildOutcomePayload,
  SUBAGENT_CHILD_OUTCOME_CHANNEL,
  type SubagentChildOutcomePayload,
} from "./protocol.ts";

/** `PI_THETA_HERDR_REPORT=0` disables child-side reporting (D21). Read from `deps.env`. */
export const REPORTING_OPT_OUT_ENV = "PI_THETA_HERDR_REPORT";
/** How long a `session_shutdown { reason: "quit" }` handler waits for the send chain (D16). */
export const SHUTDOWN_FLUSH_BUDGET_MS = 1500;

/** The `pane.report_agent.message` sent with the `err` terminal report (D31). */
export const ERR_OUTCOME_MESSAGE = "theta returned Err";
/** The `pane.rename` label prefix for an `err` outcome: `FAILED <label>` (D31). */
export const FAILED_TITLE_PREFIX = "FAILED ";
/**
 * D34: how long `working` is held after an idle `agent_settled` while waiting for the outcome
 * event before the 0.2.0 `idle` goes out anyway. Bounds the pi-theta < 0.478.0 exposure
 * (P14): at most this much extra `working` per turn, never a stuck badge. Re-armed per
 * settle; cleared by the next turn, the outcome, `session_shutdown`, `session_start`, `detach`.
 */
export const HOLD_TIMEOUT_MS = 20_000;

/** The `ExtensionContext` members the reporter reads — structural, so tests hand in a literal. */
export interface ChildReporterContext {
  readonly mode: string;
  isIdle(): boolean;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getSessionName?(): string | undefined;
  };
}

export interface ChildReporterSessionEvent {
  readonly reason: string;
}

/** The structural subset of `ExtensionAPI.on` the reporter uses; the real `pi` is cast to it. */
export interface ChildReporterHost {
  on(event: "session_start", handler: (event: ChildReporterSessionEvent, ctx: ChildReporterContext) => void): unknown;
  on(event: "agent_start", handler: (event: unknown, ctx: ChildReporterContext) => void): unknown;
  on(event: "agent_settled", handler: (event: unknown, ctx: ChildReporterContext) => void): unknown;
  on(event: "session_shutdown", handler: (event: ChildReporterSessionEvent, ctx: ChildReporterContext) => Promise<void> | void): unknown;
}

/**
 * The `pi.events` subset the reporter consumes: `on` returning its release function
 * (Pi `EventBus.on(): () => void`, `dist/core/event-bus.d.ts`; there is no `off`). The
 * composition root probes `pi.events` with `probePlacementEventBus` and passes the result;
 * `PlacementEventBus` and the tests' `FakeBus` satisfy this structurally.
 */
export interface OutcomeEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ChildReporterDeps {
  readonly client?: HerdrClient;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly shutdownFlushMs?: number;
  /**
   * The process-local `pi.events` bus, already probed (D27). Absent ⇒ no outcome
   * subscription and the 0.2.0 behaviour exactly. Under `exactOptionalPropertyTypes` omit
   * the key rather than passing `undefined`.
   */
  readonly events?: OutcomeEventBus;
  /** D34: overrides `HOLD_TIMEOUT_MS` (tests: fake timers for H1–H10, a 30 ms real timer for H11). */
  readonly holdTimeoutMs?: number;
}

export interface HerdrChildReporter {
  /** True once `attach` registered its handlers on a host. */
  readonly attached: boolean;
  /** True from a `session_start` that decided "child role" until the next `session_shutdown` (or a `session_start` that decides otherwise). */
  readonly active: boolean;
  /** True while the outcome-channel subscription is held: from `attach` (given `deps.events`) to `session_shutdown`. */
  readonly subscribed: boolean;
  attach(host: ChildReporterHost): void;
  /** Stop enqueueing; already-enqueued reports still complete on their own deadlines. Does not release the bus subscription (that is `session_shutdown`'s). */
  detach(): void;
  /** Resolves when every report enqueued so far has settled; never rejects. */
  flush(): Promise<void>;
}

/** Factory-time gate (D13): argv marker present, pane env present, not opted out. `ctx.mode` is checked at `session_start`. */
export function shouldAttachChildReporter(input: { readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv }): boolean {
  return (
    findLaunchFlagOnArgv(input.argv) !== undefined &&
    herdrEnv(input.env) !== null &&
    input.env[REPORTING_OPT_OUT_ENV] !== "0"
  );
}

export function createHerdrChildReporter(deps: ChildReporterDeps = {}): HerdrChildReporter {
  const client = deps.client ?? createHerdrClient();
  const argv = deps.argv ?? process.argv;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.requestTimeoutMs ?? HERDR_REQUEST_TIMEOUT_MS;
  const shutdownFlushMs = deps.shutdownFlushMs ?? SHUTDOWN_FLUSH_BUDGET_MS;
  const events = deps.events;
  const holdTimeoutMs = deps.holdTimeoutMs ?? HOLD_TIMEOUT_MS;

  let attached = false;
  let active = false;
  let paneId: string | undefined;
  let seq = 0;
  let lastSessionRef: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  // 0.3.0 (D27/D28): the outcome hook's per-session state, all in this closure (I3).
  let label: string | undefined;
  let holding = false;
  let outcomeSeen = false;
  let releaseOutcome: (() => void) | undefined;
  // 0496: capture only before the first activation decision. undefined = empty/open,
  // payload = first valid outcome, null = closed (never reopened by later sessions).
  let pendingOutcome: SubagentChildOutcomePayload | null | undefined;
  // D34: the bounded hold. Pending only while `active && holding`; every path out of that
  // state clears it. Unref'd so it never keeps the child process alive.
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHoldTimer = (): void => {
    if (holdTimer === undefined) return;
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  /** Serial FIFO (D18); the rename rides it without a `seq` (D30). */
  const enqueueUnsequenced = (dispatch: (pane: string) => Promise<void>): void => {
    if (!active || paneId === undefined) return;
    const pane = paneId;
    chain = chain.then(() => dispatch(pane)).catch(() => {});
  };

  const enqueue = (dispatch: (pane: string, seq: number) => Promise<void>): void => {
    if (!active || paneId === undefined) return;
    seq += 1;
    const thisSeq = seq;
    enqueueUnsequenced((pane) => dispatch(pane, thisSeq));
  };

  const sessionRef = (ctx: ChildReporterContext): { id: string; path?: string } | undefined => {
    const id = ctx.sessionManager.getSessionId();
    if (typeof id !== "string" || id.length === 0) return undefined;
    const file = ctx.sessionManager.getSessionFile();
    return typeof file === "string" && file.length > 0 ? { id, path: file } : { id };
  };

  const reportSession = (ctx: ChildReporterContext, reason: string | undefined, onlyIfChanged: boolean): void => {
    const ref = sessionRef(ctx);
    if (ref === undefined) return;
    const key = `${ref.id}\n${ref.path ?? ""}`;
    if (onlyIfChanged && key === lastSessionRef) return;
    lastSessionRef = key;
    enqueue((pane, s) =>
      client.paneReportAgentSession(
        pane,
        {
          source: HERDR_REPORT_SOURCE,
          agent: HERDR_REPORT_AGENT,
          seq: s,
          ...(reason !== undefined ? { sessionStartSource: reason } : {}),
          agentSessionId: ref.id,
          ...(ref.path !== undefined ? { agentSessionPath: ref.path } : {}),
        },
        { timeoutMs },
      ),
    );
  };

  const reportState = (state: HerdrAgentState, message?: string): void => {
    enqueue((pane, s) =>
      client.paneReportAgent(
        pane,
        {
          source: HERDR_REPORT_SOURCE,
          agent: HERDR_REPORT_AGENT,
          seq: s,
          state,
          ...(message !== undefined ? { message } : {}),
        },
        { timeoutMs },
      ),
    );
  };

  // D34: the timer callback. Closure state only (no ctx — P7); must never throw — this is the
  // one place the reporter runs outside a host handler or the chain, and an uncaught throw in
  // a timer callback kills the child process. Both branches are assignments plus `reportState`,
  // whose dispatch runs inside the chain's `.then` (a throw there is a swallowed rejection).
  const onHoldExpired = (): void => {
    holdTimer = undefined;
    if (!active || !holding) return;
    holding = false;
    // The idle 0.2.0 would have sent at the settle; `outcomeSeen` is untouched, so the next
    // turn re-enters holding and a later outcome still sends its terminal report once.
    reportState("idle");
  };

  const onSessionStart = (event: ChildReporterSessionEvent, ctx: ChildReporterContext): void => {
    const pending = pendingOutcome;
    pendingOutcome = null; // take/discard even if this activation is refused
    const pane = client.env();
    active =
      findLaunchFlagOnArgv(argv) !== undefined &&
      pane !== null &&
      env[REPORTING_OPT_OUT_ENV] !== "0" &&
      ctx.mode === "tui";
    clearHoldTimer();
    holding = false;
    outcomeSeen = false;
    label = undefined;
    if (!active || pane === null) return;
    paneId = pane.paneId;
    seq = now() * 1000;
    lastSessionRef = undefined;
    const name = typeof ctx.sessionManager.getSessionName === "function" ? ctx.sessionManager.getSessionName() : undefined;
    label = typeof name === "string" && name.length > 0 ? name : undefined;
    if (label !== undefined) {
      const displayAgent = label;
      enqueue((p, s) =>
        client.paneReportMetadata(p, { source: HERDR_REPORT_SOURCE, seq: s, displayAgent }, { timeoutMs }),
      );
    }
    reportSession(ctx, event.reason, false);
    reportState(ctx.isIdle() ? "idle" : "working");
    // The emitter may run in an earlier session_start handler. Keep normal startup
    // reports ahead of its terminal report on the existing FIFO (rename has no seq).
    if (pending !== undefined && pending !== null) onOutcome(pending);
  };

  const onAgentStart = (_event: unknown, ctx: ChildReporterContext): void => {
    if (!active) return;
    // D34: a new turn cancels the pending fallback — the badge is `working` again for real.
    clearHoldTimer();
    reportSession(ctx, undefined, true);
    reportState("working");
    // D28: from the first turn until the outcome, the theta is running whether or not an
    // agent turn is; `agent_settled` must not flip the badge between its turns. Entered
    // only while the hook is wired — without a bus the 0.2.0 sequence stands. Re-entered
    // after a D34 fallback while the outcome is still unseen.
    if (releaseOutcome !== undefined && !outcomeSeen) holding = true;
  };

  const onAgentSettled = (_event: unknown, ctx: ChildReporterContext): void => {
    if (!active || ctx.isIdle() !== true) return;
    if (!holding) {
      reportState("idle");
      return;
    }
    // D34: no report while holding; instead (re-)arm the bounded fallback to the 0.2.0 idle.
    clearHoldTimer();
    holdTimer = setTimeout(onHoldExpired, holdTimeoutMs);
    holdTimer.unref?.();
  };

  // D28/D29: the terminal report. Reads closure state only (never a ctx — P7). Must never
  // throw: Pi's bus wrapper would `console.error` into the TUI pane (P13).
  const onOutcome = (data: unknown): void => {
    if (outcomeSeen || !isSubagentChildOutcomePayload(data)) return;
    if (!active) {
      if (pendingOutcome === undefined) {
        // Snapshot plain protocol data; first valid wins without preactivation I/O.
        pendingOutcome = { apiVersion: data.apiVersion, outcome: data.outcome, slug: data.slug };
      }
      return;
    }
    outcomeSeen = true;
    holding = false;
    clearHoldTimer();
    if (data.outcome === "ok") {
      reportState("idle");
      return;
    }
    const title = `${FAILED_TITLE_PREFIX}${label ?? data.slug}`;
    enqueueUnsequenced((pane) => client.paneRename(pane, title, { timeoutMs }));
    reportState("idle", ERR_OUTCOME_MESSAGE);
  };

  const detach = (): void => {
    active = false;
    pendingOutcome = null;
    clearHoldTimer();
  };

  const releaseOutcomeSubscription = (): void => {
    const release = releaseOutcome;
    releaseOutcome = undefined;
    if (release !== undefined) release();
  };

  const flush = (): Promise<void> => chain.then(() => undefined);

  const onSessionShutdown = async (event: ChildReporterSessionEvent): Promise<void> => {
    const wasActive = active;
    detach(); // also clears the D34 hold timer — every reason, before the release
    // RFC 0012 §5: every bus subscription is released at session_shutdown (load-bearing on
    // Pi 0.80.10, whose `pi.events` is the raw bus; idempotent with 0.85.1's tracked release).
    releaseOutcomeSubscription();
    if (!wasActive || event.reason !== "quit") return;
    // The Ok path exits right after the shutdown handlers resolve (P8); give the last
    // in-flight report one bounded chance to land. Unref'd so it never holds the process.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, shutdownFlushMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  };

  return {
    get attached() { return attached; },
    get active() { return active; },
    get subscribed() { return releaseOutcome !== undefined; },
    attach(host: ChildReporterHost): void {
      if (attached) return;
      attached = true;
      host.on("session_start", onSessionStart);
      host.on("agent_start", onAgentStart);
      host.on("agent_settled", onAgentSettled);
      host.on("session_shutdown", onSessionShutdown);
      // D27: subscribe here — the factory body, where the runtime is live (Pi 0.85.1's
      // `events.on` asserts it) and only a child-role process ever attaches (D13).
      if (events !== undefined) {
        releaseOutcome = events.on(SUBAGENT_CHILD_OUTCOME_CHANNEL, onOutcome);
      }
    },
    detach,
    flush,
  };
}

/** `createHerdrChildReporter(deps).attach(host)` when `shouldAttachChildReporter` holds; otherwise registers nothing and returns `undefined`. */
export function attachHerdrChildReporter(host: ChildReporterHost, deps: ChildReporterDeps = {}): HerdrChildReporter | undefined {
  if (!shouldAttachChildReporter({ argv: deps.argv ?? process.argv, env: deps.env ?? process.env })) {
    return undefined;
  }
  const reporter = createHerdrChildReporter(deps);
  reporter.attach(host);
  return reporter;
}
