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
  console.log(
    cfg.mode === "live"
      ? "DEMO_MODE=live: a paid checkout runs Houston inference and can spend TIA."
      : "DEMO_MODE=dry-run: a paid checkout uses mock inference and spends no TIA.",
  );
  console.log(`Job results are written to ${cfg.jobsPath}.`);
  console.log("Test-mode checkout.session.completed events are logged as sales with livemode false. They are not revenue.");
});
