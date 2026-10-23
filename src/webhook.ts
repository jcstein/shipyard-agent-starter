import { loadConfig } from "./config.ts";
import { startWebhook } from "./stripe.ts";

const cfg = loadConfig();
let server;
try {
  server = startWebhook(cfg);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
server?.listen(cfg.webhookPort, "127.0.0.1", () => {
  console.log(`Stripe webhook listening on http://127.0.0.1:${cfg.webhookPort}/webhook`);
  console.log(`Checkout redirects: http://127.0.0.1:${cfg.webhookPort}/success and /cancel`);
  console.log("Test-mode checkout.session.completed events are logged as sales with livemode false. They are not revenue.");
});
