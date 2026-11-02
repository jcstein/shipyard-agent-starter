import { config, deferred, fresh, houston, job } from "../recovery-helpers.ts";
import { fulfillCheckout } from "../../src/fulfill.ts";

globalThis.fetch = async () => { throw new Error("real network disabled in interruption test"); };
const phase = process.argv[3];
const cfg = config({ DEMO_MODE: phase === "post" ? "dry-run" : "live" }, process.argv[2]);
const current = job(cfg, "cs_interrupted");
const quote = await fresh();
const mock = houston(quote, { paidGate: deferred(), onSend: () => { process.send?.("deposit"); } });
setInterval(() => {}, 1000);
await fulfillCheckout(cfg, current,
  phase === "quote" ? async () => { process.send?.("quote"); return new Promise(() => {}); } : mock.fetchImpl,
  { run: async () => { process.send?.("post"); return new Promise(() => {}); } });
