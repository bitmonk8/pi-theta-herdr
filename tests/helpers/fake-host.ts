// `FakeBus` copied from pi-theta's `tests/subagent-placement-registry.test.ts`
// (the minimal in-memory `EventBus` matching the pin's `emit` / `on ->
// unsubscribe` contract; pi-theta's own `files` does not ship `tests/`, so
// this is copied text, not an import) — source:
// `C:/UnitySrc/pi-theta/tests/subagent-placement-registry.test.ts`, class
// `FakeBus`. Plus the companion's own fake `PlacementHost` (seam sheet §4.2).

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
 * The companion's fake `PlacementHost` (§4.2): `events` is whatever the test
 * hands in (a `FakeBus`, `undefined`, or a malformed shape — G2's probe
 * rows); `on("session_shutdown", handler)` records the call and captures the
 * handler so a test can invoke it directly (simulating Pi's real
 * `session_shutdown` emission without a real session).
 */
export interface FakePlacementHost {
  readonly events: unknown;
  /** Every event name `on` was called with, in call order. */
  readonly onCalls: readonly string[];
  /** Invoke the captured `session_shutdown` handler, if one was registered. */
  shutdown(): void;
  on(event: "session_shutdown", handler: () => void): unknown;
}

export function fakeHost(events: unknown): FakePlacementHost {
  const onCalls: string[] = [];
  let shutdownHandler: (() => void) | undefined;
  return {
    events,
    onCalls,
    on(event: "session_shutdown", handler: () => void): unknown {
      onCalls.push(event);
      if (event === "session_shutdown") {
        shutdownHandler = handler;
      }
      return undefined;
    },
    shutdown(): void {
      shutdownHandler?.();
    },
  };
}
