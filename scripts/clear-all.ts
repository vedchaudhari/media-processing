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
