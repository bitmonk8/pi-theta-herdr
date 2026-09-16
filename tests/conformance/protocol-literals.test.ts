// RFC 0012 Phase 2 seam sheet §5.H1-H2 — the companion's protocol literals and
// backend must equal / satisfy pi-theta's REAL runtime exports (the drift
// guard Decision D1 depends on: the companion carries its own literal
// constants, never a runtime import of pi-theta, but a mismatch must red
// here).
import { describe, expect, it } from "vitest";
import {
  PLACEMENT_DISCOVER_CHANNEL as REAL_DISCOVER,
  PLACEMENT_OFFER_CHANNEL as REAL_OFFER,
  PLACEMENT_REGISTRATION_API_VERSION as REAL_API_VERSION,
} from "@bitmonk8/pi-theta/src/runtime/subagent-placement-registry.ts";
import {
  isPipePlacement,
  placementInheritsEnv,
  placementIsVisible,
  PLACEMENT_NAME_PATTERN,
  RESERVED_PLACEMENT_NAMES,
  validatePlacementBackend,
} from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";
import { PLACEMENT_DISCOVER_CHANNEL, PLACEMENT_OFFER_CHANNEL, PLACEMENT_REGISTRATION_API_VERSION } from "../../src/protocol.ts";
import { createHerdrPlacementBackend } from "../../src/herdr-placement-backend.ts";
import type { HerdrClient, HerdrPaneEnv } from "../../src/herdr-client.ts";

function stubClient(): HerdrClient {
  const pane: HerdrPaneEnv = { socketPath: "s", paneId: "w1:p1", workspaceId: "w1" };
  return {
    env: (): HerdrPaneEnv => pane,
    request: async (): Promise<unknown> => undefined,
    layoutApplyPane: async (): Promise<string> => "w1:p9",
    paneClose: async (): Promise<void> => {},
    paneRename: async (): Promise<void> => {},
    paneReportMetadata: async (): Promise<void> => {},
  };
}

describe("§5.H1 the companion's protocol literals equal pi-theta's real ones", () => {
  it("H1 discover / offer channel names and the api version match pi-theta's runtime exports and their exact string/number values", () => {
    expect(PLACEMENT_DISCOVER_CHANNEL).toBe(REAL_DISCOVER);
    expect(PLACEMENT_OFFER_CHANNEL).toBe(REAL_OFFER);
    expect(PLACEMENT_REGISTRATION_API_VERSION).toBe(REAL_API_VERSION);
    expect(PLACEMENT_DISCOVER_CHANNEL).toBe("pi-theta:subagent-placement:discover:v1");
    expect(PLACEMENT_OFFER_CHANNEL).toBe("pi-theta:subagent-placement:offer:v1");
    expect(PLACEMENT_REGISTRATION_API_VERSION).toBe(1);
  });
});

describe("§5.H2 the companion backend satisfies pi-theta's real structural validation", () => {
  it("H2 validatePlacementBackend, the name grammar/reservation, and the capability predicates all agree", () => {
    const backend = createHerdrPlacementBackend({ client: stubClient() });
    const verdict = validatePlacementBackend(backend);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.backend).toBe(backend);
    }
    expect(PLACEMENT_NAME_PATTERN.test("herdr")).toBe(true);
    expect(RESERVED_PLACEMENT_NAMES.includes("herdr")).toBe(false);
    expect(placementIsVisible(backend)).toBe(true);
    expect(placementInheritsEnv(backend)).toBe(true);
    expect(isPipePlacement(backend)).toBe(false);
  });
});
