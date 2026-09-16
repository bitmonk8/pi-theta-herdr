import { randomUUID } from "node:crypto";
import * as net from "node:net";

/** The pane identity Herdr injects into every pane it spawns. */
export interface HerdrPaneEnv {
  readonly socketPath: string;
  readonly paneId: string;
  readonly workspaceId: string;
}

/** pi-config's default deadline (`opts.timeoutMs ?? 5000`). */
export const HERDR_REQUEST_TIMEOUT_MS = 5000;

/**
 * The companion's Herdr reporting identity. `source` names this package — a custom source,
 * which Herdr applies to any pane (its own `herdr:pi` source is honoured only on panes whose
 * root process Herdr detects as pi; a theta child's root is `node …/cli.js`). `agent` belongs
 * only in `pane.report_agent` / `pane.report_agent_session`; observed on Herdr 0.8.0 (protocol
 * 20): a `pane.report_metadata` WITHOUT `agent` is applied, the same report WITH `agent: "pi"`
 * is acknowledged and NOT applied on panes whose root Herdr does not recognise as pi.
 */
export const HERDR_REPORT_SOURCE = "pi-theta-herdr";
export const HERDR_REPORT_AGENT = "pi";

/** `pane.report_agent`'s `state` (Herdr `PaneAgentState`). `done` is absent on purpose: Herdr derives it from `working → idle` and does not accept it as input. */
export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";
/** pi-config's `layout.apply` override (`{ timeoutMs: 15_000 }` in `runInHerdr`). */
export const LAYOUT_APPLY_TIMEOUT_MS = 15_000;

/** Herdr pane identity. All of it or none. Body identical to pi-config's `herdrEnv`; `env` defaults to `process.env`. */
export function herdrEnv(env: NodeJS.ProcessEnv = process.env): HerdrPaneEnv | null {
  const { HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID, HERDR_WORKSPACE_ID } = env;
  if (HERDR_ENV !== "1" || !HERDR_SOCKET_PATH || !HERDR_PANE_ID || !HERDR_WORKSPACE_ID) return null;
  return { socketPath: HERDR_SOCKET_PATH, paneId: HERDR_PANE_ID, workspaceId: HERDR_WORKSPACE_ID };
}

/** Herdr's control socket: a named pipe on Windows, the raw path elsewhere. Body identical to pi-config's; `platform` defaults to `process.platform`. */
export function herdrEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

export type HerdrRequestFailureKind =
  | "not-in-pane"
  | "unreachable"
  | "timeout"
  | "closed"
  | "unparseable"
  | "refused"
  | "unexpected-result";

/**
 * The rejection shape of every client call. `message` is byte-identical to the
 * `Error` pi-config threw for the same condition (pi-config callers read
 * `.message` only). `name` is deliberately NOT overridden (stays "Error") so
 * `String(err)` and stack headers are unchanged too.
 */
export class HerdrRequestError extends Error {
  readonly method: string;
  readonly kind: HerdrRequestFailureKind;
  /** Herdr's error body (`{ code, message }`) for `refused`; the raw `result` for `unexpected-result`. */
  readonly detail: unknown;
  constructor(message: string, method: string, kind: HerdrRequestFailureKind, detail?: unknown) {
    super(message);
    this.method = method;
    this.kind = kind;
    this.detail = detail;
  }
}

export interface HerdrRequestOptions {
  /** Response deadline in ms; default `HERDR_REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** Injection points; every default reproduces pi-config's ambient reads. */
export interface HerdrClientDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly connect?: (endpoint: string) => net.Socket;
}

export interface LayoutApplyPaneInput {
  readonly workspaceId: string;
  readonly tabLabel: string;
  readonly command: readonly string[];
  readonly cwd: string;
  /** Caller env overlay for the pane process, string values only. Absent => no `env` key is sent. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface PaneMetadata {
  readonly source: string;
  readonly seq?: number;
  readonly displayAgent?: string;
  readonly title?: string;
}

export interface PaneAgentReport {
  readonly source: string;
  readonly agent: string;
  readonly state: HerdrAgentState;
  readonly seq?: number;
  readonly message?: string;
  readonly agentSessionId?: string;
  readonly agentSessionPath?: string;
}

export interface PaneAgentSessionReport {
  readonly source: string;
  readonly agent: string;
  readonly seq?: number;
  readonly sessionStartSource?: string;
  readonly agentSessionId?: string;
  readonly agentSessionPath?: string;
}

export interface HerdrClient {
  env(): HerdrPaneEnv | null;
  /** One NDJSON request/response over a fresh connection. Resolves with `resp.result` (possibly undefined). */
  request(method: string, params: Record<string, unknown>, opts?: HerdrRequestOptions): Promise<unknown>;
  /** `layout.apply` with a single-pane root; resolves with the created pane id. Default deadline 15 000 ms. */
  layoutApplyPane(input: LayoutApplyPaneInput, opts?: HerdrRequestOptions): Promise<string>;
  /** `pane.close { pane_id }`; result discarded. */
  paneClose(paneId: string, opts?: HerdrRequestOptions): Promise<void>;
  /** `pane.rename { pane_id, label }`; result discarded. */
  paneRename(paneId: string, label: string, opts?: HerdrRequestOptions): Promise<void>;
  /** `pane.report_metadata { pane_id, source, seq?, display_agent?, title? }`; result discarded. */
  paneReportMetadata(paneId: string, metadata: PaneMetadata, opts?: HerdrRequestOptions): Promise<void>;
  /** `pane.report_agent { pane_id, source, agent, seq?, state, message?, agent_session_id?, agent_session_path? }`; result discarded. */
  paneReportAgent(paneId: string, report: PaneAgentReport, opts?: HerdrRequestOptions): Promise<void>;
  /** `pane.report_agent_session { pane_id, source, agent, seq?, session_start_source?, agent_session_id?, agent_session_path? }`; result discarded. */
  paneReportAgentSession(paneId: string, report: PaneAgentSessionReport, opts?: HerdrRequestOptions): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function createHerdrClient(deps: HerdrClientDeps = {}): HerdrClient {
  const clientEnv = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const connect = deps.connect ?? ((endpoint: string): net.Socket => net.connect({ path: endpoint }));

  const request = (method: string, params: Record<string, unknown>, opts: HerdrRequestOptions = {}): Promise<unknown> => {
    const pane = herdrEnv(clientEnv);
    if (!pane) return Promise.reject(new HerdrRequestError("not inside a herdr pane", method, "not-in-pane"));
    const timeoutMs = opts.timeoutMs ?? HERDR_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = connect(herdrEndpoint(pane.socketPath, platform));
      let buffer = "";
      let done = false;
      const finish = (err: Error | null, result?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(result);
      };
      const timer = setTimeout(
        () => finish(new HerdrRequestError(`herdr ${method} timed out after ${timeoutMs}ms`, method, "timeout")),
        timeoutMs,
      );
      timer.unref?.();
      socket.on("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        let resp: unknown;
        try {
          resp = JSON.parse(buffer.slice(0, nl));
        } catch (err) { // SyntaxError from JSON.parse - the only throw site in the try
          finish(new HerdrRequestError(`herdr ${method}: unparseable response: ${(err as Error).message}`, method, "unparseable"));
          return;
        }
        if (typeof resp !== "object" || resp === null) {
          finish(new HerdrRequestError(`herdr ${method}: unparseable response: not a JSON object`, method, "unparseable", resp));
          return;
        }
        const record = resp as Record<string, unknown>;
        if (record["error"]) finish(new HerdrRequestError(`herdr ${method}: ${JSON.stringify(record["error"])}`, method, "refused", record["error"]));
        else finish(null, record["result"]);
      });
      socket.on("error", (err) => finish(new HerdrRequestError(`herdr unreachable: ${err.message}`, method, "unreachable")));
      socket.on("end", () => finish(new HerdrRequestError(`herdr ${method}: connection closed before response`, method, "closed")));
    });
  };

  const layoutApplyPane = async (input: LayoutApplyPaneInput, opts: HerdrRequestOptions = {}): Promise<string> => {
    const params: Record<string, unknown> = {
      workspace_id: input.workspaceId,
      tab_label: input.tabLabel,
      focus: false,
      root: {
        type: "pane",
        command: [...input.command],
        cwd: input.cwd,
        ...(input.env !== undefined ? { env: { ...input.env } } : {}),
      },
    };
    const result = await request("layout.apply", params, { timeoutMs: opts.timeoutMs ?? LAYOUT_APPLY_TIMEOUT_MS });
    const layout = isRecord(result) && isRecord(result["layout"]) ? result["layout"] : undefined;
    const paneId =
      firstPaneId(layout?.["root"]) ??
      (typeof layout?.["focused_pane_id"] === "string" ? (layout["focused_pane_id"] as string) : null);
    if (paneId === null) {
      throw new HerdrRequestError("herdr layout.apply reported no pane id", "layout.apply", "unexpected-result", result);
    }
    return paneId;
  };

  const paneClose = async (paneId: string, opts?: HerdrRequestOptions): Promise<void> => {
    await request("pane.close", { pane_id: paneId }, opts);
  };

  const paneRename = async (paneId: string, label: string, opts?: HerdrRequestOptions): Promise<void> => {
    await request("pane.rename", { pane_id: paneId, label }, opts);
  };

  const paneReportMetadata = async (paneId: string, metadata: PaneMetadata, opts?: HerdrRequestOptions): Promise<void> => {
    await request(
      "pane.report_metadata",
      {
        pane_id: paneId,
        source: metadata.source,
        ...(metadata.seq !== undefined ? { seq: metadata.seq } : {}),
        ...(metadata.displayAgent !== undefined ? { display_agent: metadata.displayAgent } : {}),
        ...(metadata.title !== undefined ? { title: metadata.title } : {}),
      },
      opts,
    );
  };

  const paneReportAgent = async (paneId: string, report: PaneAgentReport, opts?: HerdrRequestOptions): Promise<void> => {
    await request(
      "pane.report_agent",
      {
        pane_id: paneId,
        source: report.source,
        agent: report.agent,
        ...(report.seq !== undefined ? { seq: report.seq } : {}),
        state: report.state,
        ...(report.message !== undefined ? { message: report.message } : {}),
        ...(report.agentSessionId !== undefined ? { agent_session_id: report.agentSessionId } : {}),
        ...(report.agentSessionPath !== undefined ? { agent_session_path: report.agentSessionPath } : {}),
      },
      opts,
    );
  };

  const paneReportAgentSession = async (paneId: string, report: PaneAgentSessionReport, opts?: HerdrRequestOptions): Promise<void> => {
    await request(
      "pane.report_agent_session",
      {
        pane_id: paneId,
        source: report.source,
        agent: report.agent,
        ...(report.seq !== undefined ? { seq: report.seq } : {}),
        ...(report.sessionStartSource !== undefined ? { session_start_source: report.sessionStartSource } : {}),
        ...(report.agentSessionId !== undefined ? { agent_session_id: report.agentSessionId } : {}),
        ...(report.agentSessionPath !== undefined ? { agent_session_path: report.agentSessionPath } : {}),
      },
      opts,
    );
  };

  return { env: () => herdrEnv(clientEnv), request, layoutApplyPane, paneClose, paneRename, paneReportMetadata, paneReportAgent, paneReportAgentSession };
}

/** = createHerdrClient().request(method, params, opts). Return type tightened from `any` to `unknown` (type-level only). */
export function herdrRequest(method: string, params: Record<string, unknown>, opts: HerdrRequestOptions = {}): Promise<unknown> {
  return createHerdrClient().request(method, params, opts);
}

/** The first pane of a `layout.apply` layout tree. Body identical to pi-config's `firstPaneId`; parameter typed `unknown`. */
export function firstPaneId(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  if (record["type"] === "pane") return typeof record["pane_id"] === "string" ? record["pane_id"] : null;
  return firstPaneId(record["first"]) ?? firstPaneId(record["second"]);
}

// ---- convenience wrappers over the default client (additive) ----
export function layoutApplyPane(input: LayoutApplyPaneInput, opts?: HerdrRequestOptions): Promise<string> {
  return createHerdrClient().layoutApplyPane(input, opts);
}
export function paneClose(paneId: string, opts?: HerdrRequestOptions): Promise<void> {
  return createHerdrClient().paneClose(paneId, opts);
}
export function paneRename(paneId: string, label: string, opts?: HerdrRequestOptions): Promise<void> {
  return createHerdrClient().paneRename(paneId, label, opts);
}
export function paneReportMetadata(paneId: string, metadata: PaneMetadata, opts?: HerdrRequestOptions): Promise<void> {
  return createHerdrClient().paneReportMetadata(paneId, metadata, opts);
}
export function paneReportAgent(paneId: string, report: PaneAgentReport, opts?: HerdrRequestOptions): Promise<void> {
  return createHerdrClient().paneReportAgent(paneId, report, opts);
}
export function paneReportAgentSession(paneId: string, report: PaneAgentSessionReport, opts?: HerdrRequestOptions): Promise<void> {
  return createHerdrClient().paneReportAgentSession(paneId, report, opts);
}
