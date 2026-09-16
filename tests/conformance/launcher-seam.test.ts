// RFC 0012 Phase 2 seam sheet §5.H8-H11 — the companion backend run through
// pi-theta's REAL `placeSubagentChild`, plus the type-level conformance row
// (H11) that rides `npm run typecheck`.
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@bitmonk8/pi-theta/src/diagnostics/diagnostic.ts";
import { placeSubagentChild } from "@bitmonk8/pi-theta/src/runtime/subagent-launcher.ts";
import type {
  PlacedChild,
  SubagentPlacementBackend,
  SubagentPlacementRequest,
} from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";
import { createHerdrPlacementBackend, type HerdrPlacementBackendDeps } from "../../src/herdr-placement-backend.ts";
import type { HerdrClient, HerdrPaneEnv, LayoutApplyPaneInput } from "../../src/herdr-client.ts";
import { HerdrRequestError } from "../../src/herdr-client.ts";
import { fakeWire, request } from "../helpers/pi-theta-fixtures.ts";

const PANE: HerdrPaneEnv = { socketPath: "s", paneId: "w1:p1", workspaceId: "w1" };

interface FakeClient extends HerdrClient {
  readonly layoutApplyPaneCalls: LayoutApplyPaneInput[];
}

function fakeClient(resolution: "resolve" | "reject", opts: { paneId?: string } = {}): FakeClient {
  const layoutApplyPaneCalls: LayoutApplyPaneInput[] = [];
  return {
    layoutApplyPaneCalls,
    env: (): HerdrPaneEnv => PANE,
    request: async (): Promise<unknown> => undefined,
    layoutApplyPane: async (input: LayoutApplyPaneInput): Promise<string> => {
      layoutApplyPaneCalls.push(input);
      if (resolution === "reject") {
        throw new HerdrRequestError(
          'herdr layout.apply: {"code":"bad_workspace","message":"unknown workspace"}',
          "layout.apply",
          "refused",
          { code: "bad_workspace", message: "unknown workspace" },
        );
      }
      return opts.paneId ?? "w1:p9";
    },
    paneClose: async (): Promise<void> => {},
    paneRename: async (): Promise<void> => {},
    paneReportMetadata: async (): Promise<void> => {},
  };
}

function backendWith(deps: HerdrPlacementBackendDeps): SubagentPlacementBackend {
  return createHerdrPlacementBackend(deps);
}

describe("§5.H8-H10 real placeSubagentChild over the companion backend", () => {
  it("H8 a successful placement resolves ok:true, sends the argv/label the launcher assembled, and emits no diagnostic", async () => {
    const sink: Diagnostic[] = [];
    const client = fakeClient("resolve", { paneId: "w1:p9" });
    const backend = backendWith({ client });
    const req = request({ label: "child", argv: { ...request().argv, presentation: "visible" } });
    const result = await placeSubagentChild(req, {
      placement: backend,
      emitDiagnostic: (d): void => {
        sink.push(d);
      },
      openWire: async () => fakeWire("C:/tmp/l/launch.json"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placed.handle).toBe("w1:p9");
    expect(sink).toHaveLength(0);

    // Seam sheet §5.H row H8: what the REAL launcher (`assembleSubagentArgv` /
    // `placeSubagentChild` in `@bitmonk8/pi-theta/src/runtime/subagent-launcher.ts`)
    // hands the backend's `layoutApplyPane`, captured on the fake client.
    expect(client.layoutApplyPaneCalls).toHaveLength(1);
    const input = client.layoutApplyPaneCalls[0]!;
    const command = input.command;
    expect(command[0]).toBe(req.host.execPath);
    const flagIndex = command.indexOf("--theta-launch");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(command[flagIndex + 1]).toBe("C:/tmp/l/launch.json");
    expect(command[command.length - 1]).toBe("/child");
    expect(input.tabLabel).toBe("child");
  });

  it("H9 a refused placement resolves ok:false with spawn-failed, abandons the wire, and diagnoses the exact Herdr failure", async () => {
    const sink: Diagnostic[] = [];
    const wire = fakeWire("C:/tmp/l/launch.json");
    const backend = backendWith({ client: fakeClient("reject") });
    const req = request({ label: "child", host: request().host });
    const result = await placeSubagentChild(req, {
      placement: backend,
      emitDiagnostic: (d): void => {
        sink.push(d);
      },
      openWire: async () => wire,
    });
    expect(result).toEqual({ ok: false, reason: "spawn-failed" });
    expect(wire.abandonedCount()).toBe(1);
    expect(sink).toHaveLength(1);
    expect(sink[0]!.code).toBe("theta/runtime/subagent-spawn-failed");
    expect(sink[0]!.message.startsWith("subagent child spawn failed: cannot place 'child' in a herdr tab: herdr layout.apply: ")).toBe(true);
    expect(sink[0]!.message).toContain("(cwd: ");
    expect(sink[0]!.hint).toBe(req.host.execPath);
  });

  it("H10 placed.kill() on the seam-produced PlacedChild issues one paneClose for its handle", async () => {
    const paneClosed: string[] = [];
    const client: HerdrClient = {
      env: (): HerdrPaneEnv => PANE,
      request: async (): Promise<unknown> => undefined,
      layoutApplyPane: async (): Promise<string> => "w1:p9",
      paneClose: async (paneId: string): Promise<void> => {
        paneClosed.push(paneId);
      },
      paneRename: async (): Promise<void> => {},
      paneReportMetadata: async (): Promise<void> => {},
    };
    const backend = backendWith({ client });
    const result = await placeSubagentChild(request({ label: "child" }), {
      placement: backend,
      emitDiagnostic: (): void => {},
      openWire: async () => fakeWire("C:/tmp/l/launch.json"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.placed.kill();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(paneClosed).toEqual(["w1:p9"]);
  });
});

describe("§5.H11 type-level conformance (rides npm run typecheck)", () => {
  it("H11 the companion backend and its placed child assign to pi-theta's real seam types", async () => {
    const client = fakeClient("resolve", { paneId: "w1:p9" });
    // The assignment itself is the conformance check: a seam-shape change in
    // pi-theta's `SubagentPlacementBackend` / `PlacedChild` reds `tsc`, not vitest.
    const b: SubagentPlacementBackend = createHerdrPlacementBackend({ client });
    const req: SubagentPlacementRequest = {
      execPath: "/usr/bin/node",
      args: ["/app/pi/dist/cli.js", "/child"],
      cwd: "/work/project",
      env: { PATH: "/usr/bin" },
      label: "child",
      presentation: "visible",
      launchFile: undefined,
      context: { invokeDepth: 0, parallel: false },
    };
    const c: PlacedChild = await b.place(req);
    expect(c.handle).toBe("w1:p9");
  });
});
