import { randomBytes } from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";

/**
 * Herdr Core (`hc`) JSON-RPC 2.0 client — local cores only.
 *
 * Public deep-import path (like `herdr-client.ts`): pi-config's subagent tool imports
 * `@bitmonk8/pi-theta-herdr/src/core-client.ts`. Treat the path and the exported names as API.
 *
 * Contract (Herdr Core 0.1.18, protocol generation 1, `schema/README.md` + `released.openrpc.json`):
 *  - plain mode: one JSON-RPC message per line over the core's Unix socket;
 *  - every connection opens with `hello { generation }` and this client REFUSES any other
 *    generation than the one it was built and tested against (`CORE_PROTOCOL_GENERATION`);
 *  - `terminal.run` always carries `cwd`, `caller` (this terminal) and EITHER `parent` OR
 *    `no_parent: true`: through the API `cwd` defaults to the core's own folder, and a request
 *    without caller/parent silently creates a root terminal;
 *  - LOCAL ONLY: an `on` machine, a `machine/t7` address or a qualified parent is rejected
 *    before any connection is opened — this transport is loopback/file based and is not
 *    remote-safe just because Core supports SSH machines;
 *  - Core persists a run's `env` overlay in its terminal records (`restart_env`, saved, never
 *    shown), so secret-looking names are refused in the overlay: secrets reach a child only
 *    through a launcher that reads them itself.
 *
 * No module-level mutable state (companion rule I3): everything lives in the factory closure.
 */

export const CORE_PROTOCOL_GENERATION = 1;
export const CORE_REQUEST_TIMEOUT_MS = 5000;
export const CORE_RUN_TIMEOUT_MS = 15_000;

/** `t7`, `t1b`: after `t`, a digit 1-9 then the 30 Core symbols (no vowels, no `l`). */
const LOCAL_ADDRESS = /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;
/** Core `addr.rs check_name`: 1-32 of a-z 0-9 - _ . starting with a letter or digit. */
const CORE_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** Env names the client never sends in an overlay (Core writes overlays to disk). */
const SECRET_NAME = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$|_API_KEY$|^AWS_|^ANTHROPIC_|^OPENAI_/i;

export interface CoreTerminalEnv {
  /** This process's own terminal address (`HC_TERMINAL_ID`), always local. */
  readonly terminalId: string;
  /** The core's socket (`HC_TERMINAL_SOCKET`), absolute. */
  readonly socketPath: string;
  /** `HC_SESSION` when set (routing, not identity); null = default session. */
  readonly session: string | null;
}

export type CoreRequestFailureKind =
  | "not-in-core"
  | "nonlocal"
  | "invalid-request"
  | "unreachable"
  | "timeout"
  | "closed"
  | "unparseable"
  | "generation"
  | "refused"
  | "unexpected-result";

export class CoreRequestError extends Error {
  readonly method: string;
  readonly kind: CoreRequestFailureKind;
  /** Core's error `data.kind` (`not_found`, `usage`, `spawn_failed`, ...) for `refused`. */
  readonly rpcKind: string | undefined;
  readonly detail: unknown;
  constructor(message: string, method: string, kind: CoreRequestFailureKind, detail?: unknown, rpcKind?: string) {
    super(message);
    this.method = method;
    this.kind = kind;
    this.detail = detail;
    this.rpcKind = rpcKind;
  }
}

/** Core's identity from `hello`: permanent random id + display name, plus version/generation. */
export interface CoreIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly generation: number;
  readonly socketPath: string;
  readonly session: string | null;
}

export interface CoreRequestOptions {
  readonly timeoutMs?: number;
}

export interface CoreClientDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly connect?: (socketPath: string) => net.Socket;
  /**
   * Anonymous mode, for tools that run OUTSIDE any Core terminal (e.g. resurrect after a reboot):
   * connect to this socket with no caller identity. Only root runs (`noParent: true`) are allowed
   * and no `caller` is sent. Connecting never starts a core: a missing daemon is `unreachable`.
   */
  readonly endpoint?: string;
  /** Generations this build accepts. Default `[CORE_PROTOCOL_GENERATION]`. Tests only. */
  readonly acceptedGenerations?: readonly number[];
}

/** Terminal record subset the adapters rely on (`Terminal` in the schema). */
export interface CoreTerminal {
  readonly address: string;
  readonly name?: string | null;
  readonly state?: string;
  readonly pid?: number | null;
  readonly parent?: string | null;
  readonly cwd?: string;
  readonly exit_code?: number | null;
  readonly reason?: string | null;
  readonly labels?: Record<string, string>;
  readonly [k: string]: unknown;
}

export interface CoreRunInput {
  readonly argv: readonly string[];
  /** Absolute working directory. Required: through the API Core would use its own. */
  readonly cwd: string;
  /** Explicit local parent; default this terminal. Ignored when `noParent`. */
  readonly parent?: string;
  /** Start a root terminal on purpose (`no_parent: true`, no `parent` key). */
  readonly noParent?: boolean;
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** Non-secret overlay only; Core persists it. */
  readonly env?: Readonly<Record<string, string>>;
  readonly outliveParent?: boolean;
  readonly noNotify?: boolean;
  readonly keep?: boolean;
  readonly rm?: boolean;
}

export interface CoreClient {
  env(): CoreTerminalEnv | null;
  hello(opts?: CoreRequestOptions): Promise<CoreIdentity>;
  /** One request on a fresh connection, after a checked `hello`. */
  request(method: string, params: Record<string, unknown>, opts?: CoreRequestOptions): Promise<{ result: unknown; core: CoreIdentity }>;
  /** Builds the exact `terminal.run` params this client would send (pure; for tests and dry runs). */
  runParams(input: CoreRunInput): Record<string, unknown>;
  terminalRun(input: CoreRunInput, opts?: CoreRequestOptions): Promise<{ terminal: CoreTerminal; core: CoreIdentity }>;
  terminalGet(terminal: string, opts?: CoreRequestOptions): Promise<CoreTerminal>;
  terminalKill(terminal: string, opts?: CoreRequestOptions): Promise<CoreTerminal>;
  terminalRm(terminal: string, opts?: CoreRequestOptions): Promise<void>;
  terminalLabel(terminal: string, labels: Readonly<Record<string, string>>, opts?: CoreRequestOptions): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isLocalCoreAddress(value: unknown): value is string {
  return typeof value === "string" && LOCAL_ADDRESS.test(value);
}

/** Rejects `machine/t7`, `machine/name` and anything else that names another machine. */
export function assertLocalTarget(value: string, field: string, method: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new CoreRequestError(`herdr-core ${method}: ${field} is empty`, method, "invalid-request");
  }
  if (value.includes("/")) {
    throw new CoreRequestError(
      `herdr-core ${method}: ${field} ${JSON.stringify(value)} names another machine; only local terminals are supported`,
      method,
      "nonlocal",
    );
  }
  if (!LOCAL_ADDRESS.test(value) && !CORE_NAME.test(value)) {
    throw new CoreRequestError(`herdr-core ${method}: ${field} ${JSON.stringify(value)} is not a local terminal address or name`, method, "invalid-request");
  }
}

/**
 * Core terminal identity of this process. All of it or none: both `HC_TERMINAL_ID` and an
 * absolute `HC_TERMINAL_SOCKET`, and the id must be a local address. Never inferred from a
 * binary on PATH.
 */
export function coreEnv(env: NodeJS.ProcessEnv = process.env): CoreTerminalEnv | null {
  const id = env["HC_TERMINAL_ID"];
  const sock = env["HC_TERMINAL_SOCKET"];
  if (!id || !sock || !isLocalCoreAddress(id) || !path.isAbsolute(sock)) return null;
  const session = env["HC_SESSION"]?.trim() || null;
  return { terminalId: id, socketPath: sock, session };
}

/**
 * A collision-safe Core name from an arbitrary label (theta labels may hold characters Core
 * rejects): lowercase, invalid runs -> `-`, a letter-first stem, plus a random suffix; never
 * id-shaped; at most 32 characters.
 */
export function coreName(label: string, suffix: string = randomBytes(3).toString("hex")): string {
  let stem = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_.]+$/, "");
  if (!stem || /^t[1-9]/.test(stem)) stem = `w-${stem}`.replace(/-+$/, "");
  const room = 32 - 1 - suffix.length;
  stem = stem.slice(0, room).replace(/[-_.]+$/, "") || "w";
  const name = `${stem}-${suffix}`;
  if (!CORE_NAME.test(name) || LOCAL_ADDRESS.test(name)) throw new Error(`coreName produced an invalid name: ${name}`);
  return name;
}

export function createCoreClient(deps: CoreClientDeps = {}): CoreClient {
  const clientEnv = deps.env ?? process.env;
  const connect = deps.connect ?? ((p: string): net.Socket => net.connect({ path: p }));
  const accepted = deps.acceptedGenerations ?? [CORE_PROTOCOL_GENERATION];

  const anonymous = deps.endpoint !== undefined;
  if (anonymous && !path.isAbsolute(deps.endpoint as string)) {
    throw new CoreRequestError("herdr-core: endpoint must be an absolute socket path", "connect", "invalid-request");
  }
  const self = (method: string): CoreTerminalEnv => {
    if (anonymous) return { terminalId: "", socketPath: deps.endpoint as string, session: clientEnv["HC_SESSION"]?.trim() || null };
    const e = coreEnv(clientEnv);
    if (!e) throw new CoreRequestError("not inside a herdr-core terminal (HC_TERMINAL_ID / HC_TERMINAL_SOCKET missing or invalid)", method, "not-in-core");
    return e;
  };

  /** hello, then (optionally) one call, on one fresh connection. */
  const exchange = (
    method: string,
    params: Record<string, unknown> | null,
    opts: CoreRequestOptions,
  ): Promise<{ result: unknown; core: CoreIdentity }> => {
    let me: CoreTerminalEnv;
    try {
      me = self(method);
    } catch (err) {
      return Promise.reject(err);
    }
    const timeoutMs = opts.timeoutMs ?? CORE_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = connect(me.socketPath);
      let buffer = "";
      let done = false;
      let core: CoreIdentity | null = null;
      const finish = (err: Error | null, result?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve({ result, core: core as CoreIdentity });
      };
      const timer = setTimeout(() => finish(new CoreRequestError(`herdr-core ${method} timed out after ${timeoutMs}ms`, method, "timeout")), timeoutMs);
      timer.unref?.();
      const send = (id: number, m: string, p: Record<string, unknown>): void => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p })}\n`);
      };
      socket.on("connect", () => send(1, "hello", { generation: CORE_PROTOCOL_GENERATION }));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch (err) {
            finish(new CoreRequestError(`herdr-core ${method}: unparseable response: ${(err as Error).message}`, method, "unparseable"));
            return;
          }
          if (!isRecord(msg) || !("id" in msg)) continue; // notifications are not ours
          if (msg["error"]) {
            const e = msg["error"];
            const rpcKind = isRecord(e) && isRecord(e["data"]) && typeof e["data"]["kind"] === "string" ? (e["data"]["kind"] as string) : undefined;
            const which = msg["id"] === 1 ? "hello" : method;
            finish(new CoreRequestError(`herdr-core ${which}: ${JSON.stringify(e)}`, which, "refused", e, rpcKind));
            return;
          }
          if (msg["id"] === 1) {
            const r = msg["result"];
            const gen = isRecord(r) ? r["generation"] : undefined;
            if (typeof gen !== "number" || !accepted.includes(gen)) {
              finish(new CoreRequestError(
                `herdr-core speaks protocol generation ${String(gen)}; this adapter is built and tested for ${accepted.join(", ")} only`,
                "hello", "generation", r));
              return;
            }
            const info = isRecord(r) && isRecord(r["core"]) ? r["core"] : {};
            core = {
              id: typeof info["id"] === "string" ? info["id"] : "",
              name: typeof info["name"] === "string" ? info["name"] : "",
              version: isRecord(r) && typeof r["version"] === "string" ? (r["version"] as string) : "",
              generation: gen,
              socketPath: me.socketPath,
              session: me.session,
            };
            if (!core.id) {
              finish(new CoreRequestError("herdr-core hello carried no core id", "hello", "unexpected-result", r));
              return;
            }
            if (params === null) finish(null, r);
            else send(2, method, params);
            continue;
          }
          if (msg["id"] === 2) {
            finish(null, msg["result"]);
            return;
          }
        }
      });
      socket.on("error", (err) => finish(new CoreRequestError(`herdr-core unreachable: ${err.message}`, method, "unreachable")));
      socket.on("end", () => finish(new CoreRequestError(`herdr-core ${method}: connection closed before response`, method, "closed")));
    });
  };

  const hello = async (opts: CoreRequestOptions = {}): Promise<CoreIdentity> => (await exchange("hello", null, opts)).core;

  const request = (method: string, params: Record<string, unknown>, opts: CoreRequestOptions = {}) => {
    if ("on" in params && params["on"] != null) {
      return Promise.reject(new CoreRequestError(`herdr-core ${method}: 'on' (remote machine) is not supported by this adapter`, method, "nonlocal"));
    }
    for (const field of ["terminal", "parent"] as const) {
      const v = params[field];
      if (typeof v === "string") {
        try {
          assertLocalTarget(v, field, method);
        } catch (err) {
          return Promise.reject(err);
        }
      }
    }
    return exchange(method, params, opts);
  };

  const runParams = (input: CoreRunInput): Record<string, unknown> => {
    const method = "terminal.run";
    const me = self(method);
    if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.some((a) => typeof a !== "string")) {
      throw new CoreRequestError("herdr-core terminal.run: argv must be a non-empty string array", method, "invalid-request");
    }
    if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) {
      throw new CoreRequestError("herdr-core terminal.run: cwd must be an absolute path (Core would otherwise use its own)", method, "invalid-request");
    }
    if ((input as unknown as Record<string, unknown>)["on"] != null) {
      throw new CoreRequestError("herdr-core terminal.run: 'on' (remote machine) is not supported by this adapter", method, "nonlocal");
    }
    if (input.name !== undefined && (!CORE_NAME.test(input.name) || LOCAL_ADDRESS.test(input.name))) {
      throw new CoreRequestError(`herdr-core terminal.run: invalid name ${JSON.stringify(input.name)}`, method, "invalid-request");
    }
    const env = { ...(input.env ?? {}) };
    const secret = Object.keys(env).filter((k) => SECRET_NAME.test(k));
    if (secret.length) {
      throw new CoreRequestError(
        `herdr-core terminal.run: refusing to send ${secret.join(", ")} in the env overlay (Core persists overlays); let the launcher read secrets itself`,
        method, "invalid-request");
    }
    if (anonymous && !input.noParent) {
      throw new CoreRequestError("herdr-core terminal.run: outside a Core terminal only root runs (noParent) are allowed", method, "invalid-request");
    }
    const params: Record<string, unknown> = {
      argv: [...input.argv],
      cwd: input.cwd,
      ...(anonymous ? {} : { caller: me.terminalId }),
    };
    if (input.noParent) {
      params["no_parent"] = true;
    } else {
      const parent = input.parent ?? me.terminalId;
      assertLocalTarget(parent, "parent", method);
      params["parent"] = parent;
    }
    if (input.name !== undefined) params["name"] = input.name;
    if (input.labels && Object.keys(input.labels).length) params["labels"] = { ...input.labels };
    if (Object.keys(env).length) params["env"] = env;
    if (input.outliveParent) params["outlive_parent"] = true;
    if (input.noNotify) params["no_notify"] = true;
    if (input.keep) params["keep"] = true;
    if (input.rm) params["rm"] = true;
    return params;
  };

  const asTerminal = (method: string, r: unknown): CoreTerminal => {
    if (!isRecord(r) || !isLocalCoreAddress(r["address"])) {
      throw new CoreRequestError(`herdr-core ${method}: result is not a local terminal record`, method, "unexpected-result", r);
    }
    return r as CoreTerminal;
  };

  const terminalRun = async (input: CoreRunInput, opts: CoreRequestOptions = {}) => {
    const params = runParams(input);
    const { result, core } = await exchange("terminal.run", params, { timeoutMs: opts.timeoutMs ?? CORE_RUN_TIMEOUT_MS });
    return { terminal: asTerminal("terminal.run", result), core };
  };

  const withTarget = (method: string, terminal: string): Record<string, unknown> => {
    assertLocalTarget(terminal, "terminal", method);
    const me = self(method);
    return anonymous ? { terminal } : { terminal, caller: me.terminalId };
  };

  const terminalGet = async (terminal: string, opts: CoreRequestOptions = {}) =>
    asTerminal("terminal.get", (await request("terminal.get", withTarget("terminal.get", terminal), opts)).result);
  const terminalKill = async (terminal: string, opts: CoreRequestOptions = {}) =>
    asTerminal("terminal.kill", (await request("terminal.kill", withTarget("terminal.kill", terminal), opts)).result);
  const terminalRm = async (terminal: string, opts: CoreRequestOptions = {}) => {
    await request("terminal.rm", withTarget("terminal.rm", terminal), opts);
  };
  const terminalLabel = async (terminal: string, labels: Readonly<Record<string, string>>, opts: CoreRequestOptions = {}) => {
    // terminal.label takes no caller (schema: labels + terminal only).
    assertLocalTarget(terminal, "terminal", "terminal.label");
    self("terminal.label");
    await request("terminal.label", { terminal, labels: { ...labels } }, opts);
  };

  return { env: () => coreEnv(clientEnv), hello, request, runParams, terminalRun, terminalGet, terminalKill, terminalRm, terminalLabel };
}
