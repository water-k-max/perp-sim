import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 *  What a deployment serves as static files, assembled in one place.
 *
 *  Locally the page is put together by `src/bin/web.ts`: `public/` for the html, css and images, and
 *  `dist/web/app.js` for the bundle the browser does not write. A static host has no server to do
 *  that stitching, so the same set of files is staged into `dist/site/` and the bundle is given the
 *  path `index.html` already asks for.
 *
 *  The copy is checked, not trusted: a staged directory that is missing the bundle would serve a
 *  blank page with a 200, and that is the kind of failure a build should exit on.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = join(root, "public");
const bundle = join(root, "dist/web/app.js");
const out = join(root, "dist/site");

await mkdir(out, { recursive: true });
const names = (await readdir(source)).filter((name) => name !== "app.js");
let staged = 0;

for (const name of names) {
  await copyFile(join(source, name), join(out, name));
  staged += 1;
}
await copyFile(bundle, join(out, "app.js"));
staged += 1;

const problems: string[] = [];
for (const name of [...names, "app.js"]) {
  const from = name === "app.js" ? bundle : join(source, name);
  const [wanted, written] = await Promise.all([stat(from), stat(join(out, name))]);
  if (wanted.size !== written.size) problems.push(`${name}: staged ${written.size} bytes, source has ${wanted.size}`);
}

if (!names.includes("index.html")) problems.push("public/index.html is missing, so the staged site would serve nothing");

if (problems.length) {
  for (const problem of problems) console.error(`staging failed — ${problem}`);
  process.exit(1);
}
console.log(`dist/site: ${staged} files staged, each byte-size matched to its source`);
