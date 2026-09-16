import type { SubagentPlacementBackend } from "@bitmonk8/pi-theta/src/runtime/subagent-placement";

// RFC 0012 §5 registration protocol, carried as the companion's own literals
// (Decision D1). Pinned equal to pi-theta's PLACEMENT_DISCOVER_CHANNEL /
// PLACEMENT_OFFER_CHANNEL / PLACEMENT_REGISTRATION_API_VERSION
// (src/runtime/subagent-placement-registry.ts) by tests/conformance/protocol-literals.test.ts.
export const PLACEMENT_DISCOVER_CHANNEL = "pi-theta:subagent-placement:discover:v1";
export const PLACEMENT_OFFER_CHANNEL = "pi-theta:subagent-placement:offer:v1";
export const PLACEMENT_REGISTRATION_API_VERSION = 1;

/** The discover payload pi-theta emits (`PlacementDiscoverPayload` at the pin). */
export interface PlacementDiscoverPayload {
  readonly apiVersion: typeof PLACEMENT_REGISTRATION_API_VERSION;
  register(backend: SubagentPlacementBackend): void;
}

export function isPlacementDiscoverPayload(data: unknown): data is PlacementDiscoverPayload {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record["apiVersion"] === PLACEMENT_REGISTRATION_API_VERSION && typeof record["register"] === "function";
}
