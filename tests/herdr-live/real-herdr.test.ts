// RFC 0012 Phase 2 seam sheet §5.J / §6.2 — opt-in real-Herdr suite. Excluded
// from `npm test` by `vitest.config.ts`; run with `npm run test:herdr` from a
// shell inside a Herdr pane. J0: a missing pane environment fails the WHOLE
// FILE loudly at module top level, naming the missing variables — never
// `it.skip`, never an early return.
import { afterAll, describe, expect, it } from "vitest";
import { createHerdrClient, herdrEnv, HerdrRequestError } from "../../src/herdr-client.ts";
import { createHerdrPlacementBackend } from "../../src/herdr-placement-backend.ts";

const REQUIRED_VARS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"] as const;

function missingVars(): string[] {
  return REQUIRED_VARS.filter((name) => {
    if (name === "HERDR_ENV") return process.env["HERDR_ENV"] !== "1";
    const value = process.env[name];
    return value === undefined || value.length === 0;
  });
}

if (herdrEnv() === null) {
  throw new Error(
    `tests/herdr-live requires a Herdr pane environment: HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID, HERDR_WORKSPACE_ID must all be set (run npm run test:herdr from a shell inside a herdr pane); missing: ${missingVars().join(", ")}`,
  );
}

const client = createHerdrClient();
const createdPaneIds: string[] = [];
let j2PaneId: string | undefined;
let j5PaneId: string | undefined;

afterAll(async () => {
  await Promise.all(
    createdPaneIds.map((paneId) =>
      client.paneClose(paneId).catch(() => {
        // A pane already closed by its own test (J3) or by the operator is the
        // expected happy case here — never fail the suite on cleanup.
      }),
    ),
  );
});

describe("RFC 0012 Phase 2 §5.J — real Herdr smoke (npm run test:herdr)", () => {
  it("J1 a bare request round-trips against the real daemon", async () => {
    try {
      await client.request("ping", {});
    } catch (error) {
      throw new Error(`herdr ping failed against the real daemon: ${(error as Error).message}`);
    }
  });

  it("J2 layoutApplyPane creates a real tab and returns a pane id shaped like w<n>:p<token>", async () => {
    const pane = herdrEnv();
    if (pane === null) throw new Error("unreachable: the module-level guard already asserted the pane env");
    const paneId = await client.layoutApplyPane({
      workspaceId: pane.workspaceId,
      tabLabel: "pi-theta-herdr live test",
      command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      cwd: process.cwd(),
      env: { PI_THETA_HERDR_LIVE: "1" },
    });
    expect(paneId).toMatch(/^w\d+:p[A-Za-z0-9]+$/);
    j2PaneId = paneId;
    createdPaneIds.push(paneId);
  });

  it("J3 paneClose resolves for the pane J2 created", async () => {
    if (j2PaneId === undefined) throw new Error("J2 must run first and create a pane");
    await expect(client.paneClose(j2PaneId)).resolves.toBeUndefined();
  });

  it("J4 createHerdrPlacementBackend().detect() is true inside a herdr pane", () => {
    expect(createHerdrPlacementBackend().detect()).toBe(true);
  });

  // J5 and J6 pin the shape observed on the first real `npm run test:herdr`
  // run against Herdr 0.8.0 (§5.J): the refusal Herdr returns for `pane.close`
  // on an already-gone pane, and the `pane.list` result variant. Both were
  // outside the schema dump (manifest c S5 gap: `pane.close`'s and
  // `pane.list`'s success/error bodies are not enumerated by `herdr api
  // schema --json`, only their params). Observed once via a throwaway probe
  // against the live daemon and pinned exactly below; a future Herdr release
  // that changes either shape fails these assertions loudly instead of being
  // silently accepted.
  it("J5 pin-after-first-run: place() + kill() then a second paneClose on the same handle rejects 'refused' with the observed detail.code", async () => {
    const backend = createHerdrPlacementBackend();
    const placed = await backend.place({
      execPath: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: process.cwd(),
      env: process.env,
      label: "pi-theta-herdr-live",
      presentation: "visible",
      launchFile: undefined,
      context: { invokeDepth: 0, parallel: false },
    });
    expect(placed.handle).toMatch(/^w\d+:p[A-Za-z0-9]+$/);
    j5PaneId = placed.handle;
    createdPaneIds.push(placed.handle);

    await new Promise((resolve) => setTimeout(resolve, 500));
    placed.kill();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    let caught: unknown;
    try {
      await client.paneClose(placed.handle);
    } catch (error) {
      caught = error;
    }
    if (caught === undefined) {
      throw new Error("a second paneClose on a killed pane resolved instead of rejecting 'refused'");
    }
    if (!(caught instanceof HerdrRequestError)) {
      throw new Error(`a second paneClose rejected with a non-HerdrRequestError: ${String(caught)}`);
    }
    expect(caught.kind).toBe("refused");
    expect(caught.detail).toEqual({
      code: "pane_not_found",
      message: `pane ${placed.handle} not found`,
    });
  });

  it("J6 pin-after-first-run: pane.list after J5's kill omits the closed handle", async () => {
    if (j5PaneId === undefined) throw new Error("J5 must run first and create+kill a pane");
    const pane = herdrEnv();
    if (pane === null) throw new Error("unreachable: the module-level guard already asserted the pane env");

    const result = await client.request("pane.list", { workspace_id: pane.workspaceId });
    if (typeof result !== "object" || result === null) {
      throw new Error(`pane.list returned a non-object result: ${JSON.stringify(result)}`);
    }
    const record = result as Record<string, unknown>;
    expect(record["type"]).toBe("pane_list");
    if (!Array.isArray(record["panes"])) {
      throw new Error(`pane.list result had no 'panes' array: ${JSON.stringify(result)}`);
    }
    const panes = record["panes"] as Array<Record<string, unknown>>;
    const paneIds = panes.map((p) => p["pane_id"]);
    expect(paneIds).not.toContain(j5PaneId);
  });
});
