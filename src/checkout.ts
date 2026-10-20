import { loadConfig } from "./config.ts";
import { createCheckout } from "./stripe.ts";

const cfg = loadConfig();
createCheckout(cfg)
  .then((session) => {
    console.log(`Checkout ${session.id}`);
    console.log(session.url);
    console.log("Test-mode cards do not count as revenue. GBP paid by an outside customer in live mode does.");
    console.log("Point Stripe at `npm run webhook` (POST /webhook) to write a sale receipt.");
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
