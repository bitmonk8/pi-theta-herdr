// RFC 0012 Phase 2 seam sheet §5.G — `src/extension.ts` (`registerHerdrPlacement`,
// `probePlacementEventBus`, the default export).
import { describe, expect, it, vi } from "vitest";
import type { SubagentPlacementBackend } from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piThetaHerdr, { probePlacementEventBus, registerHerdrPlacement, type PlacementHost } from "../src/extension.ts";
import { PLACEMENT_DISCOVER_CHANNEL, PLACEMENT_OFFER_CHANNEL, SUBAGENT_CHILD_OUTCOME_CHANNEL } from "../src/protocol.ts";
import { FakeBus, fakeCtx, fakeHost } from "./helpers/fake-host.ts";

const CHILD_ARGV_MARKER = ["--theta-launch", "C:\\tmp\\l\\launch.json"];
const CHILD_ENV_MARKERS = {
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "pi-theta-herdr-test-g",
  HERDR_PANE_ID: "w1:p1",
  HERDR_WORKSPACE_ID: "w1",
} as const;

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

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
    const payload = { apiVersion: 1, register: (b: unknown): void => {
        registered.push(b);
      } };
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, payload);
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, payload);
    expect(registered).toHaveLength(1);
  });

  it("G6 a discover payload naming a different apiVersion is ignored", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: stubBackend() });
    const registered: unknown[] = [];
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, { apiVersion: 2, register: (b: unknown): void => {
        registered.push(b);
      } });
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
    const payload = { apiVersion: 1, register: (b: unknown): void => {
        registered.push(b);
      } };
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
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, { apiVersion: 1, register: (b: unknown): void => {
        registered.push(b);
      } });
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
    bus.emit(PLACEMENT_DISCOVER_CHANNEL, { apiVersion: 1, register: (b: unknown): void => {
        registered.push(b);
      } });
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

describe("§6.G additions — both roles in one process", () => {
  it("G13 the default export wires both the placement backend and the child reporter when the child markers hold", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    const savedArgv = [...process.argv];
    const savedEnv = { ...process.env };
    try {
      process.argv.push(...CHILD_ARGV_MARKER);
      Object.assign(process.env, CHILD_ENV_MARKERS);
      piThetaHerdr(host as unknown as ExtensionAPI);
      expect(host.onCalls).toEqual((["session_shutdown", "session_start", "agent_start", "agent_settled", "session_shutdown"]));
      expect(bus.subscriberCount(PLACEMENT_DISCOVER_CHANNEL)).toBe(1);
    } finally {
      process.argv.length = 0;
      process.argv.push(...savedArgv);
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it("G14 the default export with the real process.argv (no --theta-launch marker) gains no reporter handlers", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    // No argv/env mutation: this process's own argv (the vitest worker's) never
    // carries `--theta-launch`, so the child-role gate fails at attach time.
    piThetaHerdr(host as unknown as ExtensionAPI);
    expect(host.onCalls).toEqual(["session_shutdown"]);
  });

  it("G15 both roles fire from one process: registration once, and the child's session_start reports land on the real fake daemon", async () => {
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const fake = await startFakeHerdrServer();
    const savedArgv = [...process.argv];
    const savedEnv = { ...process.env };
    try {
      const bus = new FakeBus();
      const host = fakeHost(bus);
      process.argv.push(...CHILD_ARGV_MARKER);
      Object.assign(process.env, fake.env);
      piThetaHerdr(host as unknown as ExtensionAPI);

      let registerCount = 0;
      bus.emit(PLACEMENT_DISCOVER_CHANNEL, {
        apiVersion: 1,
        register: (): void => {
          registerCount += 1;
        },
      });

      const before = Date.now();
      host.emit("session_start", { reason: "startup" }, fakeCtx());
      const after = Date.now();
      await waitUntil(() => fake.requests.length === 3);

      expect(registerCount).toBe(1);
      expect(fake.requests.map((r) => r.method)).toEqual([
        "pane.report_metadata",
        "pane.report_agent_session",
        "pane.report_agent",
      ]);
      const seqs = fake.requests.map((r) => (r.params as Record<string, unknown>)["seq"] as number);
      expect(seqs[1]).toBe(seqs[0]! + 1);
      expect(seqs[2]).toBe(seqs[1]! + 1);
      expect(seqs[0]!).toBeGreaterThanOrEqual(before * 1000 + 1);
      expect(seqs[0]!).toBeLessThanOrEqual(after * 1000 + 1);
    } finally {
      process.argv.length = 0;
      process.argv.push(...savedArgv);
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      await fake.close();
    }
  });
});

describe("§5.G additions — both roles subscribe over one probed bus", () => {
  it("G16 the default export subscribes both the outcome channel and the discover channel when the child markers hold", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    const savedArgv = [...process.argv];
    const savedEnv = { ...process.env };
    try {
      process.argv.push(...CHILD_ARGV_MARKER);
      Object.assign(process.env, CHILD_ENV_MARKERS);
      piThetaHerdr(host as unknown as ExtensionAPI);
      expect(bus.subscriberCount(SUBAGENT_CHILD_OUTCOME_CHANNEL)).toBe(1);
      expect(bus.subscriberCount(PLACEMENT_DISCOVER_CHANNEL)).toBe(1);
      expect(host.onCalls).toEqual(["session_shutdown", "session_start", "agent_start", "agent_settled", "session_shutdown"]);
    } finally {
      process.argv.length = 0;
      process.argv.push(...savedArgv);
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it("G17 a plain pi process (no child markers) subscribes only as a placement backend", () => {
    const bus = new FakeBus();
    const host = fakeHost(bus);
    piThetaHerdr(host as unknown as ExtensionAPI);
    expect(bus.subscriberCount(SUBAGENT_CHILD_OUTCOME_CHANNEL)).toBe(0);
    expect(bus.subscriberCount(PLACEMENT_DISCOVER_CHANNEL)).toBe(1);
  });

  it("G18 a bus lacking emit (G2's malformed shape) probes to nothing for either role, no throw", () => {
    const bus = { on: (): (() => void) => (): void => {} };
    const host = fakeHost(bus);
    const savedArgv = [...process.argv];
    const savedEnv = { ...process.env };
    try {
      process.argv.push(...CHILD_ARGV_MARKER);
      Object.assign(process.env, CHILD_ENV_MARKERS);
      expect(() => piThetaHerdr(host as unknown as ExtensionAPI)).not.toThrow();
      expect(host.onCalls).toEqual(["session_start", "agent_start", "agent_settled", "session_shutdown"]);
    } finally {
      process.argv.length = 0;
      process.argv.push(...savedArgv);
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it("G19 both roles and the outcome hook fire through the default export in one process", async () => {
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const fake = await startFakeHerdrServer();
    const savedArgv = [...process.argv];
    const savedEnv = { ...process.env };
    try {
      const bus = new FakeBus();
      const host = fakeHost(bus);
      process.argv.push(...CHILD_ARGV_MARKER);
      Object.assign(process.env, fake.env);
      piThetaHerdr(host as unknown as ExtensionAPI);

      host.emit("session_start", { reason: "startup" }, fakeCtx());
      await waitUntil(() => fake.requests.length === 3);

      bus.emit(SUBAGENT_CHILD_OUTCOME_CHANNEL, { apiVersion: 1, outcome: "err", slug: "worker" });
      await waitUntil(() => fake.requests.length === 5);

      expect(fake.requests.slice(3).map((r) => r.method)).toEqual(["pane.rename", "pane.report_agent"]);
      expect((fake.requests[3]!.params as Record<string, unknown>)["label"]).toBe("FAILED worker#ab12cd34");
      const reportParams = fake.requests[4]!.params as Record<string, unknown>;
      expect(reportParams["message"]).toBe("theta returned Err");
      expect(reportParams["state"]).toBe("idle");
    } finally {
      process.argv.length = 0;
      process.argv.push(...savedArgv);
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      await fake.close();
    }
  });
});

describe("0496 real Pi registration order", () => {
  it("G20 an earlier session_start refusal reaches the default companion before activation", async () => {
    // Use the lock-pinned Pi loader/runner and synchronous EventBus, not fakeHost.emit.
    // The inline-factory loader is exported by Pi's internal extensions index, not its
    // package root. No resource discovery, model construction, credentials or user UI.
    const { createEventBus, createExtensionRuntime, ExtensionRunner, SessionManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const { loadExtensionFromFactory } = await import(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
    );
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const fake = await startFakeHerdrServer();
    const savedArgv = process.argv;
    const bus = createEventBus();
    let runner: InstanceType<typeof ExtensionRunner> | undefined;
    try {
      process.argv = [...savedArgv, ...CHILD_ARGV_MARKER];
      for (const [key, value] of Object.entries(fake.env)) vi.stubEnv(key, value);
      vi.stubEnv("PI_THETA_HERDR_REPORT", "1");
      const cwd = process.cwd();
      const runtime = createExtensionRuntime();
      const order: string[] = [];
      const earlier = await loadExtensionFromFactory((pi) => {
        pi.on("session_start", async () => {
          order.push("earlier:emit");
          pi.events.emit(SUBAGENT_CHILD_OUTCOME_CHANNEL, { apiVersion: 1, outcome: "err", slug: "refused" });
          await Promise.resolve();
          order.push("earlier:return");
        });
      }, cwd, bus, runtime, "<earlier-refusal>");
      const companion = await loadExtensionFromFactory(piThetaHerdr, cwd, bus, runtime, "<companion>");
      const later = await loadExtensionFromFactory((pi) => {
        pi.on("session_start", () => { order.push("later:start"); });
      }, cwd, bus, runtime, "<later-observer>");
      const session = SessionManager.inMemory(cwd);
      session.appendSessionInfo("refused#0496");
      // This boundary must never be used; in particular do not construct a ModelRegistry
      // (its defaults discover user model/auth files).
      const models = new Proxy({} as import("@earendil-works/pi-coding-agent").ModelRegistry, {
        get: () => { throw new Error("model access is outside this fixture"); },
      });
      runner = new ExtensionRunner([earlier, companion, later], runtime, cwd, session, models);
      runner.setUIContext(undefined, "tui");
      const errors: unknown[] = [];
      runner.onError((error) => { errors.push(error); });
      await runner.emit({ type: "session_start", reason: "startup" });
      // Quit awaits the reporter's bounded FIFO flush, so no polling/scheduler guess is
      // needed to distinguish the old three startup reports from the fixed five sends.
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      expect(errors).toEqual([]);
      expect(order).toEqual(["earlier:emit", "earlier:return", "later:start"]);
      expect(fake.requests.map((r) => r.method)).toEqual([
        "pane.report_metadata", "pane.report_agent_session", "pane.report_agent", "pane.rename", "pane.report_agent",
      ]);
      expect(fake.requests[3]!.params).toEqual({ pane_id: "w1:p1", label: "FAILED refused#0496" });
      expect(fake.requests[4]!.params).toMatchObject({ state: "idle", message: "theta returned Err" });
      const seqs = [0, 1, 2, 4].map((i) => (fake.requests[i]!.params as Record<string, unknown>)["seq"] as number);
      expect(seqs).toEqual([seqs[0], seqs[0]! + 1, seqs[0]! + 2, seqs[0]! + 3]);
    } finally {
      if (runner !== undefined) await runner.emit({ type: "session_shutdown", reason: "reload" });
      bus.clear();
      process.argv = savedArgv;
      vi.unstubAllEnvs();
      await fake.close();
    }
  });
});

// PlacementHost is exercised structurally throughout (fakeHost() satisfies it);
// referenced here so an accidental removal of the export reds the typecheck.
const _typeCheck: PlacementHost = fakeHost(undefined);
void _typeCheck;
