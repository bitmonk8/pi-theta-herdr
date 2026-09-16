// RFC 0012 Phase 2 seam sheet §5.J / §6.2 — opt-in real-Herdr suite. Excluded
// from `npm test` by `vitest.config.ts`; run with `npm run test:herdr` from a
// shell inside a Herdr pane. J0: a missing pane environment fails the WHOLE
// FILE loudly at module top level, naming the missing variables — never
// `it.skip`, never an early return.
import { afterAll, describe, expect, it } from "vitest";
import { createHerdrClient, herdrEnv } from "../../src/herdr-client.ts";
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

  // J5 and J6 are the seam sheet's explicitly-marked pin-after-first-run rows
  // (§5.J): Herdr's result/refusal shape for a closed-pane pane.close and the
  // pane.list result variant are not in the schema dump (manifest c S5 gap),
  // so the first real run against Herdr 0.8.0 must record the observed shape
  // before these assertions can be written and tightened.
  it.todo(
    "J5 pin-after-first-run: place() + kill() then a second paneClose on the same handle rejects 'refused' with the observed detail.code (record from the first npm run test:herdr run)",
  );
  it.todo(
    "J6 pin-after-first-run: pane.list after J5's kill omits the closed handle (record the observed result variant name/shape from the first npm run test:herdr run)",
  );
});
