// RFC 0012 Phase 2 seam sheet §5.H6-H7 — the companion backend run through
// pi-theta's REAL `selectPlacement` / `placementUnavailableDiagnostic` /
// `orderForAuto`.
import { describe, expect, it } from "vitest";
import {
  createPipePlacementBackend,
  type SubagentPlacementBackend,
} from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";
import {
  placementUnavailableDiagnostic,
  selectPlacement,
  type PlacementSelection,
} from "@bitmonk8/pi-theta/src/runtime/subagent-placement-selection.ts";
import { createHerdrPlacementBackend } from "../../src/herdr-placement-backend.ts";
import type { HerdrClient, HerdrPaneEnv } from "../../src/herdr-client.ts";

function stubClient(pane: HerdrPaneEnv | null): HerdrClient {
  return {
    env: (): HerdrPaneEnv | null => pane,
    request: async (): Promise<unknown> => undefined,
    layoutApplyPane: async (): Promise<string> => "w1:p9",
    paneClose: async (): Promise<void> => {},
    paneRename: async (): Promise<void> => {},
    paneReportMetadata: async (): Promise<void> => {},
    paneReportAgent: async (): Promise<void> => {},
    paneReportAgentSession: async (): Promise<void> => {},
  };
}

const PANE: HerdrPaneEnv = { socketPath: "s", paneId: "w1:p1", workspaceId: "w1" };

function pipe(): SubagentPlacementBackend {
  return createPipePlacementBackend(() => {
    throw new Error("not exercised — the pipe backend is never spawned in this suite");
  });
}

function otherBackend(name: string, priority: number, detected: boolean): SubagentPlacementBackend {
  return {
    name,
    priority,
    detect: (): boolean => detected,
    place: () => {
      throw new Error("not exercised in this suite");
    },
  };
}

describe("§5.H6 selectPlacement over the companion backend", () => {
  it("H6 auto picks herdr when detected, falls back to pipe when not, and an explicit unmatched/unregistered selector refuses with the exact reasons", () => {
    const detected = createHerdrPlacementBackend({ client: stubClient(PANE) });
    const undetected = createHerdrPlacementBackend({ client: stubClient(null) });

    const autoDetected = selectPlacement({ selector: "auto", registered: [detected], exec: undefined, pipe: pipe() });
    expect(autoDetected).toEqual({ ok: true, backend: detected });

    const pipeFallback = pipe();
    const autoUndetected = selectPlacement({
      selector: "auto",
      registered: [undetected],
      exec: undefined,
      pipe: pipeFallback,
    });
    expect(autoUndetected).toEqual({ ok: true, backend: pipeFallback });

    const explicitUndetected = selectPlacement({
      selector: "herdr",
      registered: [undetected],
      exec: undefined,
      pipe: pipe(),
    });
    expect(explicitUndetected).toEqual({
      ok: false,
      name: "herdr",
      reason: "the backend is not detected in this environment",
    });

    const explicitUnregistered = selectPlacement({ selector: "herdr", registered: [], exec: undefined, pipe: pipe() });
    expect(explicitUnregistered).toEqual({ ok: false, name: "herdr", reason: "no registered backend has this name" });

    const diagnostic = placementUnavailableDiagnostic(
      explicitUndetected as Extract<PlacementSelection, { ok: false }>,
      "x.theta",
    );
    expect(diagnostic.message).toBe("subagent placement 'herdr' is unavailable: the backend is not detected in this environment");
    expect(diagnostic.code).toBe("theta/load/subagent-placement-unavailable");
  });
});

describe("§5.H7 auto ranking pins D3's priority semantics", () => {
  it("H7 herdr (priority 50) wins over a lower-priority detected rival and loses to a higher-priority one", () => {
    const herdr = createHerdrPlacementBackend({ client: stubClient(PANE) });
    const lowerRival = otherBackend("lower", 10, true);
    const winLow = selectPlacement({ selector: "auto", registered: [herdr, lowerRival], exec: undefined, pipe: pipe() });
    expect(winLow).toEqual({ ok: true, backend: herdr });

    const higherRival = otherBackend("higher", 90, true);
    const loseHigh = selectPlacement({
      selector: "auto",
      registered: [herdr, higherRival],
      exec: undefined,
      pipe: pipe(),
    });
    expect(loseHigh).toEqual({ ok: true, backend: higherRival });
  });
});
