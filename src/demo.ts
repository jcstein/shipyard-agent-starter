import { loadConfig } from "./config.ts";
import { runDemo } from "./run.ts";

runDemo(loadConfig()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
