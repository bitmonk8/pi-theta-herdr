import {
  createHerdrClient,
  herdrEnv,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  HERDR_REQUEST_TIMEOUT_MS,
  type HerdrAgentState,
  type HerdrClient,
} from "./herdr-client.ts";
import { findLaunchFlagOnArgv } from "./protocol.ts";

/** `PI_THETA_HERDR_REPORT=0` disables child-side reporting (D21). Read from `deps.env`. */
export const REPORTING_OPT_OUT_ENV = "PI_THETA_HERDR_REPORT";
/** How long a `session_shutdown { reason: "quit" }` handler waits for the send chain (D16). */
export const SHUTDOWN_FLUSH_BUDGET_MS = 1500;

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

export interface ChildReporterDeps {
  readonly client?: HerdrClient;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly shutdownFlushMs?: number;
}

export interface HerdrChildReporter {
  /** True once `attach` registered its handlers on a host. */
  readonly attached: boolean;
  /** True from a `session_start` that decided "child role" until the next `session_shutdown` (or a `session_start` that decides otherwise). */
  readonly active: boolean;
  attach(host: ChildReporterHost): void;
  /** Stop enqueueing; already-enqueued reports still complete on their own deadlines. */
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

  let attached = false;
  let active = false;
  let paneId: string | undefined;
  let seq = 0;
  let lastSessionRef: string | undefined;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (dispatch: (pane: string, seq: number) => Promise<void>): void => {
    if (!active || paneId === undefined) return;
    seq += 1;
    const pane = paneId;
    const thisSeq = seq;
    chain = chain.then(() => dispatch(pane, thisSeq)).catch(() => {});
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

  const reportState = (state: HerdrAgentState): void => {
    enqueue((pane, s) =>
      client.paneReportAgent(pane, { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: s, state }, { timeoutMs }),
    );
  };

  const onSessionStart = (event: ChildReporterSessionEvent, ctx: ChildReporterContext): void => {
    const pane = client.env();
    active =
      findLaunchFlagOnArgv(argv) !== undefined &&
      pane !== null &&
      env[REPORTING_OPT_OUT_ENV] !== "0" &&
      ctx.mode === "tui";
    if (!active || pane === null) return;
    paneId = pane.paneId;
    seq = now() * 1000;
    lastSessionRef = undefined;
    const name = typeof ctx.sessionManager.getSessionName === "function" ? ctx.sessionManager.getSessionName() : undefined;
    const label = typeof name === "string" && name.length > 0 ? name : undefined;
    if (label !== undefined) {
      enqueue((p, s) =>
        client.paneReportMetadata(p, { source: HERDR_REPORT_SOURCE, seq: s, displayAgent: label }, { timeoutMs }),
      );
    }
    reportSession(ctx, event.reason, false);
    reportState(ctx.isIdle() ? "idle" : "working");
  };

  const onAgentStart = (_event: unknown, ctx: ChildReporterContext): void => {
    if (!active) return;
    reportSession(ctx, undefined, true);
    reportState("working");
  };

  const onAgentSettled = (_event: unknown, ctx: ChildReporterContext): void => {
    if (!active || ctx.isIdle() !== true) return;
    reportState("idle");
  };

  const detach = (): void => {
    active = false;
  };

  const flush = (): Promise<void> => chain.then(() => undefined);

  const onSessionShutdown = async (event: ChildReporterSessionEvent): Promise<void> => {
    const wasActive = active;
    detach();
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
    attach(host: ChildReporterHost): void {
      if (attached) return;
      attached = true;
      host.on("session_start", onSessionStart);
      host.on("agent_start", onAgentStart);
      host.on("agent_settled", onAgentSettled);
      host.on("session_shutdown", onSessionShutdown);
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
