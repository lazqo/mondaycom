/**
 * Runs scripts/hermes-check.ts outside Next.js. The CRM's server modules start with
 * `import "server-only"`, a guard Next resolves itself; here it is pointed at a no-op stub
 * (scripts/server-only-stub.ts, shipped in the image), and nothing else changes.
 */
import Module from "node:module";
import path from "node:path";

const stub = path.resolve(__dirname, "server-only-stub.ts");
const m = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const original = m._resolveFilename;
m._resolveFilename = function (request: string, ...rest: unknown[]) {
  return original.call(this, request === "server-only" ? stub : request, ...rest);
};

import("./hermes-check").catch((err) => {
  console.error(err);
  process.exit(1);
});
