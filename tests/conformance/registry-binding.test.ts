// RFC 0012 Phase 2 seam sheet §5.H3-H5 — the companion's registration against
// pi-theta's REAL `PlacementRegistry` + `bindPlacementRegistration`, proving
// the P1 latch keeps a re-discover quiet and the duplicate-registration W
// fires with pi-theta's exact message when it should.
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@bitmonk8/pi-theta/src/diagnostics/diagnostic.ts";
import {
  bindPlacementRegistration,
  PLACEMENT_DISCOVER_CHANNEL as REAL_DISCOVER,
  PlacementRegistry,
} from "@bitmonk8/pi-theta/src/runtime/subagent-placement-registry.ts";
import { registerHerdrPlacement } from "../../src/extension.ts";
import { createHerdrPlacementBackend } from "../../src/herdr-placement-backend.ts";
import type { HerdrClient, HerdrPaneEnv } from "../../src/herdr-client.ts";
import { FakeBus, fakeHost } from "../helpers/fake-host.ts";

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

describe("§5.H3 real PlacementRegistry + real bindPlacementRegistration + the companion factory", () => {
  it("H3 discover registers the companion once, and a second discover (hot-reload re-compose) is quiet", () => {
    const bus = new FakeBus();
    const registry = new PlacementRegistry();
    const sink: Diagnostic[] = [];
    const binding = bindPlacementRegistration(bus, registry, (d) => sink.push(d));
    const host = fakeHost(bus);
    const backend = createHerdrPlacementBackend({ client: stubClient() });
    registerHerdrPlacement(host, { backend });

    binding.discover();
    expect(registry.get("herdr")).toBe(backend);
    expect(registry.snapshot().map((b) => b.name)).toEqual(["herdr"]);
    expect(sink).toHaveLength(0);

    binding.discover();
    expect(sink).toHaveLength(0);
    expect(registry.snapshot()).toHaveLength(1);
    expect(bus.emitted.map((e) => e.channel)).toEqual([REAL_DISCOVER, REAL_DISCOVER]);
  });

  it("H4 two companion factory instances draw pi-theta's exact duplicate-registration W on the second register", () => {
    const bus = new FakeBus();
    const registry = new PlacementRegistry();
    const sink: Diagnostic[] = [];
    const binding = bindPlacementRegistration(bus, registry, (d) => sink.push(d));
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: createHerdrPlacementBackend({ client: stubClient() }) });
    registerHerdrPlacement(host, { backend: createHerdrPlacementBackend({ client: stubClient() }) });

    binding.discover();
    expect(sink).toHaveLength(1);
    expect(sink[0]!.code).toBe("theta/load/subagent-placement-invalid");
    expect(sink[0]!.severity).toBe("warning");
    expect(sink[0]!.message).toBe(
      "ignoring subagent placement registration 'herdr': a backend with this name is already registered",
    );
  });

  it("H5 session_shutdown + registry.clear() + a fresh factory + re-discover registers cleanly, no diagnostic", () => {
    const bus = new FakeBus();
    const registry = new PlacementRegistry();
    const sink: Diagnostic[] = [];
    const binding = bindPlacementRegistration(bus, registry, (d) => sink.push(d));
    const host1 = fakeHost(bus);
    registerHerdrPlacement(host1, { backend: createHerdrPlacementBackend({ client: stubClient() }) });
    binding.discover();
    expect(sink).toHaveLength(0);

    host1.shutdown();
    binding.unsubscribe();
    registry.clear();

    const bus2 = new FakeBus();
    const registry2 = new PlacementRegistry();
    const sink2: Diagnostic[] = [];
    const binding2 = bindPlacementRegistration(bus2, registry2, (d) => sink2.push(d));
    const host2 = fakeHost(bus2);
    registerHerdrPlacement(host2, { backend: createHerdrPlacementBackend({ client: stubClient() }) });
    binding2.discover();
    expect(sink2).toHaveLength(0);
    expect(registry2.snapshot().map((b) => b.name)).toEqual(["herdr"]);
  });
});
