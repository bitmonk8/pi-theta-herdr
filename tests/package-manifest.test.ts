// RFC 0012 Phase 2 seam sheet §5.I — dependency discipline + manifest pins.
// This file owns no manifest content itself; it reads whatever the
// scaffolding builder wrote and reds loudly (never a silent pass) when a
// required file is missing or a required shape is absent.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("§5.I package.json dependency discipline and manifest pins", () => {
  it("I1 name / type / keywords / pi.extensions / files / dependency discipline / scripts / license", () => {
    const pkg = readJson(join(ROOT, "package.json"));
    expect(pkg["name"]).toBe("@bitmonk8/pi-theta-herdr");
    expect(pkg["type"]).toBe("module");
    expect(pkg["keywords"]).toEqual(expect.arrayContaining(["pi-package"]));
    expect(pkg["pi"]).toEqual({ extensions: ["./extensions"] });
    expect(pkg["files"]).toEqual(
      expect.arrayContaining(["extensions", "src", "LICENSE-APACHE", "LICENSE-MIT", "README.md", "CHANGELOG.md"]),
    );
    expect(pkg["dependencies"]).toBeUndefined();
    expect(pkg["peerDependencies"]).toBeUndefined();
    const devDeps = pkg["devDependencies"] as Record<string, string> | undefined;
    expect(devDeps?.["@bitmonk8/pi-theta"]).toBe("github:bitmonk8/pi-theta");
    const scripts = pkg["scripts"] as Record<string, string> | undefined;
    expect(scripts?.["test"]).toBe("vitest run");
    expect(scripts?.["test:herdr"]).toContain("config/vitest/vitest.herdr.config.ts");
    expect(pkg["license"]).toBe("MIT OR Apache-2.0");
  });

  it("I2 every import/export specifier under src/** and extensions/** is node:*, a relative .ts path, or a whole-statement `import type` of the two allowed bare specifiers", () => {
    const files = [...walkTsFiles(join(ROOT, "src")), ...walkTsFiles(join(ROOT, "extensions"))];
    // No silent skip: an empty audit set is itself a loud failure, never a
    // vacuous pass — the scaffolding/source has not landed yet.
    expect(files.length, "no src/**/*.ts or extensions/**/*.ts files found to audit").toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const match = /\bfrom\s+["']([^"']+)["']/.exec(line);
        if (match === undefined || match === null) continue;
        const specifier = match[1]!;
        const isNodeBuiltin = specifier.startsWith("node:");
        const isRelativeTs = (specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".ts");
        const isTypeOnlyBareAllowed =
          /^\s*import\s+type\b/.test(line) &&
          (specifier.startsWith("@bitmonk8/pi-theta/src/") || specifier === "@earendil-works/pi-coding-agent");
        if (!isNodeBuiltin && !isRelativeTs && !isTypeOnlyBareAllowed) {
          violations.push(`${relative(ROOT, file)}:${i + 1}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("I3 src/** has no module-level mutable state: no require(), no top-level let/var, no top-level new Map/Set", () => {
    const files = walkTsFiles(join(ROOT, "src"));
    expect(files.length, "no src/**/*.ts files found to audit").toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/\brequire\s*\(/.test(line)) violations.push(`${relative(ROOT, file)}:${i + 1}: require(`);
        if (/^(export\s+)?(let|var)\s+\w/.test(line)) violations.push(`${relative(ROOT, file)}:${i + 1}: top-level let/var`);
        if (/^(export\s+)?const\s+\w+\s*=\s*new\s+(Map|Set)\s*\(/.test(line)) {
          violations.push(`${relative(ROOT, file)}:${i + 1}: top-level new Map/Set`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("I4 extensions/index.ts is comments plus exactly the delegating export", () => {
    const path = join(ROOT, "extensions", "index.ts");
    const code = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line.trim()))
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    expect(code).toBe('export { default } from "../src/extension.ts";');
  });

  it("I5 LICENSE-APACHE / LICENSE-MIT are byte-identical to pi-theta's own", () => {
    const piThetaLicenseDir = join(ROOT, "node_modules", "@bitmonk8", "pi-theta");
    const companionApache = readFileSync(join(ROOT, "LICENSE-APACHE"));
    const companionMit = readFileSync(join(ROOT, "LICENSE-MIT"));
    const piThetaApache = readFileSync(join(piThetaLicenseDir, "LICENSE-APACHE"));
    const piThetaMit = readFileSync(join(piThetaLicenseDir, "LICENSE-MIT"));
    expect(companionApache.equals(piThetaApache)).toBe(true);
    expect(companionMit.equals(piThetaMit)).toBe(true);
  });

  it("I6 vitest.config.ts excludes the live suite; the herdr config includes only it", async () => {
    const mainConfig = (await import(join(ROOT, "vitest.config.ts").replace(/\\/g, "/"))) as {
      default: { test: { exclude?: readonly string[] } };
    };
    expect(mainConfig.default.test.exclude ?? []).toEqual(expect.arrayContaining(["tests/herdr-live/**"]));

    const herdrConfig = (await import(join(ROOT, "config", "vitest", "vitest.herdr.config.ts").replace(/\\/g, "/"))) as {
      default: { test: { include?: readonly string[] } };
    };
    expect(herdrConfig.default.test.include).toEqual(["tests/herdr-live/**/*.test.ts"]);
  });

  it("R1 version is 0.2.0, and CHANGELOG.md lists [0.2.0] above [0.1.0]", () => {
    const pkg = readJson(join(ROOT, "package.json"));
    expect(pkg["version"]).toBe("0.2.0");
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const idx020 = changelog.indexOf("## [0.2.0]");
    const idx010 = changelog.indexOf("## [0.1.0]");
    expect(idx020, "CHANGELOG.md has no '## [0.2.0]' heading").toBeGreaterThanOrEqual(0);
    expect(idx010, "CHANGELOG.md has no '## [0.1.0]' heading").toBeGreaterThanOrEqual(0);
    expect(idx020).toBeLessThan(idx010);
  });

  it("R2 src/herdr-child-reporter.ts exists and is subject to the I2/I3 audits (no bare import, no module-level mutable state)", () => {
    const path = join(ROOT, "src", "herdr-child-reporter.ts");
    const files = walkTsFiles(join(ROOT, "src"));
    expect(files).toContain(path);
    const lines = readFileSync(path, "utf8").split("\n");
    const violations: string[] = [];
    lines.forEach((line, i) => {
      const match = /\bfrom\s+["']([^"']+)["']/.exec(line);
      if (match) {
        const specifier = match[1]!;
        const isNodeBuiltin = specifier.startsWith("node:");
        const isRelativeTs = (specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".ts");
        const isTypeOnlyBareAllowed =
          /^\s*import\s+type\b/.test(line) &&
          (specifier.startsWith("@bitmonk8/pi-theta/src/") || specifier === "@earendil-works/pi-coding-agent");
        if (!isNodeBuiltin && !isRelativeTs && !isTypeOnlyBareAllowed) violations.push(`${i + 1}: ${specifier}`);
      }
      if (/\brequire\s*\(/.test(line)) violations.push(`${i + 1}: require(`);
      if (/^(export\s+)?(let|var)\s+\w/.test(line)) violations.push(`${i + 1}: top-level let/var`);
      if (/^(export\s+)?const\s+\w+\s*=\s*new\s+(Map|Set)\s*\(/.test(line)) violations.push(`${i + 1}: top-level new Map/Set`);
    });
    expect(violations).toEqual([]);
  });

  it("R3 tests/herdr-live/** is still excluded from the default vitest config (I6 unchanged)", async () => {
    const mainConfig = (await import(join(ROOT, "vitest.config.ts").replace(/\\/g, "/"))) as {
      default: { test: { exclude?: readonly string[] } };
    };
    expect(mainConfig.default.test.exclude ?? []).toEqual(expect.arrayContaining(["tests/herdr-live/**"]));
  });

  it("no silent skipping anywhere under tests/**", () => {
    const testsDir = join(ROOT, "tests");
    const files = walkTsFiles(testsDir);
    expect(files.length, "no tests/**/*.ts files found to audit").toBeGreaterThan(0);
    // Build the needle patterns via concatenation so this audit file's own
    // source lines do not self-match when scanned.
    const dotSkipParen = new RegExp("\\" + "." + "skip" + "\\(");
    const dotTodoParen = new RegExp("\\" + "." + "todo" + "\\(");
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (dotSkipParen.test(line)) violations.push(`${relative(ROOT, file)}:${i + 1}: skip marker`);
        // No carve-out anywhere under tests/**: the two rows that once pinned
        // with a todo marker (J5, J6, tests/herdr-live/**) are now real tests.
        if (dotTodoParen.test(line)) violations.push(`${relative(ROOT, file)}:${i + 1}: todo marker`);
      });
    }
    expect(violations).toEqual([]);
  });
});
