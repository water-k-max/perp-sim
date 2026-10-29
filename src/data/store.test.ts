import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

test("v3 immutable snapshots, atomic concurrent refresh, validation and no-slash root", async () => {
  const root = await mkdtemp(join(tmpdir(), "perp-store-"));
  process.env.PERP_SIM_CACHE = root;
  const store = await import("./store.js");
  try {
    const key = store.datasetKey({ request: 1 });
    const oldPath = join(root, key.slice(0, 2), `${key}.json.gz`);
    await mkdir(join(root, key.slice(0, 2)));
    await writeFile(oldPath, "legacy bytes");
    assert.equal(await store.readDataset(key), null);
    const old = { id: "same", amount: 1n };
    const digest = await store.writeSnapshot(old);
    await store.writeDataset(key, old);
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.writeDataset(key, { id: "same", amount: BigInt(i) })));
    assert.deepEqual(await store.readSnapshot(digest), old);
    assert.equal(typeof (await store.readDataset<{ amount: bigint }>(key))!.amount, "bigint");
    assert.equal(await readFile(oldPath, "utf8"), "legacy bytes");
    assert.equal(new Set(await Promise.all(Array.from({ length: 20 }, () => store.writeSnapshot(old)))).size, 1);
    await assert.rejects(store.readSnapshot("../bad"), /Invalid cache digest/);
    await assert.rejects(store.readSnapshot("0".repeat(64)), store.SnapshotMissingError);
    const target = join(root, "v3", "snapshots", digest.slice(0, 2), `${digest}.json.gz`);
    await writeFile(target, gzipSync(JSON.stringify({ version: 3, digest, payload: { id: "same", amount: 900 } })));
    await assert.rejects(store.readSnapshot(digest), store.CacheCorruptionError);
    await writeFile(target, "broken gzip");
    await assert.rejects(store.readSnapshot(digest), store.CacheCorruptionError);
    const index = join(root, "v3", "requests", key.slice(0, 2), `${key}.json.gz`);
    await writeFile(index, gzipSync(JSON.stringify({ version: 3, key: "wrong", digest })));
    await assert.rejects(store.readDataset(key), store.CacheCorruptionError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
