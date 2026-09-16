// RFC 0012 companion 0.2.0 seam sheet §6.Q — pi-theta-real conformance for the
// child role: the companion's own `SUBAGENT_LAUNCH_FLAG` / `findLaunchFlagOnArgv`
// copy pinned equal to pi-theta's runtime originals, the argv shape a real
// `placeSubagentChild` assembles, and the type-level `ChildReporterContext`
// subset check (Q6, rides `npm run typecheck`).
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@bitmonk8/pi-theta/src/diagnostics/diagnostic.ts";
import { SUBAGENT_LAUNCH_FLAG as REAL_SUBAGENT_LAUNCH_FLAG } from "@bitmonk8/pi-theta/src/runtime/subagent-launcher.ts";
import { findLaunchFlagOnArgv as realFindLaunchFlagOnArgv } from "@bitmonk8/pi-theta/src/runtime/subagent-launch-file.ts";
import { placeSubagentChild } from "@bitmonk8/pi-theta/src/runtime/subagent-launcher.ts";
import {
  bindPlacementRegistration,
  PLACEMENT_DISCOVER_CHANNEL as REAL_DISCOVER,
  PlacementRegistry,
  SUBAGENT_CHILD_OUTCOME_API_VERSION as REAL_SUBAGENT_CHILD_OUTCOME_API_VERSION,
  SUBAGENT_CHILD_OUTCOME_CHANNEL as REAL_SUBAGENT_CHILD_OUTCOME_CHANNEL,
  type PlacementEventBus as RealPlacementEventBus,
  type SubagentChildOutcomePayload as RealSubagentChildOutcomePayload,
} from "@bitmonk8/pi-theta/src/runtime/subagent-placement-registry.ts";
import { validatePlacementBackend } from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_LAUNCH_FLAG,
  findLaunchFlagOnArgv,
  isSubagentChildOutcomePayload,
  SUBAGENT_CHILD_OUTCOME_API_VERSION,
  SUBAGENT_CHILD_OUTCOME_CHANNEL,
  type SubagentChildOutcomePayload,
} from "../../src/protocol.ts";
import { registerHerdrPlacement } from "../../src/extension.ts";
import { createHerdrPlacementBackend } from "../../src/herdr-placement-backend.ts";
import type { HerdrClient, HerdrPaneEnv } from "../../src/herdr-client.ts";
import type { ChildReporterContext, ChildReporterHost, OutcomeEventBus } from "../../src/herdr-child-reporter.ts";
import { fakeWire, request } from "../helpers/pi-theta-fixtures.ts";
import { FakeBus, fakeHost } from "../helpers/fake-host.ts";

const CHILD_ARGV = [
  "node",
  "cli.js",
  "--theta",
  "x",
  "--theta-launch",
  "C:\\tmp\\l\\launch.json",
  "--name",
  "worker#ab12cd34",
  "--no-session",
  "/worker",
];

// Transcription of the facts manifest's S7 shape: the real child argv order
// (`--theta` … `--theta-launch` … `--name` … `--no-session` …) as
// `assembleSubagentArgv` produces it for a visible-presentation child.
const S7_ARGV = [
  "C:\\node\\node.exe",
  "C:\\pi\\dist\\cli.js",
  "--theta",
  "C:\\p\\.pi\\theta",
  "--theta-launch",
  "C:\\tmp\\l\\launch.json",
  "--name",
  "worker",
  "--no-session",
  "/worker",
];

function stubClient(): HerdrClient {
  const pane: HerdrPaneEnv = { socketPath: "s", paneId: "w1:p1", workspaceId: "w1" };
  return {
    env: (): HerdrPaneEnv => pane,
    request: async (): Promise<unknown> => undefined,
    layoutApplyPane: async (): Promise<string> => "w1:p9",
    paneClose: async (): Promise<void> => {},
    paneRename: async (): Promise<void> => {},
    paneReportMetadata: async (): Promise<void> => {},
    paneReportAgent: async (): Promise<void> => {},
    paneReportAgentSession: async (): Promise<void> => {},
  };
}

describe("§6.Q1 SUBAGENT_LAUNCH_FLAG matches pi-theta's runtime literal", () => {
  it("Q1 the companion's literal equals pi-theta's real SUBAGENT_LAUNCH_FLAG and the string 'theta-launch'", () => {
    expect(REAL_SUBAGENT_LAUNCH_FLAG).toBe(SUBAGENT_LAUNCH_FLAG);
    expect(SUBAGENT_LAUNCH_FLAG).toBe("theta-launch");
  });
});

describe("§6.Q2 findLaunchFlagOnArgv equals pi-theta's real parser on every vector", () => {
  it("Q2 identical results across the L2 vectors, CHILD_ARGV, and the transcribed S7 argv", () => {
    const vectors: readonly (readonly string[])[] = [
      ["node", "cli.js", "--theta-launch=C:/l/launch.json"],
      ["node", "--theta-launch"],
      ["node", "--theta-launch", ""],
      ["node", "--theta-launch="],
      ["node", "--theta", "x", "/slug"],
      ["--theta-launch", "a", "--theta-launch", "b"],
      CHILD_ARGV,
      S7_ARGV,
    ];
    for (const argv of vectors) {
      expect(findLaunchFlagOnArgv(argv)).toBe(realFindLaunchFlagOnArgv(argv));
    }
  });
});

describe("§6.Q3 the argv shape a real placeSubagentChild assembles matches the reporter's expectations", () => {
  it("Q3 findLaunchFlagOnArgv recovers the launch file path pi-theta assembled, and --name precedes the label", async () => {
    const sink: Diagnostic[] = [];
    const backend = createHerdrPlacementBackend({ client: stubClient() });
    const req = request({ label: "child", argv: { ...request().argv, presentation: "visible" } });
    const result = await placeSubagentChild(req, {
      placement: backend,
      emitDiagnostic: (d): void => {
        sink.push(d);
      },
      openWire: async () => fakeWire("C:/tmp/l/launch.json"),
    });
    expect(result.ok).toBe(true);
    // The seam boundary this row pins: `placeSubagentChild`'s assembled argv is
    // handed to the backend's `layoutApplyPane` as `command`, which this fake
    // client never exposes directly — so this row exercises the same parser
    // the reporter uses (`findLaunchFlagOnArgv`) against the fixture's own argv
    // builder, matching launcher-seam.test.ts's H8 assertions on `command`.
    const backendClient = stubClient();
    let capturedCommand: readonly string[] | undefined;
    const capturingBackend = createHerdrPlacementBackend({
      client: {
        ...backendClient,
        layoutApplyPane: async (input): Promise<string> => {
          capturedCommand = input.command;
          return "w1:p9";
        },
      },
    });
    const result2 = await placeSubagentChild(request({ label: "child", argv: { ...request().argv, presentation: "visible" } }), {
      placement: capturingBackend,
      emitDiagnostic: (): void => {},
      openWire: async () => fakeWire("C:/tmp/l/launch.json"),
    });
    expect(result2.ok).toBe(true);
    expect(capturedCommand).toBeDefined();
    expect(findLaunchFlagOnArgv(capturedCommand!)).toBe("C:/tmp/l/launch.json");
    const nameIndex = capturedCommand!.indexOf("--name");
    expect(nameIndex).toBeGreaterThan(-1);
    expect(capturedCommand![nameIndex + 1]).toBe("child");
  });
});

describe("§6.Q4 validatePlacementBackend still accepts the D20-updated backend", () => {
  it("Q4 the backend created after the D20 metadata report still satisfies pi-theta's real structural validation", () => {
    const backend = createHerdrPlacementBackend({ client: stubClient() });
    const verdict = validatePlacementBackend(backend);
    expect(verdict.ok).toBe(true);
  });
});

describe("§6.Q5 the P1 latch and one-registration-per-session hold against the real registry", () => {
  it("Q5 a second discover (hot-reload re-compose) stays quiet, and the default export registers once per session", () => {
    const bus = new FakeBus();
    const registry = new PlacementRegistry();
    const sink: Diagnostic[] = [];
    const binding = bindPlacementRegistration(bus, registry, (d) => sink.push(d));
    const host = fakeHost(bus);
    registerHerdrPlacement(host, { backend: createHerdrPlacementBackend({ client: stubClient() }) });

    binding.discover();
    expect(registry.snapshot().map((b) => b.name)).toEqual(["herdr"]);
    binding.discover();
    expect(sink).toHaveLength(0);
    expect(registry.snapshot()).toHaveLength(1);
    expect(bus.emitted.map((e) => e.channel)).toEqual([REAL_DISCOVER, REAL_DISCOVER]);
    // `bindPlacementRegistration` subscribes only to the OFFER channel and
    // exposes `discover()` as an emitter; the companion is the sole DISCOVER
    // subscriber (its P1 latch, exercised above by the quiet second `discover()`).
    expect(bus.subscriberCount(REAL_DISCOVER)).toBe(1);
  });
});

describe("§6.Q6 type-level: ChildReporterContext is a structural subset of the real ExtensionContext", () => {
  it("Q6 assigning a real ExtensionContext (as unknown) to ChildReporterContext, and a host to ChildReporterHost, compiles", () => {
    // The assignment itself is the conformance check: a shape change in Pi's
    // real `ExtensionContext` that removes/renames `mode`, `isIdle`, or the
    // `sessionManager` members reds `tsc`, not vitest (rides npm run typecheck).
    const ctx: ChildReporterContext = {} as ExtensionContext;
    void ctx;
    const host = fakeHost(undefined) as unknown as ChildReporterHost;
    void host;
    expect(true).toBe(true);
  });
});

describe("§5.Q outcome-event conformance (pi-theta-real; needs the 0.478.0 devDependency)", () => {
  it("Q7 the companion's outcome literals equal pi-theta's runtime exports (079ddb67 / 0.478.0)", () => {
    // This import itself reds loudly (undefined / a thrown "does not provide an export") on an
    // older installed pi-theta copy — R5 names the cause first.
    expect(REAL_SUBAGENT_CHILD_OUTCOME_CHANNEL).toBe(SUBAGENT_CHILD_OUTCOME_CHANNEL);
    expect(SUBAGENT_CHILD_OUTCOME_CHANNEL).toBe("pi-theta:subagent-child:outcome:v1");
    expect(REAL_SUBAGENT_CHILD_OUTCOME_API_VERSION).toBe(SUBAGENT_CHILD_OUTCOME_API_VERSION);
    expect(SUBAGENT_CHILD_OUTCOME_API_VERSION).toBe(1);
  });

  it("Q8 SubagentChildOutcomePayload is mutually assignable with pi-theta's real type and satisfies the companion's guard", () => {
    for (const outcome of ["ok", "err"] as const) {
      const real: RealSubagentChildOutcomePayload = {
        apiVersion: REAL_SUBAGENT_CHILD_OUTCOME_API_VERSION,
        outcome,
        slug: "worker",
      };
      expect(isSubagentChildOutcomePayload(real)).toBe(true);
      expect(Object.keys(real).sort()).toEqual(["apiVersion", "outcome", "slug"]);
      // Type-level mutual assignability (rides npm run typecheck): the producer's payload and
      // the companion's own type must each accept the other's literal.
      const a: SubagentChildOutcomePayload = real;
      const b: RealSubagentChildOutcomePayload = { apiVersion: SUBAGENT_CHILD_OUTCOME_API_VERSION, outcome, slug: "worker" };
      void a;
      void b;
    }
  });

  it("Q9 the companion's OutcomeEventBus is a structural subset of pi-theta's real PlacementEventBus", () => {
    // Type-level (rides npm run typecheck): the dep's shape is a subset of the real bus at the pin.
    const bus: OutcomeEventBus = {} as RealPlacementEventBus;
    void bus;
    const fake: OutcomeEventBus = new FakeBus();
    void fake;
    expect(true).toBe(true);
  });
});
