/**
 * Full clean slate: clears MongoDB, Redis, MinIO, and Qdrant in one command.
 *
 * Run with `npm run clear:all`. Chains the four individual clear scripts so
 * the stores can't drift out of sync (video docs pointing at deleted files,
 * orphaned vectors, stale queue state). Runs immediately with no confirmation.
 *
 * Each step runs even if an earlier one fails — a full reset shouldn't be
 * abandoned halfway just because (say) Qdrant is unreachable — and a summary
 * of what succeeded/failed is printed at the end, exiting non-zero if any step
 * failed.
 *
 * Stop the API and workers before running (see clear-redis.ts).
 */
import { execSync } from "node:child_process";

const STEPS = [
  { name: "MongoDB", npmScript: "clear:db" },
  { name: "Redis", npmScript: "clear:redis" },
  { name: "MinIO", npmScript: "clear:minio" },
  { name: "Qdrant", npmScript: "clear:qdrant" },
] as const;

const results: Array<{ name: string; ok: boolean }> = [];

for (const step of STEPS) {
  console.log(`\n──────── Clearing ${step.name} ────────`);
  try {
    // Delegate to the already-wired npm scripts (single source of truth). Via a
    // shell so `npm`/`npm.cmd` resolves on every platform; stdio inherited so
    // each step's own log output streams through live.
    execSync(`npm run ${step.npmScript}`, { stdio: "inherit" });
    results.push({ name: step.name, ok: true });
  } catch {
    console.error(`✗ ${step.name} step failed (continuing with the rest).`);
    results.push({ name: step.name, ok: false });
  }
}

console.log("\n──────── Summary ────────");
for (const r of results) {
  console.log(`${r.ok ? "✅" : "✗ "} ${r.name}`);
}

const anyFailed = results.some((r) => !r.ok);
if (anyFailed) {
  console.error("\nOne or more stores failed to clear — see logs above.");
  process.exit(1);
}
console.log("\n✅ All stores cleared — clean slate.");
