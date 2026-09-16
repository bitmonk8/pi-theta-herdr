import type { SubagentPlacementBackend } from "@bitmonk8/pi-theta/src/runtime/subagent-placement";

/**
 * RFC 0012 §2: the flag naming a placed child's launch file — pi-theta's
 * `SUBAGENT_LAUNCH_FLAG` (`src/runtime/subagent-launcher.ts`), carried as the companion's
 * own literal (D1) and pinned equal by tests/conformance/child-role.test.ts. Its presence on
 * `process.argv` is the companion's child-role marker (D13); pi-theta reads it off argv the
 * same way (`readProductionChildControlPlane`).
 */
export const SUBAGENT_LAUNCH_FLAG = "theta-launch";

/** Copy of pi-theta's `findLaunchFlagOnArgv` (`src/runtime/subagent-launch-file.ts`): `--theta-launch <value>` or `--theta-launch=<value>`, first match wins, empty value ⇒ undefined. Pinned by Q2. */
export function findLaunchFlagOnArgv(argv: readonly string[]): string | undefined {
  const flag = `--${SUBAGENT_LAUNCH_FLAG}`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) {
      const next = argv[i + 1];
      return next !== undefined && next.length > 0 ? next : undefined;
    }
    if (arg !== undefined && arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

// RFC 0012 §5 registration protocol, carried as the companion's own literals
// (Decision D1). Pinned equal to pi-theta's PLACEMENT_DISCOVER_CHANNEL /
// PLACEMENT_OFFER_CHANNEL / PLACEMENT_REGISTRATION_API_VERSION
// (src/runtime/subagent-placement-registry.ts) by tests/conformance/protocol-literals.test.ts.
export const PLACEMENT_DISCOVER_CHANNEL = "pi-theta:subagent-placement:discover:v1";
export const PLACEMENT_OFFER_CHANNEL = "pi-theta:subagent-placement:offer:v1";
export const PLACEMENT_REGISTRATION_API_VERSION = 1;

/** The discover payload pi-theta emits (`PlacementDiscoverPayload` at the pin). */
export interface PlacementDiscoverPayload {
  readonly apiVersion: typeof PLACEMENT_REGISTRATION_API_VERSION;
  register(backend: SubagentPlacementBackend): void;
}

export function isPlacementDiscoverPayload(data: unknown): data is PlacementDiscoverPayload {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record["apiVersion"] === PLACEMENT_REGISTRATION_API_VERSION && typeof record["register"] === "function";
}
