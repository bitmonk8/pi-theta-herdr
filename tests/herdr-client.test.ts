// RFC 0012 Phase 2 seam sheet §5.A-D — `src/herdr-client.ts`. Every row is one
// red test asserting a real observable named in the behaviour matrix (§5).
import type * as net from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHerdrClient,
  firstPaneId,
  herdrEndpoint,
  herdrEnv,
  herdrRequest,
  HERDR_REQUEST_TIMEOUT_MS,
  HerdrRequestError,
  type HerdrClient,
} from "../src/herdr-client.ts";
import {
  closeWithoutReply,
  hang,
  reply,
  replyChunked,
  replyError,
  replyRaw,
  resetWithoutReply,
  startFakeHerdrServer,
  type FakeHerdrServer,
} from "./helpers/fake-herdr-server.ts";

const FOUR_KEYS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"] as const;

function fullEnv(overrides: Partial<Record<(typeof FOUR_KEYS)[number], string>> = {}): NodeJS.ProcessEnv {
  return {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "s",
    HERDR_PANE_ID: "w1:p2",
    HERDR_WORKSPACE_ID: "w1",
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** A `net.Socket`-shaped fake for `connect` injection (C11, C19). */
class FakeSocket extends EventEmitter {
  readonly written: string[] = [];
  destroyed = false;
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

describe("§5.A herdrEnv", () => {
  it("A1 all four markers present resolves the exact three-key shape", () => {
    expect(herdrEnv(fullEnv())).toEqual({ socketPath: "s", paneId: "w1:p2", workspaceId: "w1" });
    expect(Object.keys(herdrEnv(fullEnv())!)).toEqual(["socketPath", "paneId", "workspaceId"]);
  });

  it("A2 missing any one of the four required keys yields null", () => {
    for (const key of FOUR_KEYS) {
      const env = fullEnv();
      delete env[key];
      expect(herdrEnv(env)).toBeNull();
    }
  });

  it("A3 HERDR_ENV other than the exact string '1' yields null", () => {
    for (const value of ["true", "yes", "0"]) {
      expect(herdrEnv(fullEnv({ HERDR_ENV: value }))).toBeNull();
    }
  });

  it("A4 an empty string on any of the four keys counts as missing", () => {
    for (const key of FOUR_KEYS) {
      expect(herdrEnv(fullEnv({ [key]: "" }))).toBeNull();
    }
  });

  it("A5 unrelated HERDR_* markers are ignored", () => {
    const env = fullEnv();
    env["HERDR_SESSION"] = "x";
    env["HERDR_TAB_ID"] = "y";
    env["HERDR_BIN_PATH"] = "z";
    expect(herdrEnv(env)).toEqual(herdrEnv(fullEnv()));
  });

  it("A6 no argument reads process.env", () => {
    const saved = { ...process.env };
    try {
      for (const key of FOUR_KEYS) delete process.env[key];
      Object.assign(process.env, fullEnv());
      expect(herdrEnv()).toEqual({ socketPath: "s", paneId: "w1:p2", workspaceId: "w1" });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });
});

describe("§5.B herdrEndpoint", () => {
  it("B1 win32 wraps the full socket path in a named-pipe literal", () => {
    expect(herdrEndpoint("C:\\Users\\t\\AppData\\Roaming\\herdr\\herdr.sock", "win32")).toBe(
      "\\\\.\\pipe\\C:\\Users\\t\\AppData\\Roaming\\herdr\\herdr.sock",
    );
  });

  it("B2 non-win32 platforms pass the socket path through unchanged", () => {
    expect(herdrEndpoint("/tmp/herdr.sock", "linux")).toBe("/tmp/herdr.sock");
    expect(herdrEndpoint("/tmp/herdr.sock", "darwin")).toBe("/tmp/herdr.sock");
  });

  it("B3 the fake server's pipe-name derivation round-trips through herdrEndpoint", () => {
    expect(herdrEndpoint("pi-theta-herdr-test-1-1", "win32")).toBe("\\\\.\\pipe\\pi-theta-herdr-test-1-1");
  });

  it("B4 one argument uses process.platform", () => {
    const expected = process.platform === "win32" ? "\\\\.\\pipe\\x" : "x";
    expect(herdrEndpoint("x")).toBe(expected);
  });
});

describe("§5.C request framing (fake daemon)", () => {
  const servers: FakeHerdrServer[] = [];

  async function fakeServer(opts?: { platform?: NodeJS.Platform }): Promise<FakeHerdrServer> {
    const server = await startFakeHerdrServer(opts);
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("C1 a successful round trip resolves the result, sends one correctly-framed request, and the fake sees the socket close", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    const result = await client.request("ping", {});
    expect(result).toEqual({ type: "ok" });
    expect(fake.connections).toBe(1);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(typeof req.id).toBe("string");
    expect(req.method).toBe("ping");
    expect(req.params).toEqual({});
    expect(req.raw).toMatch(/^\{"id":"[^"]+","method":"ping","params":\{\}\}$/);
    await waitUntil(() => fake.closedConnections === 1);
  });

  it("C2 two sequential requests use two fresh connections (Q1)", async () => {
    const fake = await fakeServer();
    const client = createHerdrClient({ env: fake.env });
    await client.request("ping", {});
    await client.request("ping", {});
    expect(fake.connections).toBe(2);
  });

  it("C3 a reply split across two writes with a gap still resolves the full result", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      replyChunked(socket, { id: request.id, result: { type: "chunked" } }, 6, 20);
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).resolves.toEqual({ type: "chunked" });
  });

  it("C4 only the first newline-terminated line is read; a second line in the same write is ignored (Q2)", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      socket.write(`${JSON.stringify({ id: request.id, result: 1 })}\n${JSON.stringify({ id: "y", result: 2 })}\n`);
      socket.end();
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).resolves.toBe(1);
  });

  it("C5 a mismatching or absent response id still resolves (no id correlation, Q2)", async () => {
    const fake = await fakeServer();
    fake.script((_request, socket) => {
      socket.write(`${JSON.stringify({ id: "not-the-request-id", result: "a" })}\n`);
      socket.end();
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).resolves.toBe("a");

    fake.script((_request, socket) => {
      socket.write(`${JSON.stringify({ result: "b" })}\n`);
      socket.end();
    });
    await expect(client.request("ping", {})).resolves.toBe("b");
  });

  it("C6 a response with no result resolves undefined (Q4)", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      socket.write(`${JSON.stringify({ id: request.id })}\n`);
      socket.end();
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).resolves.toBeUndefined();
  });

  it("C7 an error frame rejects with a refused HerdrRequestError carrying the body verbatim", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      replyError(socket, request.id, { code: "not_found", message: "no such pane" });
    });
    const client = createHerdrClient({ env: fake.env });
    let caught: unknown;
    try {
      await client.request("ping", {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as HerdrRequestError;
    expect(error).toBeInstanceOf(HerdrRequestError);
    expect(error.kind).toBe("refused");
    expect(error.method).toBe("ping");
    expect(error.message).toBe('herdr ping: {"code":"not_found","message":"no such pane"}');
    expect(error.detail).toEqual({ code: "not_found", message: "no such pane" });
    expect(error.name).toBe("Error");
  });

  it("C8 an empty error object still refuses (Q3 truthiness)", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      reply(socket, { id: request.id, error: {} });
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).rejects.toMatchObject({ kind: "refused", message: "herdr ping: {}" });
  });

  it("C9 a falsy `error: null` resolves the result (Q3)", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      reply(socket, { id: request.id, error: null, result: 7 });
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).resolves.toBe(7);
  });

  it("C10 a never-answered request rejects on its own timeout deadline", async () => {
    const fake = await fakeServer();
    fake.script(hang);
    const client = createHerdrClient({ env: fake.env });
    const started = Date.now();
    let caught: unknown;
    try {
      await client.request("ping", {}, { timeoutMs: 50 });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(500);
    const error = caught as HerdrRequestError;
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("herdr ping timed out after 50ms");
    // The client's own deadline destroys its socket rather than leaving the
    // connection dangling - the fake server's `closedConnections` counter
    // (server-side `close` event on the accepted socket) is the observable.
    await waitUntil(() => fake.closedConnections === 1);
  });

  it("C11 the default deadline is 5000ms and the request timer is unref'd", async () => {
    vi.useFakeTimers();
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const wrappedUnrefs: ReturnType<typeof vi.fn>[] = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((fn: any, ms?: number, ...rest: any[]) => {
        const timer = realSetTimeout(fn, ms, ...rest) as unknown as { unref: () => unknown };
        const original = timer.unref.bind(timer);
        const unrefSpy = vi.fn(() => original());
        timer.unref = unrefSpy;
        wrappedUnrefs.push(unrefSpy);
        return timer as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);
    try {
      const socket = new FakeSocket();
      const client = createHerdrClient({
        env: fullEnv(),
        connect: (): net.Socket => {
          queueMicrotask(() => socket.emit("connect"));
          return socket as unknown as net.Socket;
        },
      });
      expect(HERDR_REQUEST_TIMEOUT_MS).toBe(5000);
      let outcome: "pending" | "rejected" = "pending";
      let capturedError: unknown;
      void client.request("ping", {}).catch((error: unknown) => {
        outcome = "rejected";
        capturedError = error;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(wrappedUnrefs).toHaveLength(1);
      expect(wrappedUnrefs[0]).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("rejected");
      expect((capturedError as HerdrRequestError).kind).toBe("timeout");
      expect((capturedError as HerdrRequestError).message).toBe("herdr ping timed out after 5000ms");
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("C12 a server that stopped listening rejects unreachable", async () => {
    const fake = await fakeServer();
    const env = fake.env;
    await fake.close();
    const client = createHerdrClient({ env });
    let caught: unknown;
    try {
      await client.request("ping", {});
    } catch (error) {
      caught = error;
    }
    const error = caught as HerdrRequestError;
    expect(error.kind).toBe("unreachable");
    expect(error.message.startsWith("herdr unreachable: ")).toBe(true);
  });

  it("C13 the peer ending before a newline rejects closed (Q8)", async () => {
    const fake = await fakeServer();
    fake.script((_request, socket) => {
      closeWithoutReply(socket);
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).rejects.toMatchObject({
      kind: "closed",
      message: "herdr ping: connection closed before response",
    });
  });

  it("C14 a hard reset never hangs and rejects within the deadline bound", async () => {
    const fake = await fakeServer();
    fake.script((_request, socket) => {
      resetWithoutReply(socket);
    });
    const client = createHerdrClient({ env: fake.env });
    const started = Date.now();
    let caught: unknown;
    try {
      await client.request("ping", {}, { timeoutMs: 50 });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
    const error = caught as HerdrRequestError;
    expect(["closed", "unreachable", "timeout"]).toContain(error.kind);
  });

  it("C15 a non-JSON first line rejects unparseable", async () => {
    const fake = await fakeServer();
    fake.script((_request, socket) => {
      replyRaw(socket, "not json\n");
    });
    const client = createHerdrClient({ env: fake.env });
    let caught: unknown;
    try {
      await client.request("ping", {});
    } catch (error) {
      caught = error;
    }
    const error = caught as HerdrRequestError;
    expect(error.kind).toBe("unparseable");
    expect(error.message.startsWith("herdr ping: unparseable response: ")).toBe(true);
  });

  it("C16 valid JSON that is not an object rejects unparseable (D2 hardening delta)", async () => {
    for (const bytes of ["null\n", "42\n", '"x"\n']) {
      const fake = await fakeServer();
      fake.script((_request, socket) => {
        replyRaw(socket, bytes);
      });
      const client = createHerdrClient({ env: fake.env });
      await expect(client.request("ping", {})).rejects.toMatchObject({
        kind: "unparseable",
        message: "herdr ping: unparseable response: not a JSON object",
      });
    }
  });

  it("C17 a trailing \\r\\n still parses (Q10)", async () => {
    const fake = await fakeServer();
    fake.script((request, socket) => {
      replyRaw(socket, `${JSON.stringify({ id: request.id, result: 5 })}\r\n`);
    });
    const client = createHerdrClient({ env: fake.env });
    await expect(client.request("ping", {})).resolves.toBe(5);
  });

  it("C18 a vanished pane env rejects synchronously and attempts no connection (Q6)", async () => {
    let connectCalls = 0;
    const client = createHerdrClient({
      env: {},
      connect: (): net.Socket => {
        connectCalls += 1;
        return new FakeSocket() as unknown as net.Socket;
      },
    });
    let caught: unknown;
    try {
      await client.request("ping", {});
    } catch (error) {
      caught = error;
    }
    const error = caught as HerdrRequestError;
    expect(error.kind).toBe("not-in-pane");
    expect(error.message).toBe("not inside a herdr pane");
    expect(connectCalls).toBe(0);
  });

  it("C19 the written frame is exactly JSON.stringify({ id, method, params }) + '\\n'", async () => {
    const socket = new FakeSocket();
    const client = createHerdrClient({
      env: fullEnv(),
      connect: (): net.Socket => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as net.Socket;
      },
    });
    void client.request("ping", {}).catch(() => {});
    await waitUntil(() => socket.written.length === 1);
    expect(socket.written).toHaveLength(1);
    const written = socket.written[0]!;
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written.slice(0, -1)) as { id: string; method: string; params: unknown };
    expect(parsed.method).toBe("ping");
    expect(parsed.params).toEqual({});
    expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("C20 the module-level herdrRequest behaves as C1 through the default client", async () => {
    const fake = await fakeServer();
    const saved = { ...process.env };
    try {
      for (const key of FOUR_KEYS) delete process.env[key];
      Object.assign(process.env, fake.env);
      await expect(herdrRequest("ping", {})).resolves.toEqual({ type: "ok" });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });
});

describe("§5.D firstPaneId", () => {
  it("D1 a bare pane node resolves its own pane_id", () => {
    expect(firstPaneId({ type: "pane", pane_id: "w1:p9" })).toBe("w1:p9");
  });

  it("D2 a split resolves its `first` child before its `second`", () => {
    expect(
      firstPaneId({
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "pane", pane_id: "w1:p1" },
        second: { type: "pane", pane_id: "w1:p2" },
      }),
    ).toBe("w1:p1");
  });

  it("D3 a first child without a pane_id falls through to second", () => {
    expect(
      firstPaneId({
        type: "split",
        first: { type: "pane" },
        second: { type: "pane", pane_id: "w1:p2" },
      }),
    ).toBe("w1:p2");
  });

  it("D4 a three-deep nesting finds the only pane in second.second", () => {
    expect(
      firstPaneId({
        type: "split",
        first: { type: "pane" },
        second: {
          type: "split",
          first: { type: "pane" },
          second: { type: "pane", pane_id: "w1:p4" },
        },
      }),
    ).toBe("w1:p4");
  });

  it("D5 a pane node with no pane_id, or a non-string pane_id, yields null", () => {
    expect(firstPaneId({ type: "pane" })).toBeNull();
    expect(firstPaneId({ type: "pane", pane_id: 7 })).toBeNull();
  });

  it("D6 falsy or non-object input yields null", () => {
    for (const value of [null, undefined, "", 0, "pane", []]) {
      expect(firstPaneId(value)).toBeNull();
    }
  });

  it("D7 a split with no children yields null", () => {
    expect(firstPaneId({ type: "split" })).toBeNull();
  });
});
