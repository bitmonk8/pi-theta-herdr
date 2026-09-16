// RFC 0012 Phase 2 seam sheet §5.G — `src/extension.ts` (`registerHerdrPlacement`,
// `probePlacementEventBus`, the default export).
import { describe, expect, it, vi } from "vitest";
import type { SubagentPlacementBackend } from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piThetaHerdr, { probePlacementEventBus, registerHerdrPlacement, type PlacementHost } from "../src/extension.ts";
import { PLACEMENT_DISCOVER_CHANNEL, PLACEMENT_OFFER_CHANNEL } from "../src/protocol.ts";
import { FakeBus, fakeHost } from "./helpers/fake-host.ts";

function stubBackend(name = "herdr"): SubagentPlacementBackend {
  return {
    name,
    priority: 50,
    capabilities: { visible: true, inheritsEnv: true },
    detect: (): boolean => true,
    place: () => {
      throw new Error("not exercised in this suite");
    },
  };
}

describe("§5.G registration", () => {
  it("G1 a host with no events is a no-op: on is never called, nothing throws", () => {
    const host = fakeHost(undefined);
    expect(() => registerHerdrPlacement(host)).not.toThrow();
    expect(host.onCalls).toEqual([]);
  });

  it("G2 a malformed events shape probes to undefined and is a no-op", () => {
    for (const events of [null, 42, { on: 1, emit: (): void => {} }, { on: (): (() => void) => (): void => {} }]) {
      const host = fakeHost(events);
      expect(() => registerHerdrPlacement(host)).not.toThrow();
      expect(host.onCalls).toEqual([]);
      expect(probePlacementEventBus(events)).toBeUndefined();
    }
  });

  it("G3 a well-formed bus gets exactly one discover subscription, no offer subscription, no emission, and a shutdown handler", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    const backend = stubBackend();
    registerHerdrPlacement(host, { backend });
    expect(bus.subscriberCount(PLACEMENT_DISCOVER_CHANNEL)).toBe(1);
    expect(bus.subscriberCount(PLACEMENT_OFFER_CHANNEL)).toBe(0);
    expect(bus.emitted).toHaveLength(0);
    expect(host.onCalls).toEqual(["session_shutdown"]);
  });

  it("G4 a discover event calls register synchronously with the exact backend object", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    const backend = stubBackend();
    registerHerdrPlacement(host, { backend });
    const registered: SubagentPlacementBackend[] = [];
    let calledBeforeEmitReturns = false;
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, {
      apiVersion: 1,
      register: (candidate: SubagentPlacementBackend): void => {
        registered.push(candidate);
        calledBeforeEmitReturns = true;
      },
    });
    expect(calledBeforeEmitReturns).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBe(backend);
  });

  it("G5 a second discover (a hot-reload re-compose) still calls register only once (the P1 latch)", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: stubBackend() });
    const registered: unknown[] = [];
    const payload = { apiVersion: 1, register: (b: unknown): void => registered.push(b) };
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, payload);
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, payload);
    expect(registered).toHaveLength(1);
  });

  it("G6 a discover payload naming a different apiVersion is ignored", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: stubBackend() });
    const registered: unknown[] = [];
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, { apiVersion: 2, register: (b: unknown): void => registered.push(b) });
    expect(registered).toHaveLength(0);
  });

  it("G7 malformed discover payloads are ignored without throwing", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: stubBackend() });
    for (const payload of [null, "x", {}, { apiVersion: 1 }, { apiVersion: 1, register: 5 }]) {
      expect(() => bus.emit(PLACEMENT_DISCOVER_CHANNEL, payload)).not.toThrow();
    }
  });

  it("G8 session_shutdown releases the discover subscription; a later discover calls nothing", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: stubBackend() });
    const registered: unknown[] = [];
    const payload = { apiVersion: 1, register: (b: unknown): void => registered.push(b) };
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, payload);
    expect(registered).toHaveLength(1);

    host.shutdown();
    expect(bus.subscriberCount(PLACEMENT_DISCOVER_CHANNEL)).toBe(0);

    bus.emit(PLACEMENT_DISCOVER_CHANNEL, payload);
    expect(registered).toHaveLength(1);
  });

  it("G9 a fresh factory run on a new session (P3) registers the new instance's backend", () => {
    const bus = new FakeBus();
    const host1 = fakeHost(bus);
    const backend1 = stubBackend();
    registerHerdrPlacement(host1, { backend: backend1 });
    host1.shutdown();

    const host2 = fakeHost(bus);
    const backend2 = stubBackend();
    registerHerdrPlacement(host2, { backend: backend2 });
    const registered: unknown[] = [];
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, { apiVersion: 1, register: (b: unknown): void => registered.push(b) });
    expect(registered).toEqual([backend2]);
  });

  it("G10 the default backend (deps.backend omitted) satisfies pi-theta's validatePlacementBackend and is named 'herdr'", async () => {
    const { validatePlacementBackend } = await import(
      "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts"
    );
    const bus = new FakeBus();
    const host = fakeHost(bus);
    registerHerdrPlacement(host);
    let captured: SubagentPlacementBackend | undefined;
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, {
      apiVersion: 1,
      register: (b: SubagentPlacementBackend): void => {
        captured = b;
      },
    });
    expect(captured?.name).toBe("herdr");
    const verdict = validatePlacementBackend(captured);
    expect(verdict.ok).toBe(true);
  });

  it("G11 two companion copies on the same host both call register on one discover (the duplicate is pi-theta's registry's concern, pinned in H4)", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: stubBackend() });
    registerHerdrPlacement(host, { backend: stubBackend() });
    const registered: unknown[] = [];
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, { apiVersion: 1, register: (b: unknown): void => registered.push(b) });
    expect(registered).toHaveLength(2);
  });

  it("G12 the default export delegates to registerHerdrPlacement", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    const onSpy = vi.spyOn(bus, "on");
    piThetaHerdr(host as unknown as ExtensionAPI);
    expect(onSpy).toHaveBeenCalledWith(PLACEMENT_DISCOVER_CHANNEL, expect.any(Function));
    expect(bus.subscriberCount(PLACEMENT_DISCOVER_CHANNEL)).toBe(1);
  });
});

// PlacementHost is exercised structurally throughout (fakeHost() satisfies it);
// referenced here so an accidental removal of the export reds the typecheck.
const _typeCheck: PlacementHost = fakeHost(undefined);
void _typeCheck;
