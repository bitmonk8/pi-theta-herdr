import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORE_PROTOCOL_GENERATION,
  CoreRequestError,
  assertLocalTarget,
  coreEnv,
  coreName,
  createCoreClient,
  isLocalCoreAddress,
} from "../src/core-client.ts";

/** A fake local core: answers hello with `generation`, records every request it receives. */
function fakeCore(opts: { generation?: number; reply?: (method: string, params: any) => unknown; error?: (method: string) => unknown } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-hc-"));
  const sock = path.join(dir, "core.sock");
  const received: { method: string; params: any }[] = [];
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        received.push({ method: msg.method, params: msg.params });
        if (msg.method === "hello") {
          s.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { generation: opts.generation ?? 1, version: "0.1.18", core: { id: "core-abc", name: "pop-os" }, framed: false, methods: [], features: [] } })}\n`);
          // an unrelated notification must be ignored
          s.write(`${JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 1 } })}\n`);
          continue;
        }
        const err = opts.error?.(msg.method);
        if (err) {
          s.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: err })}\n`);
          continue;
        }
        const result = opts.reply ? opts.reply(msg.method, msg.params) : { address: "t2", name: msg.params?.name ?? null, state: "live" };
        s.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
      }
    });
  });
  return {
    sock,
    received,
    get connections() {
      return connections;
    },
    start: () => new Promise<void>((r) => server.listen(sock, () => r())),
    stop: () => new Promise<void>((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })),
  };
}

const envFor = (sock: string, extra: Record<string, string> = {}) => ({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: sock, ...extra });

describe("coreEnv", () => {
  it("needs both HC_TERMINAL_ID and an absolute HC_TERMINAL_SOCKET", () => {
    expect(coreEnv({})).toBeNull();
    expect(coreEnv({ HC_TERMINAL_ID: "t1" })).toBeNull();
    expect(coreEnv({ HC_TERMINAL_SOCKET: "/run/x.sock" })).toBeNull();
    expect(coreEnv({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "rel.sock" })).toBeNull();
    expect(coreEnv({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/run/x.sock" })).toEqual({ terminalId: "t1", socketPath: "/run/x.sock", session: null });
  });
  it("rejects a qualified or malformed id", () => {
    expect(coreEnv({ HC_TERMINAL_ID: "vps/t1", HC_TERMINAL_SOCKET: "/s" })).toBeNull();
    expect(coreEnv({ HC_TERMINAL_ID: "w7:pC", HC_TERMINAL_SOCKET: "/s" })).toBeNull();
    expect(coreEnv({ HC_TERMINAL_ID: "t0", HC_TERMINAL_SOCKET: "/s" })).toBeNull();
  });
  it("legacy Herdr markers alone are never Core identity", () => {
    expect(coreEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w7:pC", HERDR_SOCKET_PATH: "/x", HERDR_WORKSPACE_ID: "w7" })).toBeNull();
  });
  it("keeps HC_SESSION as routing", () => {
    expect(coreEnv({ HC_TERMINAL_ID: "t9z", HC_TERMINAL_SOCKET: "/s", HC_SESSION: "mtx" })?.session).toBe("mtx");
  });
});

describe("addresses and names", () => {
  it("local addresses follow Core's alphabet", () => {
    for (const a of ["t1", "t9", "t10", "t1b", "t9zz"]) expect(isLocalCoreAddress(a)).toBe(true);
    for (const a of ["t0", "t1a", "t1l", "x1", "vps/t1", "w1:p4", ""]) expect(isLocalCoreAddress(a)).toBe(false);
  });
  it("assertLocalTarget rejects machine-qualified targets as nonlocal", () => {
    expect(() => assertLocalTarget("vps/t3", "parent", "terminal.run")).toThrow(/another machine/);
    try {
      assertLocalTarget("vps/t3", "parent", "terminal.run");
    } catch (e) {
      expect((e as CoreRequestError).kind).toBe("nonlocal");
    }
  });
  it("coreName is always valid, bounded, letter/digit-first and never id-shaped", () => {
    const labels = ["Theta: research ✓ (deep) / step #3", "t7", "---", "", "UPPER_case.name", "x".repeat(200), "t1b-worker"];
    for (const l of labels) {
      const n = coreName(l, "a1b2c3");
      expect(n.length).toBeLessThanOrEqual(32);
      expect(n).toMatch(/^[a-z0-9][a-z0-9._-]{0,31}$/);
      expect(isLocalCoreAddress(n)).toBe(false);
      expect(n.endsWith("-a1b2c3")).toBe(true);
    }
    expect(coreName("t7", "a1b2c3")).toBe("w-t7-a1b2c3");
    expect(coreName("a", "x") === coreName("a", "y")).toBe(false);
  });
});

describe("runParams: cwd, caller and parent are always explicit", () => {
  const c = createCoreClient({ env: envFor("/run/fake.sock") });
  it("default parent is this terminal", () => {
    const p = c.runParams({ argv: ["node", "x.mjs"], cwd: "/home/u/p" });
    expect(p).toMatchObject({ argv: ["node", "x.mjs"], cwd: "/home/u/p", caller: "t1", parent: "t1" });
    expect("no_parent" in p).toBe(false);
  });
  it("noParent sends no_parent and no parent key", () => {
    const p = c.runParams({ argv: ["a"], cwd: "/", noParent: true });
    expect(p).toMatchObject({ cwd: "/", caller: "t1", no_parent: true });
    expect("parent" in p).toBe(false);
  });
  it("explicit local parent passes, remote parent is rejected", () => {
    expect(c.runParams({ argv: ["a"], cwd: "/", parent: "t5" })["parent"]).toBe("t5");
    expect(() => c.runParams({ argv: ["a"], cwd: "/", parent: "vps/t5" })).toThrow(/another machine/);
  });
  it("relative or missing cwd is refused", () => {
    expect(() => c.runParams({ argv: ["a"], cwd: "rel" })).toThrow(/absolute/);
    expect(() => c.runParams({ argv: ["a"] } as any)).toThrow(/absolute/);
  });
  it("'on' is refused", () => {
    expect(() => c.runParams({ argv: ["a"], cwd: "/", on: "vps" } as any)).toThrow(/remote machine/);
  });
  it("secret-looking env names are refused (Core persists overlays)", () => {
    for (const k of ["FREEPIK_API_KEY", "PERPLEXITY_API_KEY", "GITHUB_TOKEN", "MY_SECRET", "ANTHROPIC_BASE"]) {
      expect(() => c.runParams({ argv: ["a"], cwd: "/", env: { [k]: "v" } })).toThrow(/refusing/);
    }
    expect(c.runParams({ argv: ["a"], cwd: "/", env: { PI_SUBAGENT_RECONCILE: "0" } })["env"]).toEqual({ PI_SUBAGENT_RECONCILE: "0" });
  });
  it("lifecycle flags are only sent when set", () => {
    const p = c.runParams({ argv: ["a"], cwd: "/", outliveParent: true, noNotify: true, name: "w-abc", labels: { role: "subagent" } });
    expect(p).toMatchObject({ outlive_parent: true, no_notify: true, name: "w-abc", labels: { role: "subagent" } });
    expect("keep" in p || "rm" in p).toBe(false);
  });
  it("invalid names are refused", () => {
    expect(() => c.runParams({ argv: ["a"], cwd: "/", name: "t7" })).toThrow(/invalid name/);
    expect(() => c.runParams({ argv: ["a"], cwd: "/", name: "Has Space" })).toThrow(/invalid name/);
  });
  it("outside a Core terminal nothing is built", () => {
    expect(() => createCoreClient({ env: {} }).runParams({ argv: ["a"], cwd: "/" })).toThrow(/not inside a herdr-core terminal/);
  });
});

describe("over a socket", () => {
  let core: ReturnType<typeof fakeCore>;
  afterEach(async () => core && (await core.stop()));

  it("hello precedes every call and terminal.run carries cwd/caller/parent", async () => {
    core = fakeCore();
    await core.start();
    const c = createCoreClient({ env: envFor(core.sock) });
    const { terminal, core: id } = await c.terminalRun({ argv: ["node", "child.mjs"], cwd: "/tmp", outliveParent: true, noNotify: true, name: "w-x" });
    expect(terminal.address).toBe("t2");
    expect(id).toMatchObject({ id: "core-abc", name: "pop-os", version: "0.1.18", generation: CORE_PROTOCOL_GENERATION, socketPath: core.sock });
    expect(core.received.map((r) => r.method)).toEqual(["hello", "terminal.run"]);
    expect(core.received[0]!.params).toEqual({ generation: 1 });
    expect(core.received[1]!.params).toMatchObject({ cwd: "/tmp", caller: "t1", parent: "t1", outlive_parent: true, no_notify: true });
  });

  it("refuses an unknown protocol generation and never sends the call", async () => {
    core = fakeCore({ generation: 2 });
    await core.start();
    const c = createCoreClient({ env: envFor(core.sock) });
    await expect(c.terminalRun({ argv: ["a"], cwd: "/tmp" })).rejects.toMatchObject({ kind: "generation" });
    expect(core.received.map((r) => r.method)).toEqual(["hello"]);
  });

  it("rejects remote targets with zero connections", async () => {
    core = fakeCore();
    await core.start();
    const c = createCoreClient({ env: envFor(core.sock) });
    await expect(c.terminalKill("vps/t3")).rejects.toMatchObject({ kind: "nonlocal" });
    await expect(c.terminalGet("vps/name")).rejects.toMatchObject({ kind: "nonlocal" });
    await expect(c.terminalRm("vps/t3")).rejects.toMatchObject({ kind: "nonlocal" });
    await expect(c.terminalLabel("vps/t3", { a: "b" })).rejects.toMatchObject({ kind: "nonlocal" });
    await expect(c.request("terminal.run", { argv: ["a"], cwd: "/", on: "vps" })).rejects.toMatchObject({ kind: "nonlocal" });
    await expect(c.request("terminal.run", { argv: ["a"], cwd: "/", parent: "vps/t1" })).rejects.toMatchObject({ kind: "nonlocal" });
    expect(() => c.runParams({ argv: ["a"], cwd: "/", parent: "vps/t1" })).toThrow();
    expect(core.connections).toBe(0);
  });

  it("a result that is not a local terminal record is an error", async () => {
    core = fakeCore({ reply: () => ({ address: "vps/t2" }) });
    await core.start();
    const c = createCoreClient({ env: envFor(core.sock) });
    await expect(c.terminalRun({ argv: ["a"], cwd: "/tmp" })).rejects.toMatchObject({ kind: "unexpected-result" });
  });

  it("maps JSON-RPC errors with their stable kind", async () => {
    core = fakeCore({ error: () => ({ code: -32000, message: "no terminal t9", data: { kind: "not_found", hint: "" } }) });
    await core.start();
    const c = createCoreClient({ env: envFor(core.sock) });
    await expect(c.terminalGet("t9")).rejects.toMatchObject({ kind: "refused", rpcKind: "not_found" });
  });

  it("terminal.label sends no caller", async () => {
    core = fakeCore({ reply: () => ({}) });
    await core.start();
    const c = createCoreClient({ env: envFor(core.sock) });
    await c.terminalLabel("t2", { status: "FAILED" });
    expect(core.received[1]).toEqual({ method: "terminal.label", params: { terminal: "t2", labels: { status: "FAILED" } } });
  });

  it("unreachable socket is reported, not hung", async () => {
    const c = createCoreClient({ env: envFor("/nonexistent/dir/core.sock") });
    await expect(c.hello({ timeoutMs: 1000 })).rejects.toMatchObject({ kind: "unreachable" });
  });
});
