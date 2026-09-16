import type { PlacedChild, SubagentPlacementBackend, SubagentPlacementRequest } from "@bitmonk8/pi-theta/src/runtime/subagent-placement";
import { createHerdrClient, HerdrRequestError, HERDR_REPORT_SOURCE, type HerdrClient } from "./herdr-client.ts";

export const HERDR_PLACEMENT_NAME = "herdr";
/**
 * `auto` ranks registered backends by `priority` (higher first, ties by name -
 * `subagent-placement-selection.ts` `orderForAuto`); `exec` and `pipe` are
 * positional fallbacks below every detected registered backend
 * (`selectPlacement`'s `auto` arm), so this number competes only with other
 * registered backends. Innermost-mux-wins: a Herdr pane inside a WezTerm window
 * carries both env sets, and the pane's own mux must win, so a future outer-mux
 * backend should choose a lower number.
 */
export const HERDR_PLACEMENT_PRIORITY = 50;

/** Every `place()` rejection: names the child (`label`) and wraps the client failure as `cause`. */
export class HerdrPlacementError extends Error {
  readonly label: string;
  constructor(label: string, detail: string, options?: ErrorOptions) {
    super(`cannot place '${label}' in a herdr tab: ${detail}`, options);
    this.label = label;
  }
}

export interface HerdrPlacementBackendDeps {
  /** Default `createHerdrClient()` (process env, process platform, node:net). */
  readonly client?: HerdrClient;
  /** Clock for the metadata report's `seq`; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * The pane process's environment overlay: `request.env` restricted to what
 * Herdr's `env` map can carry (string values), minus keys the Windows CRT
 * exposes as pseudo-variables (`=C:` drive cwds - a key containing `=`) and
 * minus `HERDR_*`, whose values must be the pane's own (Herdr injects them after
 * the caller's overlay: pi-config `docs/reference/herdr-mux-transport.md` §4
 * "caller env first, herdr's after").
 */
export function paneEnvOverlay(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (key.length === 0 || key.includes("=") || key.includes("\0")) continue;
    if (key.startsWith("HERDR_")) continue;
    out[key] = value;
  }
  return out;
}

export function createHerdrPlacementBackend(deps: HerdrPlacementBackendDeps = {}): SubagentPlacementBackend {
  const client = deps.client ?? createHerdrClient();
  const now = deps.now ?? Date.now;
  return {
    name: HERDR_PLACEMENT_NAME,
    priority: HERDR_PLACEMENT_PRIORITY,
    capabilities: { visible: true, inheritsEnv: true },
    detect: (): boolean => client.env() !== null,
    place: async (request: SubagentPlacementRequest): Promise<PlacedChild> => {
      const pane = client.env();
      if (pane === null) {
        throw new HerdrPlacementError(request.label, "not inside a herdr pane");
      }
      let paneId: string;
      try {
        paneId = await client.layoutApplyPane({
          workspaceId: pane.workspaceId,
          tabLabel: request.label,
          command: [request.execPath, ...request.args],
          cwd: request.cwd,
          env: paneEnvOverlay(request.env),
        });
      } catch (error: unknown) {
        // Seam boundary: the launcher renders only `error.message` (`spawnFailedDiagnostic`),
        // so a client failure is re-labelled with the child; anything that is not a
        // client failure is a defect and propagates unchanged.
        if (error instanceof HerdrRequestError) {
          throw new HerdrPlacementError(request.label, error.message, { cause: error });
        }
        throw error;
      }
      // D20: label the tab before the child boots (fire-and-forget, never delays place()).
      try {
        void client
          .paneReportMetadata(paneId, {
            source: HERDR_REPORT_SOURCE,
            seq: now() * 1000,
            displayAgent: request.label,
          })
          .catch(() => {});
      } catch {
        // The pane is live; a synchronous throw from the client must not fail the spawn (P7).
      }
      return {
        handle: paneId,
        capabilities: { observesExit: false, inheritsEnv: true, visible: true },
        // `observesExit: false`: the launcher never relies on this (P2); accepted as a no-op per the seam doc.
        onExit: (): void => {},
        // Advisory (PIC-65): fire-and-forget, errors swallowed - "pane not found" after a
        // self-closed pane is the expected happy case (pi-config `closePane`; pi-theta's
        // exec backend does the same `void runBounded(...).catch(() => {})`).
        kill: (): void => {
          void client.paneClose(paneId).catch(() => {});
        },
      };
    },
  };
}
