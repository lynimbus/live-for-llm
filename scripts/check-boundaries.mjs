import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LAYER_ORDER = new Map([
  ["@live-for-llm/protocol", 0],
  ["@live-for-llm/ai", 0],
  ["@live-for-llm/memory", 1],
  ["@live-for-llm/harness", 1],
  ["@live-for-llm/browser", 1],
  ["@live-for-llm/companion", 2],
  ["@live-for-llm/daemon", 3],
  ["@live-for-llm/desktop", 4],
  ["@live-for-llm/mobile", 4],
]);

const NODE_BUILTIN_RE = /from\s+['"]node:|require\(['"]node:/;

const root = resolve(import.meta.dirname, "..");
const errors = [];

for (const group of ["packages", "apps"]) {
  const groupDir = join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(groupDir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const pkgLayer = LAYER_ORDER.get(pkg.name);
    if (pkgLayer === undefined) {
      errors.push(`Unregistered package layer for ${pkg.name} in ${pkgPath}`);
      continue;
    }

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.peerDependencies,
    };

    for (const depName of Object.keys(allDeps)) {
      if (!depName.startsWith("@live-for-llm/")) continue;
      const depLayer = LAYER_ORDER.get(depName);
      if (depLayer === undefined) {
        errors.push(`${pkg.name} depends on unregistered workspace package ${depName}`);
        continue;
      }
      if (pkgLayer === 0 && depLayer === 0 && depName !== pkg.name) {
        errors.push(`Layer 0 package ${pkg.name} cannot depend on sibling ${depName}`);
      }
      if (depLayer >= pkgLayer && depName !== pkg.name) {
        errors.push(`Layer violation: ${pkg.name} (L${pkgLayer}) depends on ${depName} (L${depLayer})`);
      }
      if (group === "apps" && depName !== "@live-for-llm/protocol") {
        errors.push(`App ${pkg.name} may only depend on @live-for-llm/protocol, found ${depName}`);
      }
    }

    if (pkg.name === "@live-for-llm/protocol") {
      const srcDir = join(groupDir, entry.name, "src");
      if (existsSync(srcDir)) {
        for (const file of readdirSync(srcDir, { recursive: true })) {
          if (typeof file !== "string" || !file.endsWith(".ts")) continue;
          const content = readFileSync(join(srcDir, file), "utf8");
          if (NODE_BUILTIN_RE.test(content)) {
            errors.push(`@live-for-llm/protocol must stay Node-free for nsh QuickJS: ${file}`);
          }
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Boundary check failed:");
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log("Boundary check passed.");
