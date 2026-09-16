// `host()` / `request()` builders copied from pi-theta's
// `tests/subagent-placement-seam.test.ts` (source:
// `C:/UnitySrc/pi-theta/tests/subagent-placement-seam.test.ts`, functions
// `host` and `request`) — pi-theta's `files` does not ship `tests/`, so the
// conformance suite carries its own copy rather than importing one that does
// not exist in the installed package. `fakeWire` and `fakeChildProcess` are
// this package's own additions, matching the shape pi-theta's suite uses for
// a non-`pipe` backend's wire (same file, `fakeChildProcess` /
// `openWire`-returning object literals).

import type {
  ExecutableHost,
  OpenedSubagentWire,
  SubagentChildProcess,
  SubagentLaunchRequest,
} from "@bitmonk8/pi-theta/src/runtime/subagent-launcher.ts";
import type { PlacedChild } from "@bitmonk8/pi-theta/src/runtime/subagent-placement.ts";

export function host(overrides?: Partial<ExecutableHost>): ExecutableHost {
  return {
    argv1: "/app/pi/dist/cli.js",
    execPath: "/usr/bin/node",
    fileExists: (): boolean => true,
    isGenericRuntime: (p: string): boolean => p.endsWith("node"),
    ...overrides,
  };
}

export function request(overrides?: Partial<SubagentLaunchRequest>): SubagentLaunchRequest {
  return {
    argv: {
      slug: "child",
      thetaDirs: ["/work/project/.pi/theta"],
      systemPrompt: "you are a subagent",
      hostTools: ["read"],
      noHostTools: false,
      provider: "anthropic",
      model: "claude-sonnet",
      projectTrust: false,
    },
    cwd: "/work/project",
    parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-xxx" },
    controlPlaneEnv: {},
    parentPid: 999,
    invokeDepth: 3,
    host: host(),
    ...overrides,
  };
}

/** A `SubagentChildProcess` a non-`pipe` backend's wire adapts a `PlacedChild` into. */
export function fakeChildProcess(): SubagentChildProcess {
  return {
    closeStdin: (): void => {},
    onStdoutLine: (): (() => void) => (): void => {},
    onStderrLine: (): (() => void) => (): void => {},
    onExit: (): void => {},
    kill: (): void => {},
  };
}

/** A `placeSubagentChild` wire that hands back a fixed launch file and adapts to a fixed child. */
export function fakeWire(launchFile: string): OpenedSubagentWire & { readonly abandonedCount: () => number } {
  let abandoned = 0;
  return {
    launchFile,
    adapt: (_placed: PlacedChild): SubagentChildProcess => fakeChildProcess(),
    abandon: (): void => {
      abandoned += 1;
    },
    abandonedCount: (): number => abandoned,
  };
}
