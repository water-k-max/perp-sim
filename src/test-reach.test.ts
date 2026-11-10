import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

/**
 *  A test file no script names does not exist.
 *
 *  Every `tsx --test` invocation in `package.json` lists its files by hand or by glob, so a suite
 *  can stop running the moment it is renamed, moved, or orphaned by a glob that no longer matches
 *  its directory — and the gate stays green while that happens. This checks the three links that
 *  can silently break: a file unreachable from any `test:*` script, a script whose pattern matches
 *  nothing on disk, and a `test:*` script the aggregate `ci` gate never calls.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scripts = Object.entries(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>);
const testScripts = scripts.filter(([name]) => name.startsWith("test:"));

const patterns = testScripts.flatMap(([name, command]) =>
  command
    .split(/\s+/)
    .map(token => token.replace(/^['"]|['"]$/g, ""))
    .filter(token => /\.test\.tsx?$/.test(token))
    .map(glob => ({ name, glob, re: new RegExp(`^${glob.split("/").map(seg => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("/")}$`) })),
);

const files: string[] = [];
(function walk(dir: string): void {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.test\.tsx?$/.test(entry)) files.push(relative(ROOT, path).split(sep).join("/"));
  }
})(join(ROOT, "src"));

test("the inventory itself is real: files found, scripts named, patterns derived", () => {
  assert.ok(files.length > 30, `only ${files.length} test files walked — the search is broken, not the gate`);
  assert.ok(testScripts.length >= 8, `only ${testScripts.length} test:* scripts in package.json`);
  assert.ok(patterns.length >= testScripts.length, "a test:* script names no .test file at all, so it runs nothing");
});

test("every test file on disk is reachable from a test:* script", () => {
  const unreachable = files.filter(file => !patterns.some(pattern => pattern.re.test(file)));
  assert.deepEqual(unreachable, [], `${unreachable.join(", ")} is never run by any script`);
});

test("every pattern a test:* script names still matches something on disk", () => {
  const dead = patterns.filter(pattern => !files.some(file => pattern.re.test(file))).map(pattern => `${pattern.name}: ${pattern.glob}`);
  assert.deepEqual(dead, [], `${dead.join(", ")} matches no file — the suite was renamed, moved or deleted around it`);
});

test("the aggregate gate calls every test suite, and the omissions are on the record", () => {
  // The mutation harness is deliberately outside the gate: it re-runs a whole test file per probe
  // and costs minutes. Naming it here keeps the omission a decision rather than a forgotten suite.
  const NOT_IN_GATE = new Set(["test:guards"]);
  // `gate`, never `ci`: pnpm owns `pnpm ci` as its own frozen-install command, so a script with
  // that name is unreachable by its obvious invocation — typing it wipes node_modules instead.
  const gate = scripts.find(([name]) => name === "gate");
  assert.ok(gate, "no `pnpm gate` script: nothing runs the suites together");
  const unfaced = testScripts.map(([name]) => name).filter(name => !NOT_IN_GATE.has(name) && !`${gate![1]} `.includes(`${name} `));
  assert.deepEqual(unfaced, [], `${unfaced.join(", ")} exists but the gate never calls it`);
});
