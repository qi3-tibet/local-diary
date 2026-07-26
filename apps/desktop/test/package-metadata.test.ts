import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

it("ships compiled contracts instead of TypeScript source in the desktop runtime", () => {
  const packageJson = JSON.parse(readFileSync(path.join(workspaceRoot, "packages/contracts/package.json"), "utf8"));

  expect(packageJson.exports["."].default).toBe("./dist/index.js");
  expect(packageJson.scripts.build).toBe("tsc -p tsconfig.build.json");
});
