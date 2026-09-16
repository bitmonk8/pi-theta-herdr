// Pi extension entry point — auto-discovered from
// `package.json#pi.extensions = ["./extensions"]`. A THIN DELEGATING SHIM: no
// logic here; the factory lives in src/ so tests import it directly.
export { default } from "../src/extension.ts";
