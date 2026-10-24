import { loadConfig } from "./config.ts";
import { taskFromArgv } from "./jobs.ts";
import { createCheckout } from "./stripe.ts";

let task: string | null = null;
try {
  task = taskFromArgv(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

if (!process.exitCode) {
  const cfg = loadConfig();
  createCheckout(cfg, fetch, task ?? null)
    .then((session) => {
      console.log(`Checkout ${session.id}`);
      console.log(session.url);
      if (task) console.log(`Task: ${task}`);
      else console.log("No task argument. The Checkout page asks for one.");
      console.log("The webhook runs the task after checkout.session.completed. Dry-run uses mock inference and spends no TIA.");
      console.log("Test-mode cards do not count as revenue. GBP paid by an outside customer in live mode does.");
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
