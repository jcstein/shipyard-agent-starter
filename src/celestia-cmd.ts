import { loadConfig } from "./config.ts";
import { addressArgs, headArgs, runMochaHelper } from "./mocha.ts";

const command = process.argv[2];
const cfg = loadConfig();
const request =
  command === "address"
    ? { bin: cfg.celestiaHelper, args: addressArgs(cfg), timeoutMs: 30_000 }
    : command === "head"
      ? { bin: cfg.celestiaHelper, args: headArgs(cfg), timeoutMs: 120_000 }
      : null;

if (!request) {
  console.error("usage: celestia-cmd.ts address|head");
  process.exitCode = 2;
} else {
  runMochaHelper(request)
    .then((result) => {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.code !== 0) process.exitCode = result.code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
