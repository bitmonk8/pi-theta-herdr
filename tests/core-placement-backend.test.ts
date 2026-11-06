import { describe, expect, it } from "vitest";
import { CORE_CHILD_ENV, CORE_PLACEMENT_NAME, CORE_PLACEMENT_PRIORITY, createCorePlacementBackend } from "../src/core-placement-backend.ts";
import { HERDR_PLACEMENT_PRIORITY } from "../src/herdr-placement-backend.ts";
import { createCoreClient, type CoreClient } from "../src/core-client.ts";
import piThetaHerdr, { registerHerdrPlacement } from "../src/extension.ts";
import { PLACEMENT_DISCOVER_CHANNEL, PLACEMENT_REGISTRATION_API_VERSION } from "../src/protocol.ts";

const coreEnvVars = { HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/run/user/1000/herdr-core/default.sock" };
function fakeClient(env: Record<string, string> = coreEnvVars) {
  const real = createCoreClient({ env });
  const calls: { method: string; params: any }[] = [];
  const client: CoreClient = {
    ...real,
    terminalRun: async (input) => {
      calls.push({ method: "terminal.run", params: real.runParams(input) });
      return { terminal: { address: "t9" }, core: { id: "c", name: "n", version: "0.1.18", generation: 1, socketPath: "/s", session: null } };
    },
    terminalKill: async (t) => {
      calls.push({ method: "terminal.kill", params: { terminal: t } });
      throw new Error("already gone");
    },
  };
  return { client, calls };
}
const request = {
  execPath: "/home/u/.pi/agent/bin/pi",
  args: ["--theta-launch", "/tmp/launch.json", "--session", "/s/child.jsonl"],
  cwd: "/home/u/proj",
  env: { FREEPIK_API_KEY: "secret", PI_THETA_SUBAGENT_PARENT_PID: "123", HERDR_ENV: "1", PATH: "/bin" },
  label: "Research: deep/dive#ab12cd34",
  presentation: "visible" as any,
  launchFile: "/tmp/launch.json",
  context: { invokeDepth: 1, parallel: false },
};

describe("herdr-core theta placement", () => {
  it("is a distinct name, outranks herdr, never inherits env", () => {
    const b = createCorePlacementBackend({ client: fakeClient().client, launcher: "/x/pi-core", launcherRunnable: () => true });
    expect(b.name).toBe(CORE_PLACEMENT_NAME);
    expect(b.name).not.toBe("herdr");
    expect(CORE_PLACEMENT_PRIORITY).toBeGreaterThan(HERDR_PLACEMENT_PRIORITY);
    expect(b.capabilities).toEqual({ visible: true, inheritsEnv: false });
  });
  it("detects only verified Core identity plus a runnable launcher", () => {
    expect(createCorePlacementBackend({ client: fakeClient().client, launcher: "/x", launcherRunnable: () => true }).detect()).toBe(true);
    expect(createCorePlacementBackend({ client: fakeClient().client, launcher: "/x", launcherRunnable: () => false }).detect()).toBe(false);
    const herdrOnly = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/h", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };
    expect(createCorePlacementBackend({ client: fakeClient(herdrOnly).client, launcher: "/x", launcherRunnable: () => true }).detect()).toBe(false);
  });
  it("spawns through the launcher, sends no parent env, keeps tethering, explicit cwd/caller/parent", async () => {
    const { client, calls } = fakeClient();
    const b = createCorePlacementBackend({ client, launcher: "/x/pi-core", launcherRunnable: () => true });
    const placed = await b.place(request);
    expect(placed.handle).toBe("t9");
    expect(placed.capabilities).toEqual({ observesExit: false, inheritsEnv: false, visible: true });
    const p = calls[0]!.params;
    expect(p.argv).toEqual(["/x/pi-core", "--exec", request.execPath, ...request.args]);
    expect(p).toMatchObject({ cwd: "/home/u/proj", caller: "t4", parent: "t4", no_notify: true });
    expect(p.env).toEqual(CORE_CHILD_ENV);
    expect(JSON.stringify(p)).not.toContain("secret");
    expect(JSON.stringify(p)).not.toContain("PI_THETA_SUBAGENT_PARENT_PID");
    expect("outlive_parent" in p).toBe(false);
    expect(p.name).toMatch(/^[a-z0-9][a-z0-9._-]{0,31}$/);
    expect(p.labels).toEqual({ role: "theta-child", label: request.label });
  });
  it("kill is advisory and swallows errors", async () => {
    const { client, calls } = fakeClient();
    const placed = await createCorePlacementBackend({ client, launcher: "/x", launcherRunnable: () => true }).place(request);
    expect(() => placed.kill()).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.at(-1)).toEqual({ method: "terminal.kill", params: { terminal: "t9" } });
  });
  it("refuses outside Core and without the launcher, naming the child", async () => {
    await expect(createCorePlacementBackend({ client: fakeClient({}).client, launcher: "/x", launcherRunnable: () => true }).place(request)).rejects.toThrow(/Research.*not inside a herdr-core terminal/);
    await expect(createCorePlacementBackend({ client: fakeClient().client, launcher: "/x", launcherRunnable: () => false }).place(request)).rejects.toThrow(/launcher \/x is missing/);
  });
  it("registers next to herdr under its own name, from ONE subscription, once per session", () => {
    const handlers: ((d: unknown) => void)[] = [];
    const shutdown: (() => void)[] = [];
    const host = { events: { on: (_c: string, h: (d: unknown) => void) => (handlers.push(h), () => {}), emit: () => {} }, on: (_e: string, h: () => void) => shutdown.push(h) };
    piThetaHerdr(host as any);
    expect(handlers.length).toBe(1);
    expect(shutdown.length).toBe(1);
    const names: string[] = [];
    const payload = { apiVersion: PLACEMENT_REGISTRATION_API_VERSION, register: (b: { name: string }) => names.push(b.name) };
    handlers[0]!(payload);
    handlers[0]!(payload);
    expect(PLACEMENT_DISCOVER_CHANNEL).toBeTruthy();
    expect(names).toEqual(["herdr", "herdr-core"]);
    void registerHerdrPlacement;
  });
});
