// RFC 0012 Phase 2 seam sheet §5.E-F — `src/herdr-placement-backend.ts`.
import { describe, expect, it, vi } from "vitest";
import type { SubagentPlacementRequest } from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";
import {
  createHerdrPlacementBackend,
  HerdrPlacementError,
  HERDR_PLACEMENT_NAME,
  HERDR_PLACEMENT_PRIORITY,
  paneEnvOverlay,
} from "../src/herdr-placement-backend.ts";
import {
  HerdrRequestError,
  type HerdrClient,
  type HerdrPaneEnv,
  type LayoutApplyPaneInput,
  type PaneMetadata,
} from "../src/herdr-client.ts";

const PANE: HerdrPaneEnv = { socketPath: "s", paneId: "w1:p2", workspaceId: "w7" };

function sampleRequest(overrides: Partial<SubagentPlacementRequest> = {}): SubagentPlacementRequest {
  return {
    execPath: "C:\\node\\node.exe",
    args: [
      "C:\\pi\\dist\\cli.js",
      "--theta",
      "C:\\p\\.pi\\theta",
      "--name",
      "worker",
      "--no-session",
      "--theta-launch",
      "C:\\tmp\\l\\launch.json",
      "/worker",
    ],
    cwd: "C:\\p",
    env: {
      PATH: "x",
      ANTHROPIC_API_KEY: "sk",
      HERDR_PANE_ID: "w1:p2",
      HERDR_ENV: "1",
      UNDEF: undefined,
      "=C:": "C:\\",
      "": "e",
    },
    label: "worker",
    presentation: "visible",
    launchFile: "C:\\tmp\\l\\launch.json",
    context: { invokeDepth: 1, parallel: true },
    ...overrides,
  };
}

interface FakeClient extends HerdrClient {
  readonly calls: {
    readonly request: unknown[];
    readonly layoutApplyPane: LayoutApplyPaneInput[];
    readonly paneClose: string[];
    readonly paneRename: { paneId: string; label: string }[];
    readonly paneReportMetadata: { paneId: string; metadata: PaneMetadata }[];
  };
}

function fakeClient(overrides: Partial<HerdrClient> = {}): FakeClient {
  const calls = {
    request: [] as unknown[],
    layoutApplyPane: [] as LayoutApplyPaneInput[],
    paneClose: [] as string[],
    paneRename: [] as { paneId: string; label: string }[],
    paneReportMetadata: [] as { paneId: string; metadata: PaneMetadata }[],
  };
  const base: FakeClient = {
    calls,
    env: (): HerdrPaneEnv | null => PANE,
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.request.push({ method, params });
      return undefined;
    }),
    layoutApplyPane: vi.fn(async (input: LayoutApplyPaneInput) => {
      calls.layoutApplyPane.push(input);
      return "w1:p9";
    }),
    paneClose: vi.fn(async (paneId: string) => {
      calls.paneClose.push(paneId);
    }),
    paneRename: vi.fn(async (paneId: string, label: string) => {
      calls.paneRename.push({ paneId, label });
    }),
    paneReportMetadata: vi.fn(async (paneId: string, metadata: PaneMetadata) => {
      calls.paneReportMetadata.push({ paneId, metadata });
    }),
  };
  return { ...base, ...overrides, calls };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("§5.E layoutApplyPane / place()", () => {
  it("E1 place() sends exactly one layoutApplyPane call with the overlay-filtered env, and touches no other client method", async () => {
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    await backend.place(sampleRequest());
    expect(client.layoutApplyPane).toHaveBeenCalledTimes(1);
    expect(client.calls.layoutApplyPane[0]).toEqual({
      workspaceId: "w7",
      tabLabel: "worker",
      command: [
        "C:\\node\\node.exe",
        "C:\\pi\\dist\\cli.js",
        "--theta",
        "C:\\p\\.pi\\theta",
        "--name",
        "worker",
        "--no-session",
        "--theta-launch",
        "C:\\tmp\\l\\launch.json",
        "/worker",
      ],
      cwd: "C:\\p",
      env: { PATH: "x", ANTHROPIC_API_KEY: "sk" },
    });
    expect(client.request).not.toHaveBeenCalled();
    expect(client.paneClose).not.toHaveBeenCalled();
    expect(client.paneRename).not.toHaveBeenCalled();
    expect(client.paneReportMetadata).not.toHaveBeenCalled();
  });

  it("E2 paneEnvOverlay drops undefined/`=`/empty keys and every HERDR_* key, preserving value bytes verbatim", () => {
    const overlay = paneEnvOverlay({
      PATH: "x",
      ANTHROPIC_API_KEY: "sk",
      HERDR_PANE_ID: "w1:p2",
      HERDR_ENV: "1",
      UNDEF: undefined,
      "=C:": "C:\\",
      "": "e",
      MULTI: "a\nb",
      UNI: "h\u00e9llo",
    });
    expect(overlay).toEqual({ PATH: "x", ANTHROPIC_API_KEY: "sk", MULTI: "a\nb", UNI: "h\u00e9llo" });
  });

  it("E3 an empty overlay is still sent as an explicit `env: {}`, never omitted", async () => {
    expect(paneEnvOverlay({})).toEqual({});
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    await backend.place(sampleRequest({ env: {} }));
    expect(client.calls.layoutApplyPane[0]!.env).toEqual({});
  });

  it("E4 layoutApplyPane against the real fake daemon sends the exact params, key order included", async () => {
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const { createHerdrClient } = await import("../src/herdr-client.ts");
    const fake = await startFakeHerdrServer();
    try {
      fake.script((request, socket) => {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            result: {
              type: "layout_apply",
              layout: { root: { type: "pane", pane_id: "w1:p9" }, focused_pane_id: "w1:p9" },
            },
          })}\n`,
        );
        socket.end();
      });
      const client = createHerdrClient({ env: fake.env });
      const paneId = await client.layoutApplyPane({
        workspaceId: "w1",
        tabLabel: "worker",
        command: ["node", "x.js"],
        cwd: "/p",
        env: { A: "1" },
      });
      expect(paneId).toBe("w1:p9");
      expect(fake.requests[0]!.method).toBe("layout.apply");
      expect(fake.requests[0]!.params).toEqual({
        workspace_id: "w1",
        tab_label: "worker",
        focus: false,
        root: { type: "pane", command: ["node", "x.js"], cwd: "/p", env: { A: "1" } },
      });
      const params = fake.requests[0]!.params as Record<string, unknown>;
      expect(Object.keys(params)).toEqual(["workspace_id", "tab_label", "focus", "root"]);
      expect(Object.keys(params["root"] as Record<string, unknown>)).toEqual(["type", "command", "cwd", "env"]);
    } finally {
      await fake.close();
    }
  });

  it("E5 without an env input, root carries no env key at all", async () => {
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const { createHerdrClient } = await import("../src/herdr-client.ts");
    const fake = await startFakeHerdrServer();
    try {
      fake.script((request, socket) => {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            result: { layout: { root: { type: "pane", pane_id: "w1:p9" } } },
          })}\n`,
        );
        socket.end();
      });
      const client = createHerdrClient({ env: fake.env });
      await client.layoutApplyPane({ workspaceId: "w1", tabLabel: "worker", command: ["node", "x.js"], cwd: "/p" });
      const params = fake.requests[0]!.params as { root: Record<string, unknown> };
      expect("env" in params.root).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("E6 layoutApplyPane's own default deadline is 15000ms, and an explicit timeoutMs overrides it", async () => {
    const { createHerdrClient, LAYOUT_APPLY_TIMEOUT_MS } = await import("../src/herdr-client.ts");
    expect(LAYOUT_APPLY_TIMEOUT_MS).toBe(15_000);

    const { EventEmitter } = await import("node:events");
    class FakeSocket extends EventEmitter {
      write(): boolean {
        return true;
      }
      destroy(): void {}
    }
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const client = createHerdrClient({
        env: PANE,
        connect: () => {
          queueMicrotask(() => socket.emit("connect"));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return socket as any;
        },
      });
      let outcome: "pending" | "rejected" = "pending";
      let error: unknown;
      void client
        .layoutApplyPane({ workspaceId: "w1", tabLabel: "worker", command: ["node"], cwd: "/p" })
        .catch((e: unknown) => {
          outcome = "rejected";
          error = e;
        });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("rejected");
      expect((error as HerdrRequestError).kind).toBe("timeout");
      expect((error as HerdrRequestError).message).toBe("herdr layout.apply timed out after 15000ms");
    } finally {
      vi.useRealTimers();
    }

    const { startFakeHerdrServer, hang } = await import("./helpers/fake-herdr-server.ts");
    const fake = await startFakeHerdrServer();
    try {
      fake.script(hang);
      const client = createHerdrClient({ env: fake.env });
      await expect(
        client.layoutApplyPane(
          { workspaceId: "w1", tabLabel: "worker", command: ["node"], cwd: "/p" },
          { timeoutMs: 50 },
        ),
      ).rejects.toMatchObject({ message: "herdr layout.apply timed out after 50ms" });
    } finally {
      await fake.close();
    }
  });

  it("E7 a split root resolves via the tree walk, beating focused_pane_id", async () => {
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const { createHerdrClient } = await import("../src/herdr-client.ts");
    const fake = await startFakeHerdrServer();
    try {
      fake.script((request, socket) => {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            result: {
              layout: {
                root: {
                  type: "split",
                  first: { type: "pane", pane_id: "w1:p3" },
                  second: { type: "pane", pane_id: "w1:p4" },
                },
                focused_pane_id: "w1:p4",
              },
            },
          })}\n`,
        );
        socket.end();
      });
      const real = createHerdrClient({ env: fake.env });
      await expect(
        real.layoutApplyPane({ workspaceId: "w1", tabLabel: "worker", command: ["node"], cwd: "/p" }),
      ).resolves.toBe("w1:p3");
    } finally {
      await fake.close();
    }
  });

  it("E8 a rootless pane falls back to focused_pane_id", async () => {
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const { createHerdrClient } = await import("../src/herdr-client.ts");
    const fake = await startFakeHerdrServer();
    try {
      fake.script((request, socket) => {
        socket.write(
          `${JSON.stringify({
            id: request.id,
            result: { layout: { root: { type: "pane" }, focused_pane_id: "w1:p5" } },
          })}\n`,
        );
        socket.end();
      });
      const client = createHerdrClient({ env: fake.env });
      await expect(
        client.layoutApplyPane({ workspaceId: "w1", tabLabel: "worker", command: ["node"], cwd: "/p" }),
      ).resolves.toBe("w1:p5");
    } finally {
      await fake.close();
    }
  });

  it("E9 a result with no discoverable pane id rejects unexpected-result, carrying the raw result as detail", async () => {
    const { startFakeHerdrServer } = await import("./helpers/fake-herdr-server.ts");
    const { createHerdrClient } = await import("../src/herdr-client.ts");
    for (const result of [
      { layout: { root: { type: "pane" } } },
      { layout: {} },
      {},
      null,
    ]) {
      const fake = await startFakeHerdrServer();
      try {
        fake.script((request, socket) => {
          socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
          socket.end();
        });
        const client = createHerdrClient({ env: fake.env });
        let caught: unknown;
        try {
          await client.layoutApplyPane({ workspaceId: "w1", tabLabel: "worker", command: ["node"], cwd: "/p" });
        } catch (error) {
          caught = error;
        }
        const error = caught as HerdrRequestError;
        expect(error.kind).toBe("unexpected-result");
        expect(error.message).toBe("herdr layout.apply reported no pane id");
        expect(error.detail).toEqual(result);
      } finally {
        await fake.close();
      }
    }
  });

  it("E10 a successful place() resolves the exact PlacedChild shape", async () => {
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    const placed = await backend.place(sampleRequest());
    expect(placed.handle).toBe("w1:p9");
    expect(placed.capabilities).toEqual({ observesExit: false, inheritsEnv: true, visible: true });
    expect(placed.process).toBeUndefined();
    expect(typeof placed.onExit).toBe("function");
    expect(typeof placed.kill).toBe("function");
  });

  it("E11 onExit accepts a listener as a no-op and never fires it", async () => {
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    const placed = await backend.place(sampleRequest());
    const listener = vi.fn();
    expect(() => placed.onExit(listener)).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(listener).not.toHaveBeenCalled();
  });

  it("E12 a timeout from the client becomes a labelled HerdrPlacementError carrying it as cause", async () => {
    const timeoutError = new HerdrRequestError("herdr layout.apply timed out after 15000ms", "layout.apply", "timeout");
    const client = fakeClient({ layoutApplyPane: vi.fn(async () => Promise.reject(timeoutError)) });
    const backend = createHerdrPlacementBackend({ client });
    let caught: unknown;
    try {
      await backend.place(sampleRequest());
    } catch (error) {
      caught = error;
    }
    const error = caught as HerdrPlacementError;
    expect(error).toBeInstanceOf(HerdrPlacementError);
    expect(error.message).toBe("cannot place 'worker' in a herdr tab: herdr layout.apply timed out after 15000ms");
    expect(error.label).toBe("worker");
    expect(error.cause).toBe(timeoutError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
  });

  it("E13 a refused layout.apply becomes a labelled HerdrPlacementError with the refusal body in the message", async () => {
    const refused = new HerdrRequestError(
      'herdr layout.apply: {"code":"bad_workspace","message":"unknown workspace"}',
      "layout.apply",
      "refused",
      { code: "bad_workspace", message: "unknown workspace" },
    );
    const client = fakeClient({ layoutApplyPane: vi.fn(async () => Promise.reject(refused)) });
    const backend = createHerdrPlacementBackend({ client });
    await expect(backend.place(sampleRequest())).rejects.toMatchObject({
      message: 'cannot place \'worker\' in a herdr tab: herdr layout.apply: {"code":"bad_workspace","message":"unknown workspace"}',
    });
  });

  it("E14 a non-HerdrRequestError throw from the client propagates unwrapped", async () => {
    const boom = new Error("boom");
    const client = fakeClient({ layoutApplyPane: vi.fn(async () => Promise.reject(boom)) });
    const backend = createHerdrPlacementBackend({ client });
    let caught: unknown;
    try {
      await backend.place(sampleRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
  });

  it("E15 an env with no markers refuses place() up front, and never calls layoutApplyPane", async () => {
    const client = fakeClient({ env: (): null => null });
    const backend = createHerdrPlacementBackend({ client });
    expect(backend.detect()).toBe(false);
    await expect(backend.place(sampleRequest())).rejects.toMatchObject({
      message: "cannot place 'worker' in a herdr tab: not inside a herdr pane",
    });
    expect(client.layoutApplyPane).not.toHaveBeenCalled();
  });

  it("E16 detect() with markers present is true and touches no client request method", () => {
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    expect(backend.detect()).toBe(true);
    expect(backend.detect()).toBe(true);
    expect(backend.detect()).toBe(true);
    expect(client.request).not.toHaveBeenCalled();
    expect(client.layoutApplyPane).not.toHaveBeenCalled();
  });

  it("E17 the backend's static shape matches the seam exactly", () => {
    const backend = createHerdrPlacementBackend({ client: fakeClient() });
    expect(backend.name).toBe("herdr");
    expect(backend.name).toBe(HERDR_PLACEMENT_NAME);
    expect(backend.priority).toBe(HERDR_PLACEMENT_PRIORITY);
    expect(Number.isFinite(backend.priority)).toBe(true);
    expect(backend.capabilities).toEqual({ visible: true, inheritsEnv: true });
    expect("persistSession" in (backend.capabilities ?? {})).toBe(false);
  });

  it("E18 the label is forwarded verbatim, and context/presentation/launchFile never appear in a client call", async () => {
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    await backend.place(
      sampleRequest({ label: "quality-loop#fix_cluster", context: { invokeDepth: 1, parallel: false } }),
    );
    const input = client.calls.layoutApplyPane[0]!;
    expect(input.tabLabel).toBe("quality-loop#fix_cluster");
    expect(JSON.stringify(input)).not.toContain("invokeDepth");
    expect(JSON.stringify(input)).not.toContain("presentation");
    expect(JSON.stringify(input)).not.toContain("launchFile");
  });
});

describe("§5.F kill()", () => {
  it("F1 kill() returns synchronously and issues exactly one paneClose for the placed handle", async () => {
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    const placed = await backend.place(sampleRequest());
    const returned = placed.kill();
    expect(returned).toBeUndefined();
    await waitUntil(() => client.calls.paneClose.length === 1);
    expect(client.calls.paneClose).toEqual(["w1:p9"]);
  });

  it("F2 kill() is not latched: two calls issue two paneClose requests", async () => {
    const client = fakeClient();
    const backend = createHerdrPlacementBackend({ client });
    const placed = await backend.place(sampleRequest());
    placed.kill();
    placed.kill();
    await waitUntil(() => client.calls.paneClose.length === 2);
    expect(client.calls.paneClose).toEqual(["w1:p9", "w1:p9"]);
  });

  it("F3 a refused paneClose rejection is swallowed: no throw, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = fakeClient({
        paneClose: vi.fn(async () => Promise.reject(new HerdrRequestError('herdr pane.close: {"code":"not_found"}', "pane.close", "refused"))),
      });
      const backend = createHerdrPlacementBackend({ client });
      const placed = await backend.place(sampleRequest());
      expect(() => placed.kill()).not.toThrow();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("F4 a plain Error rejection from paneClose is also swallowed", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = fakeClient({ paneClose: vi.fn(async () => Promise.reject(new Error("boom"))) });
      const backend = createHerdrPlacementBackend({ client });
      const placed = await backend.place(sampleRequest());
      expect(() => placed.kill()).not.toThrow();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("F5 a synchronous throw from paneClose propagates (a defect, not masked)", async () => {
    const client = fakeClient({
      paneClose: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const backend = createHerdrPlacementBackend({ client });
    const placed = await backend.place(sampleRequest());
    expect(() => placed.kill()).toThrow("boom");
  });
});
