import { loadConfig } from "./config.ts";
import { formatPreflight, runPreflight } from "./preflight.ts";

runPreflight(loadConfig())
  .then((report) => {
    console.log(formatPreflight(report));
    if (!report.ok) process.exitCode = 1;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
