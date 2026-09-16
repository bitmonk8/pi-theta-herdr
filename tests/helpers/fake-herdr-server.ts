// Fake Herdr daemon over `node:net` (seam sheet §2.6, §6.1). Mirrors the real
// daemon's per-connection contract: one request per fresh connection, read to
// the first `\n`, reply, then end. Named pipe on win32
// (`\\.\pipe\pi-theta-herdr-test-<pid>-<n>`), a `mkdtemp`-rooted unix socket
// elsewhere (keeps the path under macOS's ~104-byte limit).
//
// WHY a counter, not a random suffix: `<pid>-<n>` makes a hung test's pipe
// name reproducible in a failure log without reading a random id off stderr.

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface FakeHerdrRequest {
  readonly id: unknown;
  readonly method: string;
  readonly params: unknown;
  /** The exact bytes of the request line (sans the trailing `\n`) — Q9/Q10 witness. */
  readonly raw: string;
}

export type FakeHerdrHandler = (request: FakeHerdrRequest, socket: net.Socket) => void;

export interface FakeHerdrServer {
  /** What `HERDR_SOCKET_PATH` must be: the bare pipe name on win32, the socket file path elsewhere. */
  readonly socketPath: string;
  /** `{ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" }` */
  readonly env: NodeJS.ProcessEnv;
  /** Requests seen so far, arrival order. */
  readonly requests: readonly FakeHerdrRequest[];
  /** Accepted connections so far. */
  readonly connections: number;
  /** Server-side `close` events so far (Q1 witness: the client always `destroy()`s). */
  readonly closedConnections: number;
  /** Replace the per-connection handler. Default: reply `{ id, result: { type: "ok" } }`. */
  script(handler: FakeHerdrHandler): void;
  close(): Promise<void>;
}

let counter = 0;

const defaultHandler: FakeHerdrHandler = (request, socket) => {
  reply(socket, { id: request.id, result: { type: "ok" } });
};

export async function startFakeHerdrServer(
  opts: { readonly platform?: NodeJS.Platform } = {},
): Promise<FakeHerdrServer> {
  const platform = opts.platform ?? process.platform;
  counter += 1;
  const n = counter;

  const requests: FakeHerdrRequest[] = [];
  let connections = 0;
  let closedConnections = 0;
  let handler: FakeHerdrHandler = defaultHandler;
  let tmpDir: string | undefined;

  let listenPath: string;
  let socketPath: string;
  if (platform === "win32") {
    const name = `pi-theta-herdr-test-${process.pid}-${n}`;
    socketPath = name;
    listenPath = `\\\\.\\pipe\\${name}`;
  } else {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-theta-herdr-"));
    socketPath = path.join(tmpDir, "herdr.sock");
    listenPath = socketPath;
  }

  const server = net.createServer((socket) => {
    connections += 1;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return; // one request per connection: wait for the first full line
      const raw = buffer.slice(0, nl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A malformed request from the client under test is not this fake's
        // concern (§6.1: the fake mirrors the daemon's REPLY behaviour; a
        // client bug in framing its own request is out of scope here).
        return;
      }
      const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const request: FakeHerdrRequest = {
        id: record["id"],
        method: typeof record["method"] === "string" ? (record["method"] as string) : "",
        params: record["params"],
        raw,
      };
      requests.push(request);
      handler(request, socket);
    });
    socket.on("close", () => {
      closedConnections += 1;
    });
    // A client-side RST after the fake already replied/ended is expected
    // (Q1: the client always `destroy()`s its socket) — swallow, never crash
    // the test process on an expected `ECONNRESET`.
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPath, () => resolve());
  });

  return {
    get socketPath(): string {
      return socketPath;
    },
    get env(): NodeJS.ProcessEnv {
      return { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };
    },
    get requests(): readonly FakeHerdrRequest[] {
      return requests;
    },
    get connections(): number {
      return connections;
    },
    get closedConnections(): number {
      return closedConnections;
    },
    script(next: FakeHerdrHandler): void {
      handler = next;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => {
          if (tmpDir !== undefined) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
          resolve();
        });
      });
    },
  };
}

/** JSON-encode `frame`, terminate with `\n`, then end the connection (the daemon's normal reply). */
export function reply(socket: net.Socket, frame: unknown): void {
  socket.write(`${JSON.stringify(frame)}\n`);
  socket.end();
}

/** Write raw bytes verbatim (non-JSON / non-object first-line rows), then end. */
export function replyRaw(socket: net.Socket, bytes: string): void {
  socket.write(bytes);
  socket.end();
}

/** Split one frame's line across two `write` calls with `gapMs` between them (C3). */
export function replyChunked(socket: net.Socket, frame: unknown, splitAt: number, gapMs: number): void {
  const line = `${JSON.stringify(frame)}\n`;
  const head = line.slice(0, splitAt);
  const tail = line.slice(splitAt);
  socket.write(head);
  setTimeout(() => {
    socket.write(tail);
    socket.end();
  }, gapMs);
}

/** Reply with an `{ id, error }` frame. */
export function replyError(socket: net.Socket, id: unknown, body: { code: string; message: string }): void {
  reply(socket, { id, error: body });
}

/** Never reply — the caller installs this as the script for a timeout row. */
export function hang(): void {
  // Intentionally does nothing: the client's own deadline is what ends the test.
}

/** End the connection with no data written — "connection closed before response" (Q8). */
export function closeWithoutReply(socket: net.Socket): void {
  socket.end();
}

/** Abort the connection (RST/FIN without a graceful end) — the C14 hard-reset row. */
export function resetWithoutReply(socket: net.Socket): void {
  socket.destroy();
}
