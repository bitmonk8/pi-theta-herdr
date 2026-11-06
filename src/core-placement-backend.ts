import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlacedChild, SubagentPlacementBackend, SubagentPlacementRequest } from "@bitmonk8/pi-theta/src/runtime/subagent-placement";
import { coreName, CoreRequestError, createCoreClient, type CoreClient } from "./core-client.ts";

/**
 * pi-theta placement backend for Herdr Core (`herdr-core`) — a SEPARATE backend name from the
 * legacy `herdr` one, never an ambiguous double registration.
 *
 * Design (migration plan §3/§4, decided in Phase 1 step 5):
 *  - detect(): verified Core identity (HC_TERMINAL_ID + absolute HC_TERMINAL_SOCKET) AND a
 *    runnable child launcher. Never a binary on PATH.
 *  - priority 60 > herdr's 50: inside a Core terminal any inherited HERDR_* set is a leftover of
 *    whoever started the core and must never win (it would place children on the LEGACY server).
 *  - inheritsEnv: false — Core spawns from its own environment, and Core persists a run's env
 *    overlay in its records, so the parent's environment is NOT passed. pi-theta then carries the
 *    whole control plane (parent PID, depth, params, hashes, entry) on the parent-private launch
 *    file, and its credential guard (D6) sends env-sourced provider credentials to `pipe` instead.
 *    The API keys pi-config's extensions need come from the launcher (`pi-core --exec`), which
 *    reads them from the user's 0600 files (migration plan Amendment 5).
 *  - Lifecycle: Core's default (children end with their parent) — theta's intentional tethering
 *    is kept; theta's own parent-PID watchdog stays the authority. no_notify: theta's result
 *    channel is the outcome path.
 *  - Local only, explicit cwd/caller/parent: enforced by core-client.
 *  - Finished terminals are retained (failed ones stay inspectable; `hc ls` hides finished ones by
 *    default). kill() is advisory and error-swallowed, like the herdr backend's pane.close.
 */

export const CORE_PLACEMENT_NAME = "herdr-core";
export const CORE_PLACEMENT_PRIORITY = 60;
/** Non-secret overlay (Core persists overlays): neutralise inherited legacy markers. */
export const CORE_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({ HERDR_ENV: "0" });

export class CorePlacementError extends Error {
  readonly label: string;
  constructor(label: string, detail: string, options?: ErrorOptions) {
    super(`cannot place '${label}' in a herdr-core terminal: ${detail}`, options);
    this.label = label;
  }
}

export interface CorePlacementBackendDeps {
  readonly client?: CoreClient;
  /** Child launcher; default `$PI_SUBAGENT_CORE_LAUNCHER` or `~/.local/bin/pi-core`. */
  readonly launcher?: string;
  /** Executable check for the launcher; default fs.accessSync X_OK. */
  readonly launcherRunnable?: (p: string) => boolean;
}

export function defaultCoreLauncher(env: NodeJS.ProcessEnv = process.env): string {
  return env["PI_SUBAGENT_CORE_LAUNCHER"] || path.join(os.homedir(), ".local", "bin", "pi-core");
}

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function createCorePlacementBackend(deps: CorePlacementBackendDeps = {}): SubagentPlacementBackend {
  const client = deps.client ?? createCoreClient();
  const launcher = deps.launcher ?? defaultCoreLauncher();
  const runnable = deps.launcherRunnable ?? executable;
  return {
    name: CORE_PLACEMENT_NAME,
    priority: CORE_PLACEMENT_PRIORITY,
    capabilities: { visible: true, inheritsEnv: false },
    detect: (): boolean => client.env() !== null && runnable(launcher),
    place: async (request: SubagentPlacementRequest): Promise<PlacedChild> => {
      if (client.env() === null) throw new CorePlacementError(request.label, "not inside a herdr-core terminal");
      if (!runnable(launcher)) throw new CorePlacementError(request.label, `child launcher ${launcher} is missing or not executable`);
      let address: string;
      try {
        const { terminal } = await client.terminalRun({
          argv: [launcher, "--exec", request.execPath, ...request.args],
          cwd: request.cwd,
          name: coreName(request.label),
          labels: { role: "theta-child", label: request.label },
          env: CORE_CHILD_ENV,
          noNotify: true,
        });
        address = terminal.address;
      } catch (error: unknown) {
        if (error instanceof CoreRequestError || (error as { kind?: unknown })?.kind !== undefined) {
          throw new CorePlacementError(request.label, (error as Error).message, { cause: error });
        }
        throw error;
      }
      return {
        handle: address,
        capabilities: { observesExit: false, inheritsEnv: false, visible: true },
        onExit: (): void => {},
        kill: (): void => {
          void client.terminalKill(address).catch(() => {});
        },
      };
    },
  };
}
