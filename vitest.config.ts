import { configDefaults, defineConfig } from "vitest/config";

// Mirrors pi-theta's vitest.config.ts: the default `npm test` is offline and
// deterministic. The opt-in real-Herdr suite (`tests/herdr-live/**`) needs a
// running Herdr daemon and a pane environment, so it has its own runner
// (`npm run test:herdr` / `config/vitest/vitest.herdr.config.ts`) and is
// excluded here. When the pane environment is missing that suite fails loudly
// naming the variables — never a silent skip.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/herdr-live/**"],
    environment: "node",
    // The conformance suite imports pi-theta's TypeScript sources straight out
    // of node_modules (`@bitmonk8/pi-theta/src/...`); inline them so Vite
    // transforms them instead of handing a `.ts` file to Node (which refuses to
    // strip types under node_modules).
    server: { deps: { inline: [/[\\/]node_modules[\\/]@bitmonk8[\\/]pi-theta[\\/]/] } },
  },
});
