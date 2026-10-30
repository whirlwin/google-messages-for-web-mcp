import { build } from "esbuild";
import { chmod, rm } from "node:fs/promises";

// One self-contained file, committed to git: a Claude Code plugin install is a
// plain copy of the repo with no npm install, so dist/ must carry its deps.
// The shebang comes from src/index.ts.
// Some dependencies are CommonJS and call require(); recreate it for ESM.
const banner = [
  'import { createRequire as __gmCreateRequire } from "node:module";',
  "const require = __gmCreateRequire(import.meta.url);",
].join("\n");

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: banner },
  logLevel: "warning",
});
await chmod("dist/index.js", 0o755);
