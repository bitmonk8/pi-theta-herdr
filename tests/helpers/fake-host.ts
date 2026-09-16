// `FakeBus` copied from pi-theta's `tests/subagent-placement-registry.test.ts`
// (the minimal in-memory `EventBus` matching the pin's `emit` / `on ->
// unsubscribe` contract; pi-theta's own `files` does not ship `tests/`, so
// this is copied text, not an import) — source:
// `C:/UnitySrc/pi-theta/tests/subagent-placement-registry.test.ts`, class
// `FakeBus`. Plus the companion's own fake `PlacementHost` (seam sheet §4.2),
// widened for §5.7.1/§6 to also drive `src/herdr-child-reporter.ts`'s
// `ChildReporterHost` (`session_start` / `agent_start` / `agent_settled` /
// `session_shutdown`), and `fakeCtx()` (§6 preamble).
import type { ChildReporterContext } from "../../src/herdr-child-reporter.ts";

/** The `pi.events` surface both pi-theta's registry and the companion consume. */
export interface FakeBusEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export class FakeBus implements FakeBusEventBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  readonly emitted: { channel: string; data: unknown }[] = [];

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    // Snapshot the handler set before dispatch: a handler that unsubscribes
    // itself mid-emit must not skip a sibling handler (matches Pi's bus).
    for (const handler of [...(this.handlers.get(channel) ?? [])]) {
      handler(data);
    }
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return (): void => {
      set.delete(handler);
    };
  }

  subscriberCount(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0;
  }
}

/**
 * The companion's fake `PlacementHost`/`ChildReporterHost` (§4.2/§5.7.1):
 * `events` is whatever the test hands in (a `FakeBus`, `undefined`, or a
 * malformed shape — G2's probe rows); `on(event, handler)` records every
 * event name seen, in call order (`onCalls`), and keeps every handler
 * registered for `event` so `emit()` can invoke them synchronously in
 * registration order (structurally satisfies both `PlacementHost` — which
 * types only `on("session_shutdown", ...)` — and `ChildReporterHost`, which
 * types `session_start` / `agent_start` / `agent_settled` /
 * `session_shutdown` too; the widened signature is a superset).
 */
export interface FakePlacementHost {
  readonly events: unknown;
  /** Every event name `on` was called with, in call order. */
  readonly onCalls: readonly string[];
  /** Invoke every handler registered for `event`, in registration order, synchronously; returns their return values. */
  emit(event: string, ...args: unknown[]): unknown[];
  /** = emit("session_shutdown", { reason: "quit" }, fakeCtx()) — keeps G8/G9/H5 readable. */
  shutdown(): void;
  on(event: string, handler: (...args: never[]) => unknown): unknown;
}

export function fakeHost(events: unknown): FakePlacementHost {
  const onCalls: string[] = [];
  const handlers = new Map<string, ((...args: never[]) => unknown)[]>();
  return {
    events,
    onCalls,
    on(event: string, handler: (...args: never[]) => unknown): unknown {
      onCalls.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return undefined;
    },
    emit(event: string, ...args: unknown[]): unknown[] {
      const list = handlers.get(event) ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return list.map((handler) => (handler as any)(...args));
    },
    shutdown(): void {
      const list = handlers.get("session_shutdown") ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const handler of list) (handler as any)({ reason: "quit" }, fakeCtx());
    },
  };
}

/**
 * Builds a `ChildReporterContext` literal (§6 preamble): default
 * `{ mode: "tui", idle: true, sessionId: "sid-1", sessionFile: undefined,
 * sessionName: "worker#ab12cd34" }`. `omitGetSessionName` drops
 * `getSessionName` from the returned `sessionManager` entirely (M3's "a ctx
 * whose sessionManager lacks getSessionName" row) rather than setting it
 * `undefined`, since the reporter probes with `typeof … === "function"`.
 */
export function fakeCtx(
  overrides: Partial<{
    mode: string;
    idle: boolean;
    sessionId: string;
    sessionFile: string | undefined;
    sessionName: string | undefined;
    omitGetSessionName: boolean;
  }> = {},
): ChildReporterContext {
  const mode = overrides.mode ?? "tui";
  const idle = overrides.idle ?? true;
  const sessionId = overrides.sessionId ?? "sid-1";
  const sessionFile = "sessionFile" in overrides ? overrides.sessionFile : undefined;
  const sessionName = "sessionName" in overrides ? overrides.sessionName : "worker#ab12cd34";
  const omitGetSessionName = overrides.omitGetSessionName ?? false;

  const sessionManager: ChildReporterContext["sessionManager"] = omitGetSessionName
    ? {
        getSessionId: (): string => sessionId,
        getSessionFile: (): string | undefined => sessionFile,
      }
    : {
        getSessionId: (): string => sessionId,
        getSessionFile: (): string | undefined => sessionFile,
        getSessionName: (): string | undefined => sessionName,
      };

  return {
    mode,
    isIdle: (): boolean => idle,
    sessionManager,
  };
}
