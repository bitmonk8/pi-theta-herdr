import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Opt-in runner for the REAL-Herdr suite. Invoked only by `npm run test:herdr`;
// it needs a running daemon and this process must sit in a Herdr pane
// (HERDR_ENV=1 + HERDR_SOCKET_PATH + HERDR_PANE_ID + HERDR_WORKSPACE_ID). A
// missing precondition fails the suite loudly naming the variables.
export default defineConfig({
  root: repoRoot,
  test: {
    include: ["tests/herdr-live/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
