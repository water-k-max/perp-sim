import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { requireSafe } from "./input.js";

export const json = (value: unknown): string => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
export class Journal {
  private held = false;
  private pending = false;
  constructor(readonly directory: string) {}
  private syncDir() { const fd = openSync(this.directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private save(name: string, value: unknown) {
    const path = join(this.directory, name);
    const fd = openSync(`${path}.new`, "w", 0o600);
    try { writeFileSync(fd, json(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(`${path}.new`, path); this.syncDir();
  }
  acquire() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    requireSafe(!existsSync(join(this.directory, "pending.json")), "Unresolved journal: resolve recorded hash/nonce before any fresh send");
    try { mkdirSync(join(this.directory, "lock"), { mode: 0o700 }); } catch { throw new Error("Trade lock exists"); }
    this.held = true;
    try {
      requireSafe(!existsSync(join(this.directory, "pending.json")), "Unresolved journal");
      this.syncDir();
    } catch (error) { this.release(); throw error; }
  }
  prepare(value: unknown) {
    requireSafe(this.held, "Journal not locked");
    this.pending = true;
    this.save("pending.json", value);
  }
  review(hash: string, evidence: unknown) {
    requireSafe(this.held && this.pending, "No pending journal");
    this.prepare({ status: "review-required", hash, evidence });
    this.save(`${hash}.json`, evidence);
  }
  complete(hash: string, evidence: unknown) {
    requireSafe(this.held && this.pending, "No pending journal");
    this.save(`${hash}.json`, evidence);
    unlinkSync(join(this.directory, "pending.json")); this.syncDir();
    this.pending = false;
  }
  release() {
    if (this.held && !this.pending) {
      rmdirSync(join(this.directory, "lock")); this.syncDir(); this.held = false;
    }
  }
}
