// RFC 0012 Phase 2 seam sheet §5.J / §6.2 — opt-in real-Herdr suite. Excluded
// from `npm test` by `vitest.config.ts`; run with `npm run test:herdr` from a
// shell inside a Herdr pane. J0: a missing pane environment fails the WHOLE
// FILE loudly at module top level, naming the missing variables — never
// `it.skip`, never an early return.
import * as os from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createHerdrClient, herdrEnv, HERDR_REPORT_AGENT, HERDR_REPORT_SOURCE, HerdrRequestError } from "../../src/herdr-client.ts";
import { createHerdrPlacementBackend } from "../../src/herdr-placement-backend.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

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

interface PaneInfo {
  readonly [key: string]: unknown;
}

/** `pane.get { pane_id }` narrowed to `{ type: "pane_info", pane }`; any other shape fails loudly (§6.J notes). */
async function paneGet(paneId: string): Promise<PaneInfo> {
  const result = await client.request("pane.get", { pane_id: paneId });
  if (typeof result !== "object" || result === null) {
    throw new Error(`pane.get returned a non-object result: ${JSON.stringify(result)}`);
  }
  const record = result as Record<string, unknown>;
  if (record["type"] !== "pane_info" || typeof record["pane"] !== "object" || record["pane"] === null) {
    throw new Error(`pane.get did not return a pane_info envelope: ${JSON.stringify(result)}`);
  }
  return record["pane"] as PaneInfo;
}

/** Poll `pane.get` every `intervalMs` until `predicate(pane)` holds or `budgetMs` elapses; on timeout, throws loudly with the last observed pane JSON. */
async function pollUntil(
  paneId: string,
  predicate: (pane: PaneInfo) => boolean,
  budgetMs: number,
  intervalMs = 500,
): Promise<PaneInfo> {
  const start = Date.now();
  let last: PaneInfo | undefined;
  for (;;) {
    last = await paneGet(paneId);
    if (predicate(last)) return last;
    if (Date.now() - start > budgetMs) {
      throw new Error(`pollUntil timed out after ${budgetMs}ms; last observed pane: ${JSON.stringify(last)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

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

  it("J7 metadata then agent-lifecycle reports derive idle/working/done on a node-rooted sleeper pane", async () => {
    const pane = herdrEnv();
    if (pane === null) throw new Error("unreachable: the module-level guard already asserted the pane env");
    const paneId = await client.layoutApplyPane({
      workspaceId: pane.workspaceId,
      tabLabel: "pi-theta-herdr live J7",
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      env: { PI_THETA_HERDR_LIVE: "1" },
    });
    createdPaneIds.push(paneId);

    // D18 seq scheme: observed on Herdr 0.8.0, reports with small literal seqs (1..4)
    // were acknowledged and not applied; wall-clock-based seqs are applied.
    const seqBase = Date.now() * 1000;
    await client.paneReportMetadata(paneId, { source: HERDR_REPORT_SOURCE, seq: seqBase + 1, displayAgent: "live-meta" });
    // Herdr acks a report before applying it; every observation below polls.
    let observed = await pollUntil(paneId, (pane) => pane["display_agent"] === "live-meta", 5_000);
    // Pin-after-first-run (Flag F25): record whether `agent` is already "pi" from
    // metadata alone, or still null pending the first pane.report_agent.
    // eslint-disable-next-line no-console
    console.log(`J7 pin-after-first-run: pane.agent after metadata alone = ${JSON.stringify(observed["agent"])}`);

    await client.paneReportAgent(paneId, { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: seqBase + 2, state: "idle" });
    observed = await pollUntil(paneId, (pane) => pane["agent_status"] === "idle", 5_000);
    expect(observed["agent"]).toBe("pi");

    await client.paneReportAgent(paneId, { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: seqBase + 3, state: "working" });
    await pollUntil(paneId, (pane) => pane["agent_status"] === "working", 5_000);

    await client.paneReportAgent(paneId, { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: seqBase + 4, state: "idle" });
    await pollUntil(paneId, (pane) => pane["agent_status"] === "done", 5_000);

    await client.paneClose(paneId);
  });

  it("J8 the child role end to end: parent metadata, then the child's own session_start reports", async () => {
    const pane = herdrEnv();
    if (pane === null) throw new Error("unreachable: the module-level guard already asserted the pane env");

    const overridePiCli = process.env["PI_THETA_HERDR_LIVE_PI_CLI"];
    const PI_CLI = overridePiCli ?? join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (!existsSync(PI_CLI)) {
      throw new Error(
        `J8 requires a pi CLI entry to exist at ${PI_CLI} (set PI_THETA_HERDR_LIVE_PI_CLI to override; the default is the companion's own devDependency)`,
      );
    }
    const piThetaRoot = join(ROOT, "node_modules", "@bitmonk8", "pi-theta");
    if (!existsSync(piThetaRoot)) {
      throw new Error(`J8 requires the companion's pi-theta devDependency at ${piThetaRoot}`);
    }

    const bogusLaunchPath = join(os.tmpdir(), `pi-theta-herdr-live-absent-${process.pid}`, "launch.json");

    const backend = createHerdrPlacementBackend();
    const placed = await backend.place({
      execPath: process.execPath,
      args: [
        PI_CLI,
        "-ne",
        "-e",
        ROOT,
        "-e",
        piThetaRoot,
        "--theta-launch",
        bogusLaunchPath,
        "--name",
        "live-child-tui",
        "--no-session",
      ],
      cwd: ROOT,
      env: { ...process.env, PI_THETA_HERDR_REPORT: "1" },
      label: "live-child",
      presentation: "visible",
      launchFile: undefined,
      context: { invokeDepth: 0, parallel: false },
    });
    createdPaneIds.push(placed.handle);

    try {
      // Phase 1: the parent's own D20 metadata report.
      await pollUntil(placed.handle, (pane) => pane["display_agent"] === "live-child", 5_000);

      // Phase 2: the child's own session_start reports (D13-D17).
      const observed = await pollUntil(
        placed.handle,
        (pane) =>
          pane["display_agent"] === "live-child-tui" &&
          pane["agent"] === "pi" &&
          pane["agent_status"] === "idle",
        45_000,
      );
      // Pinned after the first run (Herdr 0.8.0, protocol 20): the child's
      // pane.report_agent_session under the custom source is acknowledged but
      // `agent_session` stays absent from pane.get, while display_agent / agent /
      // agent_status from the same source are applied. Recorded, not required.
      // eslint-disable-next-line no-console
      console.log(
        `J8 observed agent_session = ${JSON.stringify(observed["agent_session"] ?? null)} (Herdr 0.8.0: absent; re-evaluate the README if this changes)`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `J8: terminal_title=${JSON.stringify(observed["terminal_title"])}`,
      );
      const agentList = await client.request("agent.list", {});
      // eslint-disable-next-line no-console
      console.log(`J8: herdr agent list includes the pane = ${JSON.stringify(agentList).includes(placed.handle)}`);
    } finally {
      placed.kill();
    }
  }, 60_000);

  it("J9 the herdr:pi-source premise: a report under herdr:pi on a node-rooted pane is acked but not applied; a custom source is applied", async () => {
    const pane = herdrEnv();
    if (pane === null) throw new Error("unreachable: the module-level guard already asserted the pane env");
    const paneId = await client.layoutApplyPane({
      workspaceId: pane.workspaceId,
      tabLabel: "pi-theta-herdr live J9",
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      env: { PI_THETA_HERDR_LIVE: "1" },
    });
    createdPaneIds.push(paneId);

    await client.request("pane.report_agent", {
      pane_id: paneId,
      source: "herdr:pi",
      agent: "pi",
      seq: Date.now() * 1000,
      state: "working",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const afterHerdrPi = await paneGet(paneId);
    if (afterHerdrPi["agent_status"] === "working") {
      throw new Error(
        `J9 pin-after-first-run: a herdr:pi report on a node-rooted pane was applied (agent_status=working) - Herdr changed; re-evaluate §5.5`,
      );
    }
    expect(afterHerdrPi["agent_status"]).not.toBe("working");

    await client.paneReportAgent(paneId, { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: Date.now() * 1000, state: "working" });
    await pollUntil(paneId, (pane) => pane["agent_status"] === "working", 5_000);

    await client.paneClose(paneId);
  });
});
