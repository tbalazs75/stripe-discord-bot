import { client } from "../client";
import { run as runDailyCheck } from "../tasks/daily-check";

async function main() {
  // ha a client modulod indításkor login-ol, ez elég:
  if (!client.isReady()) {
    await new Promise<void>((resolve) => client.once("ready", () => resolve()));
  }
  await runDailyCheck();
  // adj pár ms-t a logok kiküldésére
  setTimeout(() => process.exit(0), 1000);
}

main().catch((e) => {
  console.error("[run-daily-check] failed:", e);
  process.exit(1);
});
