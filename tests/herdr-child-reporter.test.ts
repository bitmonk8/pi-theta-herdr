// RFC 0012 companion 0.2.0 seam sheet §6.L/M/N/O — `src/herdr-child-reporter.ts`.
// Every row is one red test asserting a real observable named in the
// behaviour matrix. `fake` = the real Herdr NDJSON fake daemon
// (`tests/helpers/fake-herdr-server.ts`); determinism comes from the
// reporter's serial send chain (D18) plus `await reporter.flush()`, never
// polling — N6 is the sheet's one fake-timer row.
import type * as net from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachHerdrChildReporter,
  createHerdrChildReporter,
  shouldAttachChildReporter,
  type ChildReporterHost,
  type ChildReporterDeps,
  type HerdrChildReporter,
} from "../src/herdr-child-reporter.ts";
import { findLaunchFlagOnArgv } from "../src/protocol.ts";
import {
  createHerdrClient,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  HerdrRequestError,
  type HerdrClient,
  type HerdrPaneEnv,
  type HerdrRequestOptions,
  type PaneAgentReport,
  type PaneAgentSessionReport,
  type PaneMetadata,
} from "../src/herdr-client.ts";
import { hang, reply, startFakeHerdrServer, type FakeHerdrServer } from "./helpers/fake-herdr-server.ts";
import { fakeCtx, fakeHost, type FakePlacementHost } from "./helpers/fake-host.ts";

const NOW = 1_700_000_000_000;
const B = 1_700_000_000_000_000; // NOW * 1000, the seq base every M/N row is written against.

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

const FULL_HERDR_ENV: NodeJS.ProcessEnv = {
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "s",
  HERDR_PANE_ID: "w1:p1",
  HERDR_WORKSPACE_ID: "w1",
};

const PANE: HerdrPaneEnv = { socketPath: "s", paneId: "w1:p1", workspaceId: "w1" };

const servers: FakeHerdrServer[] = [];

async function fakeServer(): Promise<FakeHerdrServer> {
  const server = await startFakeHerdrServer();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
});

function makeReporter(
  fake: FakeHerdrServer,
  overrides: Partial<ChildReporterDeps> = {},
): { client: HerdrClient; reporter: HerdrChildReporter; host: FakePlacementHost } {
  const client = createHerdrClient({ env: fake.env });
  const reporter = createHerdrChildReporter({
    client,
    argv: CHILD_ARGV,
    env: fake.env,
    now: () => NOW,
    requestTimeoutMs: 50,
    ...overrides,
  });
  const host = fakeHost(undefined);
  reporter.attach(host);
  return { client, reporter, host };
}

interface RecordedClient extends HerdrClient {
  readonly calls: {
    readonly paneReportMetadata: { paneId: string; metadata: PaneMetadata; opts: HerdrRequestOptions | undefined }[];
    readonly paneReportAgentSession: { paneId: string; report: PaneAgentSessionReport; opts: HerdrRequestOptions | undefined }[];
    readonly paneReportAgent: { paneId: string; report: PaneAgentReport; opts: HerdrRequestOptions | undefined }[];
  };
}

/** A fake client whose default implementations are PLAIN functions (never `vi.fn`, per the tinyspy-vacuous-trap review note). */
function fakeClient(
  overrides: Partial<Pick<HerdrClient, "paneReportMetadata" | "paneReportAgent" | "paneReportAgentSession">> = {},
): RecordedClient {
  const calls: RecordedClient["calls"] = { paneReportMetadata: [], paneReportAgentSession: [], paneReportAgent: [] };
  const paneReportMetadata =
    overrides.paneReportMetadata ??
    ((paneId: string, metadata: PaneMetadata, opts?: HerdrRequestOptions): Promise<void> => {
      calls.paneReportMetadata.push({ paneId, metadata, opts });
      return Promise.resolve();
    });
  const paneReportAgentSession =
    overrides.paneReportAgentSession ??
    ((paneId: string, report: PaneAgentSessionReport, opts?: HerdrRequestOptions): Promise<void> => {
      calls.paneReportAgentSession.push({ paneId, report, opts });
      return Promise.resolve();
    });
  const paneReportAgent =
    overrides.paneReportAgent ??
    ((paneId: string, report: PaneAgentReport, opts?: HerdrRequestOptions): Promise<void> => {
      calls.paneReportAgent.push({ paneId, report, opts });
      return Promise.resolve();
    });
  return {
    calls,
    env: (): HerdrPaneEnv => PANE,
    request: async (): Promise<unknown> => undefined,
    layoutApplyPane: async (): Promise<string> => "w1:p9",
    paneClose: async (): Promise<void> => {},
    paneRename: async (): Promise<void> => {},
    paneReportMetadata,
    paneReportAgentSession,
    paneReportAgent,
  };
}

describe("§6.L role detection", () => {
  it("L1 findLaunchFlagOnArgv extracts the --theta-launch value off CHILD_ARGV", () => {
    expect(findLaunchFlagOnArgv(CHILD_ARGV)).toBe("C:\\tmp\\l\\launch.json");
  });

  it("L2 findLaunchFlagOnArgv vectors: '=' form, absent/empty value, no marker, first match wins", () => {
    expect(findLaunchFlagOnArgv(["node", "cli.js", "--theta-launch=C:/l/launch.json"])).toBe("C:/l/launch.json");
    expect(findLaunchFlagOnArgv(["node", "--theta-launch"])).toBeUndefined();
    expect(findLaunchFlagOnArgv(["node", "--theta-launch", ""])).toBeUndefined();
    expect(findLaunchFlagOnArgv(["node", "--theta-launch="])).toBeUndefined();
    expect(findLaunchFlagOnArgv(["node", "--theta", "x", "/slug"])).toBeUndefined();
    expect(findLaunchFlagOnArgv(["--theta-launch", "a", "--theta-launch", "b"])).toBe("a");
  });

  it("L3 shouldAttachChildReporter is true for CHILD_ARGV plus a pane env", async () => {
    const fake = await fakeServer();
    expect(shouldAttachChildReporter({ argv: CHILD_ARGV, env: fake.env })).toBe(true);
  });

  it("L4 argv without the flag, any missing marker, or the exact opt-out '0' are false; '1'/'' are not opt-outs", async () => {
    const fake = await fakeServer();
    expect(shouldAttachChildReporter({ argv: ["node", "cli.js"], env: fake.env })).toBe(false);
    for (const key of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"] as const) {
      const env = { ...fake.env };
      delete env[key];
      expect(shouldAttachChildReporter({ argv: CHILD_ARGV, env })).toBe(false);
    }
    expect(shouldAttachChildReporter({ argv: CHILD_ARGV, env: { ...fake.env, PI_THETA_HERDR_REPORT: "0" } })).toBe(false);
    expect(shouldAttachChildReporter({ argv: CHILD_ARGV, env: { ...fake.env, PI_THETA_HERDR_REPORT: "1" } })).toBe(true);
    expect(shouldAttachChildReporter({ argv: CHILD_ARGV, env: { ...fake.env, PI_THETA_HERDR_REPORT: "" } })).toBe(true);
  });

  it("L5 attachHerdrChildReporter registers nothing when the argv gate fails", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    const host = fakeHost(undefined);
    const reporter = attachHerdrChildReporter(host as unknown as ChildReporterHost, {
      argv: ["node"],
      env: fake.env,
      client,
    });
    expect(reporter).toBeUndefined();
    expect(host.onCalls).toEqual([]);
  });

  it("L6 attachHerdrChildReporter registers all four handlers when the gate holds, inactive until session_start", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    const host = fakeHost(undefined);
    const reporter = attachHerdrChildReporter(host as unknown as ChildReporterHost, {
      argv: CHILD_ARGV,
      env: fake.env,
      client,
    });
    expect(reporter).toBeDefined();
    expect(reporter!.attached).toBe(true);
    expect(reporter!.active).toBe(false);
    expect(host.onCalls).toEqual(["session_start", "agent_start", "agent_settled", "session_shutdown"]);
  });

  it("L7 a non-tui mode never activates; a following agent_start also produces nothing", async () => {
    for (const mode of ["json", "print", "rpc"]) {
      const fake = await fakeServer();
      const { reporter, host } = makeReporter(fake);
      host.emit("session_start", { reason: "startup" }, fakeCtx({ mode }));
      expect(reporter.active).toBe(false);
      await reporter.flush();
      expect(fake.connections).toBe(0);
      host.emit("agent_start", {}, fakeCtx({ mode }));
      await reporter.flush();
      expect(fake.connections).toBe(0);
    }
  });

  it("L8 a tui session_start activates the reporter", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    expect(reporter.active).toBe(true);
  });

  it("L9 a paneless client (env() null) keeps session_start from activating, even with a marker-carrying reporter env", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: {} });
    const host = fakeHost(undefined);
    const reporter = createHerdrChildReporter({ client, argv: CHILD_ARGV, env: fake.env, now: () => NOW, requestTimeoutMs: 50 });
    reporter.attach(host);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    expect(reporter.active).toBe(false);
    await reporter.flush();
    expect(fake.connections).toBe(0);
  });

  it("L10 PI_THETA_HERDR_REPORT=0 on the reporter's own env keeps session_start from activating", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    const host = fakeHost(undefined);
    const reporter = createHerdrChildReporter({
      client,
      argv: CHILD_ARGV,
      env: { ...fake.env, PI_THETA_HERDR_REPORT: "0" },
      now: () => NOW,
      requestTimeoutMs: 50,
    });
    reporter.attach(host);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    expect(reporter.active).toBe(false);
    await reporter.flush();
    expect(fake.connections).toBe(0);
  });

  it("L11 default deps read the real process; argv lacking the marker never activates", () => {
    const host = fakeHost(undefined);
    const reporter = createHerdrChildReporter();
    reporter.attach(host);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    expect(reporter.active).toBe(false);
  });

  it("L12 attach() is one-shot: a second call does not re-register handlers", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    reporter.attach(host);
    expect(host.onCalls).toEqual(["session_start", "agent_start", "agent_settled", "session_shutdown"]);
  });
});

describe("§6.M request sequence per event", () => {
  it("M1 session_start (idle, named, no file) sends metadata, session, and idle state in order", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    expect(fake.requests.map((r) => [r.method, r.params])).toEqual([
      [
        "pane.report_metadata",
        { pane_id: "w1:p1", source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: B + 1, display_agent: "worker#ab12cd34" },
      ],
      [
        "pane.report_agent_session",
        {
          pane_id: "w1:p1",
          source: HERDR_REPORT_SOURCE,
          agent: HERDR_REPORT_AGENT,
          seq: B + 2,
          session_start_source: "startup",
          agent_session_id: "sid-1",
        },
      ],
      ["pane.report_agent", { pane_id: "w1:p1", source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: B + 3, state: "idle" }],
    ]);
    expect(fake.connections).toBe(3);
  });

  it("M2 idle:false + reason 'reload' reports working and carries the reload reason", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "reload" }, fakeCtx({ idle: false }));
    await reporter.flush();
    expect((fake.requests[2]!.params as Record<string, unknown>)["state"]).toBe("working");
    expect((fake.requests[1]!.params as Record<string, unknown>)["session_start_source"]).toBe("reload");
  });

  it("M3 an absent, empty, or unavailable session name sends no metadata report and does not consume a seq slot", async () => {
    for (const ctx of [fakeCtx({ sessionName: undefined }), fakeCtx({ sessionName: "" }), fakeCtx({ omitGetSessionName: true })]) {
      const fake = await fakeServer();
      const { reporter, host } = makeReporter(fake);
      host.emit("session_start", { reason: "startup" }, ctx);
      await reporter.flush();
      expect(fake.requests.map((r) => r.method)).toEqual(["pane.report_agent_session", "pane.report_agent"]);
      expect((fake.requests[0]!.params as Record<string, unknown>)["seq"]).toBe(B + 1);
      expect((fake.requests[1]!.params as Record<string, unknown>)["seq"]).toBe(B + 2);
    }
  });

  it("M4 a Windows session file is kept as agent_session_path alongside the id", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx({ sessionFile: "C:\\Users\\t\\.pi\\agent\\sessions\\x.jsonl" }));
    await reporter.flush();
    const sessionReq = fake.requests[1]!.params as Record<string, unknown>;
    expect(sessionReq["agent_session_id"]).toBe("sid-1");
    expect(sessionReq["agent_session_path"]).toBe("C:\\Users\\t\\.pi\\agent\\sessions\\x.jsonl");
  });

  it("M5 agent_start after session_start reports one more working state, no duplicate session ref", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    host.emit("agent_start", {}, fakeCtx());
    await reporter.flush();
    expect(fake.requests.map((r) => r.method)).toEqual([
      "pane.report_metadata",
      "pane.report_agent_session",
      "pane.report_agent",
      "pane.report_agent",
    ]);
    expect(fake.requests[3]!.params).toEqual({
      pane_id: "w1:p1",
      source: HERDR_REPORT_SOURCE,
      agent: HERDR_REPORT_AGENT,
      seq: B + 4,
      state: "working",
    });
  });

  it("M6 a following agent_settled that leaves the session idle reports idle", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    host.emit("agent_start", {}, fakeCtx());
    host.emit("agent_settled", {}, fakeCtx({ idle: true }));
    await reporter.flush();
    expect(fake.requests).toHaveLength(5);
    expect(fake.requests[4]!.params).toEqual({
      pane_id: "w1:p1",
      source: HERDR_REPORT_SOURCE,
      agent: HERDR_REPORT_AGENT,
      seq: B + 5,
      state: "idle",
    });
  });

  it("M7 an agent_settled that is not idle (P11: the next turn already started) sends nothing", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    host.emit("agent_start", {}, fakeCtx());
    host.emit("agent_settled", {}, fakeCtx({ idle: false }));
    await reporter.flush();
    expect(fake.requests).toHaveLength(4);
  });

  it("M8 agent_start with a newly-defined sessionFile re-sends the session ref before the state report", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    host.emit("agent_start", {}, fakeCtx({ sessionFile: "C:\\s\\x.jsonl" }));
    await reporter.flush();
    expect(fake.requests.map((r) => r.method)).toEqual([
      "pane.report_metadata",
      "pane.report_agent_session",
      "pane.report_agent",
      "pane.report_agent_session",
      "pane.report_agent",
    ]);
    expect(fake.requests[3]!.params).toEqual({
      pane_id: "w1:p1",
      source: HERDR_REPORT_SOURCE,
      agent: HERDR_REPORT_AGENT,
      seq: B + 4,
      agent_session_id: "sid-1",
      agent_session_path: "C:\\s\\x.jsonl",
    });
    expect(fake.requests[4]!.params).toEqual({
      pane_id: "w1:p1",
      source: HERDR_REPORT_SOURCE,
      agent: HERDR_REPORT_AGENT,
      seq: B + 5,
      state: "working",
    });
  });

  it("M9 three agent_start/agent_settled cycles alternate working/idle with no dedup", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    for (let i = 0; i < 3; i += 1) {
      host.emit("agent_start", {}, fakeCtx());
      host.emit("agent_settled", {}, fakeCtx({ idle: true }));
    }
    await reporter.flush();
    const states = fake.requests
      .slice(3)
      .map((r) => [r.method, (r.params as Record<string, unknown>)["state"], (r.params as Record<string, unknown>)["seq"]]);
    expect(states).toEqual([
      ["pane.report_agent", "working", B + 4],
      ["pane.report_agent", "idle", B + 5],
      ["pane.report_agent", "working", B + 6],
      ["pane.report_agent", "idle", B + 7],
      ["pane.report_agent", "working", B + 8],
      ["pane.report_agent", "idle", B + 9],
    ]);
  });

  it("M10 agent_start/agent_settled before any session_start are inert", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("agent_start", {}, fakeCtx());
    host.emit("agent_settled", {}, fakeCtx({ idle: true }));
    await reporter.flush();
    expect(fake.requests).toHaveLength(0);
    expect(reporter.active).toBe(false);
  });

  it("M11 agent_end / turn_end draw no reporter handler and send nothing", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    const before = fake.requests.length;
    expect(host.emit("agent_end", {})).toEqual([]);
    expect(host.emit("turn_end", {})).toEqual([]);
    expect(host.onCalls).toEqual(["session_start", "agent_start", "agent_settled", "session_shutdown"]);
    await reporter.flush();
    expect(fake.requests.length).toBe(before);
  });

  it("M12 an empty session id suppresses only the session report", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx({ sessionId: "" }));
    await reporter.flush();
    expect(fake.requests.map((r) => r.method)).toEqual(["pane.report_metadata", "pane.report_agent"]);
  });

  it("M13 against a fake client, every call carries the injected deadline in opts", async () => {
    const client = fakeClient();
    const host = fakeHost(undefined);
    const reporter = createHerdrChildReporter({ client, argv: CHILD_ARGV, env: {}, now: () => NOW, requestTimeoutMs: 50 });
    reporter.attach(host);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    expect(client.calls.paneReportMetadata[0]).toEqual({
      paneId: "w1:p1",
      metadata: { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: B + 1, displayAgent: "worker#ab12cd34" },
      opts: { timeoutMs: 50 },
    });
    expect(client.calls.paneReportAgentSession[0]).toEqual({
      paneId: "w1:p1",
      report: { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: B + 2, sessionStartSource: "startup", agentSessionId: "sid-1" },
      opts: { timeoutMs: 50 },
    });
    expect(client.calls.paneReportAgent[0]).toEqual({
      paneId: "w1:p1",
      report: { source: HERDR_REPORT_SOURCE, agent: HERDR_REPORT_AGENT, seq: B + 3, state: "idle" },
      opts: { timeoutMs: 50 },
    });
  });
});

describe("§6.N transport discipline", () => {
  it("N1 seq order equals arrival order across nine sends (M9's traffic)", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    for (let i = 0; i < 3; i += 1) {
      host.emit("agent_start", {}, fakeCtx());
      host.emit("agent_settled", {}, fakeCtx({ idle: true }));
    }
    await reporter.flush();
    const seqs = fake.requests.map((r) => (r.params as Record<string, unknown>)["seq"] as number);
    expect(seqs).toEqual([B + 1, B + 2, B + 3, B + 4, B + 5, B + 6, B + 7, B + 8, B + 9]);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it("N2 a hung first connection times out and is swallowed; later reports still arrive within one flush", async () => {
    const fake = await fakeServer();
    let seen = 0;
    fake.script((request, socket) => {
      seen += 1;
      if (seen === 1) {
        hang();
        return;
      }
      reply(socket, { id: request.id, result: { type: "ok" } });
    });
    const started = Date.now();
    const { reporter, host } = makeReporter(fake, { requestTimeoutMs: 50 });
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    const elapsed = Date.now() - started;
    expect(fake.requests.length).toBe(3);
    expect(fake.requests.map((r) => r.method)).toEqual(["pane.report_metadata", "pane.report_agent_session", "pane.report_agent"]);
    expect(elapsed).toBeLessThan(1000);
  });

  it("N3 an unreachable daemon at session_start never throws and leaves the reporter active", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const fake = await startFakeHerdrServer();
      const env = fake.env;
      await fake.close();
      const client = createHerdrClient({ env });
      const host = fakeHost(undefined);
      const reporter = createHerdrChildReporter({ client, argv: CHILD_ARGV, env: {}, now: () => NOW, requestTimeoutMs: 50 });
      reporter.attach(host);
      expect(() => host.emit("session_start", { reason: "startup" }, fakeCtx())).not.toThrow();
      await reporter.flush();
      expect(reporter.active).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("N4 a HerdrRequestError rejection and a plain Error rejection from the client are both swallowed", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = fakeClient({
        paneReportAgent: (): Promise<void> =>
          Promise.reject(
            new HerdrRequestError('herdr pane.report_agent: {"code":"pane_not_found"}', "pane.report_agent", "refused"),
          ),
        paneReportMetadata: (): Promise<void> => Promise.reject(new Error("boom")),
      });
      const host = fakeHost(undefined);
      const reporter = createHerdrChildReporter({ client, argv: CHILD_ARGV, env: {}, now: () => NOW, requestTimeoutMs: 50 });
      reporter.attach(host);
      host.emit("session_start", { reason: "startup" }, fakeCtx());
      host.emit("agent_start", {}, fakeCtx());
      await reporter.flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("N5 a synchronous throw from the client inside the chain does not kill later dispatches", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const agentReports: PaneAgentReport[] = [];
      let callCount = 0;
      const client = fakeClient({
        paneReportAgent: (_paneId: string, report: PaneAgentReport): Promise<void> => {
          callCount += 1;
          agentReports.push(report);
          if (callCount === 1) {
            throw new Error("sync boom");
          }
          return Promise.resolve();
        },
      });
      const host = fakeHost(undefined);
      const reporter = createHerdrChildReporter({ client, argv: CHILD_ARGV, env: {}, now: () => NOW, requestTimeoutMs: 50 });
      reporter.attach(host);
      expect(() => host.emit("session_start", { reason: "startup" }, fakeCtx())).not.toThrow();
      await reporter.flush();
      expect(unhandled).toEqual([]);
      host.emit("agent_start", {}, fakeCtx());
      await reporter.flush();
      expect(agentReports.map((r) => r.state)).toEqual(["idle", "working"]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("N6 the client's own 5s deadline governs each report in strict serial order; the timer is unref'd", async () => {
    vi.useFakeTimers();
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const unrefCalls: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms?: number, ...rest: any[]) => {
      const timer = realSetTimeout(fn, ms, ...rest) as unknown as { unref: () => unknown };
      const original = timer.unref.bind(timer);
      timer.unref = (): unknown => {
        unrefCalls.push(1);
        return original();
      };
      return timer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    try {
      const connectCalls: number[] = [];
      const connect = (): net.Socket => {
        connectCalls.push(1);
        const socket = new EventEmitter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (socket as any).write = (): boolean => true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (socket as any).destroy = (): void => {};
        return socket as unknown as net.Socket;
      };
      const client = createHerdrClient({ env: FULL_HERDR_ENV, connect });
      const host = fakeHost(undefined);
      const reporter = createHerdrChildReporter({ client, argv: CHILD_ARGV, env: {}, now: () => NOW });
      reporter.attach(host);
      host.emit("session_start", { reason: "startup" }, fakeCtx());
      await vi.advanceTimersByTimeAsync(0);
      expect(connectCalls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(connectCalls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(connectCalls.length).toBe(2);
      expect(unrefCalls.length).toBeGreaterThan(0);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("N7 seq is Date.now()*1000-based, a safe integer, and serialises without exponent notation", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake, { now: () => 1_700_000_000_000 });
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    const params = fake.requests[0]!.params as Record<string, unknown>;
    expect(params["seq"]).toBe(1_700_000_000_000_001);
    expect(Number.isSafeInteger(params["seq"] as number)).toBe(true);
    expect(fake.requests[0]!.raw).toContain('"seq":1700000000000001');
  });

  it("N8 a later reporter instance's seq base exceeds every seq of an earlier one", async () => {
    const fake = await fakeServer();
    const { reporter: reporter1, host: host1 } = makeReporter(fake, { now: () => 1_700_000_000_000 });
    host1.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter1.flush();
    const firstSeqs = fake.requests.map((r) => (r.params as Record<string, unknown>)["seq"] as number);

    const { reporter: reporter2, host: host2 } = makeReporter(fake, { now: () => 1_700_000_000_500 });
    host2.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter2.flush();
    const secondFirstSeq = (fake.requests[firstSeqs.length]!.params as Record<string, unknown>)["seq"] as number;
    expect(secondFirstSeq).toBe(1_700_000_000_500_001);
    expect(Math.max(...firstSeqs)).toBeLessThan(secondFirstSeq);
  });

  it("N9 flush() with nothing enqueued resolves immediately, and twice", async () => {
    const fake = await fakeServer();
    const { reporter } = makeReporter(fake);
    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(Promise.all([reporter.flush(), reporter.flush()])).resolves.toEqual([undefined, undefined]);
  });
});

describe("§6.O detach / shutdown", () => {
  it("O1 session_shutdown (non-quit) deactivates immediately without waiting, and a following agent_start sends nothing", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    const before = fake.requests.length;
    const results = host.emit("session_shutdown", { reason: "reload" }, fakeCtx());
    await Promise.all(results as Promise<void>[]);
    expect(reporter.active).toBe(false);
    host.emit("agent_start", {}, fakeCtx());
    await reporter.flush();
    expect(fake.requests.length).toBe(before);
  });

  it("O2 a quit shutdown waits (bounded) for a hung third request to time out, then resolves", async () => {
    const fake = await fakeServer();
    let seen = 0;
    fake.script((request, socket) => {
      seen += 1;
      if (seen === 3) {
        hang();
        return;
      }
      reply(socket, { id: request.id, result: { type: "ok" } });
    });
    const { reporter, host } = makeReporter(fake, { requestTimeoutMs: 200, shutdownFlushMs: 1000 });
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    const started = Date.now();
    const results = host.emit("session_shutdown", { reason: "quit" }, fakeCtx());
    await Promise.all(results as Promise<void>[]);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
    expect(fake.requests.length).toBe(3);
  });

  it(
    "O3 the shutdown flush budget wins over a longer request deadline; the eventual timeout is still swallowed",
    async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const fake = await fakeServer();
        let seen = 0;
        fake.script((request, socket) => {
          seen += 1;
          if (seen === 3) {
            hang();
            return;
          }
          reply(socket, { id: request.id, result: { type: "ok" } });
        });
        const { reporter, host } = makeReporter(fake, { requestTimeoutMs: 300, shutdownFlushMs: 100 });
        host.emit("session_start", { reason: "startup" }, fakeCtx());
        const started = Date.now();
        const results = host.emit("session_shutdown", { reason: "quit" }, fakeCtx());
        await Promise.all(results as Promise<void>[]);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(elapsed).toBeLessThan(300);
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        expect(unhandled).toEqual([]);
        expect(fake.requests.length).toBe(3);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
    2000,
  );

  it("O4 a quit shutdown on a never-active reporter resolves immediately with no requests", async () => {
    const fake = await fakeServer();
    const { host } = makeReporter(fake);
    const results = host.emit("session_shutdown", { reason: "quit" }, fakeCtx());
    await Promise.all(results as Promise<void>[]);
    expect(fake.requests).toHaveLength(0);
  });

  it("O5 a fresh session_start on the same instance after a non-quit shutdown re-activates and re-seeds seq", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    const results = host.emit("session_shutdown", { reason: "reload" }, fakeCtx());
    await Promise.all(results as Promise<void>[]);

    host.emit("session_start", { reason: "startup" }, fakeCtx());
    await reporter.flush();
    expect(reporter.active).toBe(true);
    expect(fake.requests).toHaveLength(6);
    expect(fake.requests.slice(3).map((r) => [r.method, (r.params as Record<string, unknown>)["seq"]])).toEqual([
      ["pane.report_metadata", B + 1],
      ["pane.report_agent_session", B + 2],
      ["pane.report_agent", B + 3],
    ]);
  });

  it("O6 detach() between agent_start and agent_settled suppresses the settle report; the already-enqueued working report still lands", async () => {
    const fake = await fakeServer();
    const { reporter, host } = makeReporter(fake);
    host.emit("session_start", { reason: "startup" }, fakeCtx());
    host.emit("agent_start", {}, fakeCtx());
    reporter.detach();
    host.emit("agent_settled", {}, fakeCtx({ idle: true }));
    await reporter.flush();
    expect(fake.requests.map((r) => r.method)).toEqual([
      "pane.report_metadata",
      "pane.report_agent_session",
      "pane.report_agent",
      "pane.report_agent",
    ]);
    expect((fake.requests[3]!.params as Record<string, unknown>)["state"]).toBe("working");
  });
});
