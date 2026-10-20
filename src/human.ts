import { loadConfig } from "./config.ts";
import { appendReceipt } from "./receipts.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const who = arg("who");
const what = arg("what");
const why = arg("why");
if (!who || !what || !why) {
  console.error('Usage: npm run human -- --who "Ada" --what "paused the agent" --why "quote was above the cap"');
  process.exitCode = 1;
} else {
  const cfg = loadConfig();
  const record = appendReceipt(cfg.receiptsPath, { type: "human", who, what, why });
  console.log(JSON.stringify(record));
}
