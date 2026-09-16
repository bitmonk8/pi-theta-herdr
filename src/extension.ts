import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentPlacementBackend } from "@bitmonk8/pi-theta/src/runtime/subagent-placement";
import { createHerdrPlacementBackend } from "./herdr-placement-backend.ts";
import { isPlacementDiscoverPayload, PLACEMENT_DISCOVER_CHANNEL } from "./protocol.ts";
import { attachHerdrChildReporter, type ChildReporterHost } from "./herdr-child-reporter.ts";

/** The `pi.events` surface consumed — `EventBus` at the pin (Pi `dist/core/event-bus.d.ts`). */
export interface PlacementEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** The structural subset of `ExtensionAPI` the registration consumes; tests drive it with a fake. */
export interface PlacementHost {
  readonly events?: unknown;
  on(event: "session_shutdown", handler: () => void): unknown;
}

export interface RegisterHerdrPlacementDeps {
  /** Default `createHerdrPlacementBackend()`. */
  readonly backend?: SubagentPlacementBackend;
}

/**
 * Presence-probe `pi.events` the way pi-theta's factory does (`factory.ts`:
 * `typeof pi.events === "object" && pi.events !== null && typeof pi.events.on ===
 * "function" && typeof pi.events.emit === "function"`). `typeof`-only; nothing is invoked.
 */
export function probePlacementEventBus(events: unknown): PlacementEventBus | undefined {
  if (typeof events !== "object" || events === null) return undefined;
  const record = events as Record<string, unknown>;
  return typeof record["on"] === "function" && typeof record["emit"] === "function"
    ? (events as PlacementEventBus)
    : undefined;
}

/**
 * Register the `herdr` backend with pi-theta over the RFC 0012 §5 discover
 * channel. One subscription, made in the factory body; one `register` call per
 * session (P1: pi-theta emits discover on every compose pass — initial and every
 * hot-reload re-compose — without clearing its registry, and a repeat `register`
 * under the same name draws `theta/load/subagent-placement-invalid`); released
 * at `session_shutdown` (RFC §5; pi-theta's own `factory.ts` releases its offer
 * subscription there). No offer is emitted (Decision D8, §4.3). No `pi.events`
 * (an older host) ⇒ no-op: pi-theta then runs built-ins only. (The latch is
 * redundant since pi-theta 0.477.0 made identical-object re-registration a
 * no-op; kept for older pins.)
 */
export function registerHerdrPlacement(host: PlacementHost, deps: RegisterHerdrPlacementDeps = {}): void {
  const events = probePlacementEventBus(host.events);
  if (events === undefined) {
    return;
  }
  const backend = deps.backend ?? createHerdrPlacementBackend();
  let registeredThisSession = false;
  const unsubscribe = events.on(PLACEMENT_DISCOVER_CHANNEL, (data: unknown): void => {
    if (!isPlacementDiscoverPayload(data) || registeredThisSession) {
      return;
    }
    registeredThisSession = true;
    data.register(backend);
  });
  host.on("session_shutdown", (): void => {
    registeredThisSession = false;
    unsubscribe();
  });
}

/**
 * Pi's extension factory. Parent role: register the `herdr` placement backend (0.1.0).
 * Child role (0.2.0): when this process is a placed theta child in a Herdr pane
 * (`--theta-launch` on argv + the pane env), report its own pane's agent lifecycle so
 * Herdr's agents list shows it — observed on Herdr 0.8.0: reports from `herdr:pi` inside
 * a theta child were acknowledged but not applied, while custom-source reports on the
 * same kind of pane are applied. 0.3.0: the child role also consumes pi-theta's
 * `pi-theta:subagent-child:outcome:v1` event (pi-theta ≥ 0.478.0) off the same
 * `pi.events` bus the parent role registers over — `ok` settles the pane, `err` retitles
 * it `FAILED <label>`. The bus is probed once here and handed to both roles' entry points.
 */
export default function piThetaHerdr(pi: ExtensionAPI): void {
  const host = pi as unknown as PlacementHost;
  registerHerdrPlacement(host);
  const events = probePlacementEventBus(host.events);
  attachHerdrChildReporter(pi as unknown as ChildReporterHost, events !== undefined ? { events } : {});
}
