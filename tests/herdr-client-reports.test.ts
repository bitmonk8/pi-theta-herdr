// RFC 0012 companion 0.2.0 seam sheet §6.K — `src/herdr-client.ts` D25
// additions: `paneReportAgent`, `paneReportAgentSession`, `HERDR_REPORT_SOURCE`,
// `HERDR_REPORT_AGENT`, `HerdrAgentState`. Every row is one red test asserting
// a real observable named in the behaviour matrix.
import { afterEach, describe, expect, it } from "vitest";
import {
  createHerdrClient,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  HerdrRequestError,
  paneReportAgent,
  paneReportAgentSession,
  type HerdrAgentState,
} from "../src/herdr-client.ts";
import { hang, replyError, startFakeHerdrServer, type FakeHerdrServer } from "./helpers/fake-herdr-server.ts";

const S = HERDR_REPORT_SOURCE;
const A = HERDR_REPORT_AGENT;

const FOUR_KEYS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"] as const;

describe("§6.K client wrappers (tests/herdr-client-reports.test.ts)", () => {
  const servers: FakeHerdrServer[] = [];

  async function fakeServer(): Promise<FakeHerdrServer> {
    const server = await startFakeHerdrServer();
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("K1 paneReportAgent sends the exact params in wire key order", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await expect(
      client.paneReportAgent("w1:p9", { source: S, agent: A, seq: 7, state: "working" }),
    ).resolves.toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.method).toBe("pane.report_agent");
    expect(req.params).toEqual({ pane_id: "w1:p9", source: S, agent: A, seq: 7, state: "working" });
    expect(Object.keys(req.params as Record<string, unknown>)).toEqual(["pane_id", "source", "agent", "seq", "state"]);
  });

  it("K2 paneReportAgent with message/session fields and no seq omits the seq key", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await client.paneReportAgent("w1:p9", {
      source: S,
      agent: A,
      state: "blocked",
      message: "retry 2 in 8s",
      agentSessionId: "sid",
      agentSessionPath: "C:\\s\\x.jsonl",
    });
    const params = fake.requests[0]!.params as Record<string, unknown>;
    expect(params).toEqual({
      pane_id: "w1:p9",
      source: S,
      agent: A,
      state: "blocked",
      message: "retry 2 in 8s",
      agent_session_id: "sid",
      agent_session_path: "C:\\s\\x.jsonl",
    });
    expect("seq" in params).toBe(false);
  });

  it("K3 paneReportAgentSession sends the exact params in wire key order", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await client.paneReportAgentSession("w1:p9", {
      source: S,
      agent: A,
      seq: 8,
      sessionStartSource: "startup",
      agentSessionId: "sid",
    });
    const req = fake.requests[0]!;
    expect(req.method).toBe("pane.report_agent_session");
    expect(req.params).toEqual({
      pane_id: "w1:p9",
      source: S,
      agent: A,
      seq: 8,
      session_start_source: "startup",
      agent_session_id: "sid",
    });
    expect(Object.keys(req.params as Record<string, unknown>)).toEqual([
      "pane_id",
      "source",
      "agent",
      "seq",
      "session_start_source",
      "agent_session_id",
    ]);
  });

  it("K4 paneReportAgentSession with a path and no reason/seq carries both ids and no session_start_source/seq", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await client.paneReportAgentSession("w1:p9", {
      source: S,
      agent: A,
      agentSessionId: "sid",
      agentSessionPath: "/tmp/s.jsonl",
    });
    const params = fake.requests[0]!.params as Record<string, unknown>;
    expect(params["agent_session_id"]).toBe("sid");
    expect(params["agent_session_path"]).toBe("/tmp/s.jsonl");
    expect("session_start_source" in params).toBe(false);
    expect("seq" in params).toBe(false);
  });

  it("K5 paneReportMetadata with seq sends the exact params in wire key order", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await client.paneReportMetadata("w1:p9", { source: S, seq: 9, displayAgent: "worker" });
    const req = fake.requests[0]!;
    expect(req.method).toBe("pane.report_metadata");
    const params = req.params as Record<string, unknown>;
    expect(params).toEqual({ pane_id: "w1:p9", source: S, seq: 9, display_agent: "worker" });
    expect(Object.keys(params)).toEqual(["pane_id", "source", "seq", "display_agent"]);
    expect("agent" in params).toBe(false);
  });

  it("K6 paneReportMetadata in its 0.1.0 form (no seq) is unchanged on the wire", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await client.paneReportMetadata("w1:p9", { source: S, displayAgent: "worker" });
    const params = fake.requests[0]!.params as Record<string, unknown>;
    expect(params).toEqual({ pane_id: "w1:p9", source: S, display_agent: "worker" });
    expect("agent" in params).toBe(false);
  });

  it("K7 a refused pane.report_agent rejects HerdrRequestError kind refused with the verbatim body", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      replyError(socket, request.id, { code: "pane_not_found", message: "pane w1:p9 not found" });
    });
    const client = createHerdrClient({ env: fake.env });
    let caught: unknown;
    try {
      await client.paneReportAgent("w1:p9", { source: S, agent: A, state: "working" });
    } catch (error) {
      caught = error;
    }
    const error = caught as HerdrRequestError;
    expect(error).toBeInstanceOf(HerdrRequestError);
    expect(error.kind).toBe("refused");
    expect(error.message).toBe('herdr pane.report_agent: {"code":"pane_not_found","message":"pane w1:p9 not found"}');
  });

  it("K8 a hung pane.report_agent rejects on its own timeoutMs deadline", async () => {
    const fake = await fakeServer();
    fake.script(hang);
    const client = createHerdrClient({ env: fake.env });
    let caught: unknown;
    try {
      await client.paneReportAgent("w1:p9", { source: S, agent: A, state: "working" }, { timeoutMs: 50 });
    } catch (error) {
      caught = error;
    }
    const error = caught as HerdrRequestError;
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("herdr pane.report_agent timed out after 50ms");
  });

  it("K9 the module-level paneReportAgent / paneReportAgentSession behave as K1 / K3 through the default client", async () => {
    const fake = await fakeServer();
    const saved = { ...process.env };
    try {
      for (const key of FOUR_KEYS) delete process.env[key];
      Object.assign(process.env, fake.env);
      await paneReportAgent("w1:p9", { source: S, agent: A, seq: 7, state: "working" });
      expect(fake.requests[0]!.method).toBe("pane.report_agent");
      expect(fake.requests[0]!.params).toEqual({ pane_id: "w1:p9", source: S, agent: A, seq: 7, state: "working" });

      await paneReportAgentSession("w1:p9", { source: S, agent: A, seq: 8, sessionStartSource: "startup", agentSessionId: "sid" });
      expect(fake.requests[1]!.method).toBe("pane.report_agent_session");
      expect(fake.requests[1]!.params).toEqual({
        pane_id: "w1:p9",
        source: S,
        agent: A,
        seq: 8,
        session_start_source: "startup",
        agent_session_id: "sid",
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("K10 HerdrAgentState excludes 'done' at the type level; the report-identity constants hold at runtime", () => {
    // @ts-expect-error -- "done" is server-derived (Herdr's PaneAgentState input excludes it) and must not typecheck.
    const s: HerdrAgentState = "done";
    void s;
    expect(HERDR_REPORT_SOURCE).toBe("pi-theta-herdr");
    expect(HERDR_REPORT_AGENT).toBe("pi");
  });

  it("K11 paneRename sends { pane_id, label } only (schema PaneRenameParams, P15)", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await expect(client.paneRename("w1:p9", "FAILED worker")).resolves.toBeUndefined();
    expect(fake.requests[0]!.method).toBe("pane.rename");
    const params = fake.requests[0]!.params as Record<string, unknown>;
    expect(params).toEqual({ pane_id: "w1:p9", label: "FAILED worker" });
    expect(Object.keys(params)).toEqual(["pane_id", "label"]);
  });
});
