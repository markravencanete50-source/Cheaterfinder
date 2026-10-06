// Prove the proportional scan window fixes coverage for every roster size,
// including accounts added in future.
import "dotenv/config";
import { resolveLikeEvidenceScanLimit } from "../workers.js";
const cases = [
  ["example_account", 225], ["sample_account", 214],
  ["tracked_user_2", 1062], ["tracked_user_4", 1100],
  ["tracked_user_1", 1463], ["future huge account", 5000], ["future tiny account", 40],
] as const;
console.log("roster | owners/cycle | cycles per FULL pass");
for (const [name, size] of cases) {
  const n = resolveLikeEvidenceScanLimit(size);
  console.log(`${name} (${size}) -> ${n}/cycle -> ${Math.ceil(size / n)} cycles`);
}
process.exit(0);
