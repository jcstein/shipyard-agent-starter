import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { loadConfig, type Config } from "../src/config.ts";
import {
  checkoutConfig,
  listenFailureMessage,
  parseListenSecret,
  startLive,
  stripeListenArgs,
  webhookChildArgs,
  webhookChildEnv,
  type LiveChild,
  type LiveSpawnOptions,
} from "../src/live.ts";
import { verifyStripeSignature } from "../src/stripe.ts";

const READY =
  "> Ready! Your webhook signing secret is whsec_oZ8nus9PHnoltEtWZ3pGITZdeHWHoqnL (^C to quit)";
const VERSIONED =
  "Ready! You are using Stripe API Version [2025-03-31.basil]. Your webhook signing secret is whsec_VersionedSecret (^C to quit)";

class FakeChild extends EventEmitter implements LiveChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  private closed = false;

  pushOut(chunk: string): void {
    this.stdout.write(chunk);
  }

  pushErr(chunk: string): void {
    this.stderr.write(chunk);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.end(null, signal);
    return true;
  }

  die(code: number): void {
    this.end(code, null);
  }

  end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.destroy();
    this.stderr.destroy();
    this.emit("exit", code, signal);
  }

  failSpawn(code: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.destroy();
    this.stderr.destroy();
    const error = Object.assign(new Error(`spawn stripe ${code}`), { code });
    this.emit("error", error);
  }
}

type Spawned = {
  command: string;
  args: readonly string[];
  options: LiveSpawnOptions;
  child: FakeChild;
};

function harness(input: {
  mode?: "live" | "dry-run";
  port?: string;
  task?: string | null;
  secret?: string | null;
  successUrl?: string;
  envFile?: string;
  secretTimeoutMs?: number;
  readyTimeoutMs?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  if (input.envFile !== undefined) writeFileSync(join(dir, ".env"), input.envFile);
  const mode = input.mode ?? "live";
  const cfg = loadConfig({
    DEMO_MODE: mode,
    WEBHOOK_PORT: input.port ?? "8787",
    STRIPE_SECRET_KEY: input.secret === undefined ? "sk_test_example" : input.secret ?? undefined,
    STRIPE_WEBHOOK_SECRET: "whsec_from_dotenv",
    STRIPE_SUCCESS_URL: input.successUrl,
    EDEN_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
  });
  const spawned: Spawned[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let checkoutCfg: Config | undefined;
  let checkoutTask: string | null = null;
  const session = startLive({
    cfg,
    task: input.task === undefined ? "name a service" : input.task,
    cwd: dir,
    nodePath: "node-test",
    stripeBin: "stripe",
    env: {
      ...process.env,
      DEMO_MODE: mode,
      STRIPE_WEBHOOK_SECRET: "whsec_from_dotenv",
      STRIPE_SECRET_KEY: "sk_test_example",
      EDEN_PRIVATE_KEY: cfg.privateKey ?? "",
    },
    secretTimeoutMs: input.secretTimeoutMs ?? 5_000,
    readyTimeoutMs: input.readyTimeoutMs ?? 5_000,
    killGraceMs: 50,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawned.push({ command, args, options, child });
      return child;
    },
    createCheckout: async (next, _fetchImpl, task) => {
      checkoutCfg = next;
      checkoutTask = task;
      return { id: "cs_test_live", url: "https://checkout.stripe.com/c/pay/cs_test_live" };
    },
  });
  return { dir, cfg, spawned, logs, errors, session, checkout: () => ({ checkoutCfg, checkoutTask }) };
}

describe("stripe listen secret", () => {
  it("parses the documented Ready line and uses it as the webhook HMAC key", () => {
    const secret = parseListenSecret(READY);
    assert.equal(secret, "whsec_oZ8nus9PHnoltEtWZ3pGITZdeHWHoqnL");
    const body = '{"type":"checkout.session.completed"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret ?? "").update(`${timestamp}.${body}`).digest("hex");
    const header = `t=${timestamp},v1=${signature}`;
    assert.equal(verifyStripeSignature(body, header, secret ?? ""), true);
    assert.equal(verifyStripeSignature(body, header, "whsec_from_dotenv"), false);
  });

  it("parses the API-version Ready line, ANSI color, and a quoted secret", () => {
    assert.equal(parseListenSecret(VERSIONED), "whsec_VersionedSecret");
    const colored = `\u001b[32m> Ready! Your webhook signing secret is whsec_AnsiSecret123 (^C to quit)\u001b[0m`;
    assert.equal(parseListenSecret(colored), "whsec_AnsiSecret123");
    assert.equal(
      parseListenSecret("Ready! Your webhook signing secret is 'whsec_Quoted_Secret' (^C to quit)"),
      "whsec_Quoted_Secret",
    );
    assert.equal(
      parseListenSecret("2026-10-28 09:47:46   --> checkout.session.completed [evt_whsec_nope]"),
      null,
    );
    assert.equal(parseListenSecret("Getting ready..."), null);
  });

  it("builds the listen command for the webhook port", () => {
    assert.deepEqual(stripeListenArgs(9090), [
      "listen",
      "--events",
      "checkout.session.completed",
      "--forward-to",
      "localhost:9090/webhook",
    ]);
  });

  it("overrides the webhook secret and keeps DEMO_MODE on the child env", () => {
    const cfg = loadConfig({
      DEMO_MODE: "live",
      WEBHOOK_PORT: "9090",
      STRIPE_WEBHOOK_SECRET: "whsec_from_dotenv",
    });
    const env = webhookChildEnv(
      { STRIPE_WEBHOOK_SECRET: "whsec_from_dotenv", EDEN_PRIVATE_KEY: "0xabc", PATH: "/usr/bin" },
      cfg,
      "whsec_fromlisten",
    );
    assert.equal(env.STRIPE_WEBHOOK_SECRET, "whsec_fromlisten");
    assert.equal(env.DEMO_MODE, "live");
    assert.equal(env.WEBHOOK_PORT, "9090");
    assert.equal(env.EDEN_PRIVATE_KEY, "0xabc");
    assert.equal(env.PATH, "/usr/bin");
  });

  it("points default checkout redirects at the webhook port and keeps a custom URL", () => {
    const cfg = loadConfig({ WEBHOOK_PORT: "9090", STRIPE_SUCCESS_URL: "https://example.test/paid" });
    const custom = checkoutConfig(cfg, "whsec_fromlisten");
    assert.equal(custom.successUrl, "https://example.test/paid");
    assert.equal(custom.cancelUrl, "http://localhost:9090/cancel");
    assert.equal(custom.stripeWebhookSecret, "whsec_fromlisten");
    const defaults = checkoutConfig(loadConfig({ WEBHOOK_PORT: "9090" }), "whsec_fromlisten");
    assert.equal(defaults.successUrl, "http://localhost:9090/success");
    assert.equal(defaults.cancelUrl, "http://localhost:9090/cancel");
  });

  it("names a missing CLI and a logged-out CLI differently", () => {
    assert.match(listenFailureMessage("", true), /not found on PATH/);
    assert.match(listenFailureMessage("", true), /stripe login/);
    const loggedOut = "You have not configured API keys yet. Run `stripe login`.";
    assert.match(listenFailureMessage(loggedOut, false), /not logged in/);
    assert.match(listenFailureMessage("Expired API Key provided", false), /rejected the API key/);
    assert.match(listenFailureMessage("connection reset", false), /stopped before printing a whsec_/);
  });
});

describe("npm run live", () => {
  it("starts listen, passes a split whsec to the webhook, and prints the checkout URL", async () => {
    const envBody = "STRIPE_WEBHOOK_SECRET=whsec_from_dotenv\nDEMO_MODE=dry-run\n";
    const run = harness({ mode: "live", port: "9090", envFile: envBody });
    assert.equal(run.spawned.length, 1);
    assert.equal(run.spawned[0]?.command, "stripe");
    assert.deepEqual(run.spawned[0]?.args, stripeListenArgs(9090));
    assert.match(run.logs.join("\n"), /can spend TIA/);

    const stripe = run.spawned[0]?.child;
    assert.ok(stripe);
    stripe.pushOut("Ready! You are using Stripe API Version [2025-03-31.basil]. Your webhook signing secret is whsec_split");
    assert.equal(run.spawned.length, 1);
    stripe.pushOut("Secret123 (^C to quit)\n");
    assert.equal(run.spawned.length, 2);

    const webhook = run.spawned[1];
    assert.ok(webhook);
    assert.equal(webhook.command, "node-test");
    assert.equal(webhook.args[0], `--env-file-if-exists=${join(run.dir, ".env")}`);
    assert.match(webhook.args[1] ?? "", /webhook\.ts$/);
    assert.equal(webhook.args.some((arg) => arg.includes("whsec_")), false);
    assert.equal(webhook.options.env.STRIPE_WEBHOOK_SECRET, "whsec_splitSecret123");
    assert.equal(webhook.options.env.DEMO_MODE, "live");
    assert.equal(webhook.options.env.WEBHOOK_PORT, "9090");
    assert.equal(webhook.options.env.EDEN_PRIVATE_KEY, run.cfg.privateKey);
    assert.equal(webhook.options.cwd, run.dir);

    stripe.pushOut("2026-10-28 09:47:46   --> checkout.session.completed [evt_whsec_nope]\n");
    assert.equal(run.spawned.length, 2);

    webhook.child.pushOut("Stripe webhook listening on http://127.0.0.1:9090/webhook\n");
    await new Promise((resolve) => setImmediate(resolve));
    const opened = run.checkout();
    assert.equal(opened.checkoutCfg?.stripeWebhookSecret, "whsec_splitSecret123");
    assert.equal(opened.checkoutCfg?.mode, "live");
    assert.equal(opened.checkoutCfg?.successUrl, "http://localhost:9090/success");
    assert.equal(opened.checkoutTask, "name a service");
    const text = run.logs.join("\n");
    assert.match(text, /\[stripe\] Ready!/);
    assert.match(text, /\[webhook\] Stripe webhook listening/);
    assert.match(text, /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_live/);
    assert.match(text, /4242 4242 4242 4242/);
    assert.match(text, /\.env was not changed/);
    assert.equal(readFileSync(join(run.dir, ".env"), "utf8"), envBody);

    run.session.stop();
    assert.equal(await run.session.done, 0);
    assert.equal(stripe.signals[0], "SIGTERM");
    assert.equal(webhook.child.signals[0], "SIGTERM");
  });

  it("keeps dry-run on the webhook child", async () => {
    const run = harness({ mode: "dry-run", task: null });
    run.spawned[0]?.child.pushOut(`${READY}\n`);
    run.spawned[1]?.child.pushOut("Stripe webhook listening on http://127.0.0.1:8787/webhook\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(run.spawned[1]?.options.env.DEMO_MODE, "dry-run");
    assert.equal(run.spawned[1]?.options.env.STRIPE_WEBHOOK_SECRET, "whsec_oZ8nus9PHnoltEtWZ3pGITZdeHWHoqnL");
    assert.match(run.logs.join("\n"), /spends no TIA/);
    assert.match(run.logs.join("\n"), /No task argument/);
    run.session.stop();
    assert.equal(await run.session.done, 0);
  });

  it("fails before spawning when the Stripe secret key is missing", async () => {
    const run = harness({ secret: null });
    assert.equal(run.spawned.length, 0);
    assert.match(run.errors.join("\n"), /STRIPE_SECRET_KEY is required/);
    assert.equal(await run.session.done, 1);
  });

  it("fails clearly when the stripe binary is missing", async () => {
    const run = harness({});
    queueMicrotask(() => run.spawned[0]?.child.failSpawn("ENOENT"));
    assert.equal(await run.session.done, 1);
    assert.equal(run.spawned.length, 1);
    assert.match(run.errors.join("\n"), /not found on PATH/);
  });

  it("fails clearly when stripe listen is not logged in, even without a newline", async () => {
    const run = harness({});
    const stripe = run.spawned[0]?.child;
    assert.ok(stripe);
    stripe.pushErr("you have not configured API keys yet. To do so, run `stripe login`");
    stripe.die(1);
    assert.equal(await run.session.done, 1);
    assert.equal(run.spawned.length, 1);
    assert.match(run.errors.join("\n"), /not logged in/);
    assert.match(run.errors.join("\n"), /stripe login/);
  });

  it("stops when stripe listen never prints a secret", async () => {
    const run = harness({ secretTimeoutMs: 30 });
    assert.equal(await run.session.done, 1);
    assert.match(run.errors.join("\n"), /Timed out waiting for stripe listen/);
    assert.equal(run.spawned[0]?.child.signals[0], "SIGTERM");
    assert.equal(run.spawned.length, 1);
  });

  it("stops when the webhook never listens", async () => {
    const run = harness({ readyTimeoutMs: 30 });
    run.spawned[0]?.child.pushOut(`${READY}\n`);
    assert.equal(run.spawned.length, 2);
    assert.equal(await run.session.done, 1);
    assert.match(run.errors.join("\n"), /Timed out waiting for the webhook/);
    assert.equal(run.spawned[0]?.child.signals[0], "SIGTERM");
    assert.equal(run.spawned[1]?.child.signals[0], "SIGTERM");
  });

  it("treats SIGINT from stripe listen as a clean stop", async () => {
    const run = harness({});
    run.spawned[0]?.child.end(null, "SIGINT");
    assert.equal(await run.session.done, 0);
    assert.equal(run.spawned.length, 1);
  });

  it("stops when the webhook exits before listening", async () => {
    const run = harness({});
    run.spawned[0]?.child.pushOut(`${READY}\n`);
    const webhook = run.spawned[1]?.child;
    assert.ok(webhook);
    webhook.pushErr("listen EADDRINUSE: address already in use 127.0.0.1:8787\n");
    webhook.die(1);
    assert.equal(await run.session.done, 1);
    assert.match(run.errors.join("\n"), /exited before it was listening/);
    assert.match(run.logs.join("\n"), /EADDRINUSE/);
    assert.equal(run.spawned[0]?.child.signals[0], "SIGTERM");
  });

  it("stops both children when checkout fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-"));
    const cfg = loadConfig({ STRIPE_SECRET_KEY: "sk_test_example", STRIPE_WEBHOOK_SECRET: "whsec_from_dotenv" });
    const spawned: FakeChild[] = [];
    const errors: string[] = [];
    const session = startLive({
      cfg,
      task: null,
      cwd: dir,
      secretTimeoutMs: 200,
      readyTimeoutMs: 200,
      killGraceMs: 50,
      log: () => {},
      error: (line) => errors.push(line),
      spawn: () => {
        const child = new FakeChild();
        spawned.push(child);
        return child;
      },
      createCheckout: async () => {
        throw new Error("Stripe checkout failed: invalid key");
      },
    });
    spawned[0]?.pushOut(`${READY}\n`);
    spawned[1]?.pushOut("Stripe webhook listening on http://127.0.0.1:8787/webhook\n");
    assert.equal(await session.done, 1);
    assert.match(errors.join("\n"), /Stripe checkout failed: invalid key/);
    assert.equal(spawned[0]?.signals[0], "SIGTERM");
    assert.equal(spawned[1]?.signals[0], "SIGTERM");
  });

  it("builds the webhook command from the repo script", () => {
    const args = webhookChildArgs("/tmp/shipyard");
    assert.equal(args[0], "--env-file-if-exists=/tmp/shipyard/.env");
    assert.match(args[1] ?? "", /src\/webhook\.ts$/);
  });

  it("spawns real children, reads whsec from stdout, and tears them down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-real-"));
    const stripeBin = join(dir, "stripe");
    writeFileSync(
      stripeBin,
      `#!/usr/bin/env node
process.stdout.write("> Ready! Your webhook signing secret is whsec_fromreal (^C to quit)\\n");
setInterval(() => {}, 1000);
`,
    );
    chmodSync(stripeBin, 0o755);
    const cfg = loadConfig({
      DEMO_MODE: "dry-run",
      WEBHOOK_PORT: "18787",
      STRIPE_SECRET_KEY: "sk_test_example",
      STRIPE_WEBHOOK_SECRET: "whsec_from_dotenv",
    });
    const logs: string[] = [];
    const errors: string[] = [];
    const pids: number[] = [];
    let openedSecret: string | null = null;
    const session = startLive({
      cfg,
      task: null,
      cwd: dir,
      stripeBin,
      nodePath: process.execPath,
      env: { ...process.env, STRIPE_WEBHOOK_SECRET: "whsec_from_dotenv", DEMO_MODE: "dry-run" },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
      spawn: (command, args, options) => {
        const child = spawn(command, [...args], options);
        if (child.pid) pids.push(child.pid);
        return child as unknown as LiveChild;
      },
      createCheckout: async (next) => {
        openedSecret = next.stripeWebhookSecret;
        return { id: "cs_test_real", url: "https://checkout.stripe.com/c/pay/cs_test_real" };
      },
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!logs.some((line) => line.includes("cs_test_real")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(logs.join("\n"), /Stripe webhook listening on http:\/\/127\.0\.0\.1:18787\/webhook/);
      assert.match(logs.join("\n"), /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_real/);
      assert.equal(openedSecret, "whsec_fromreal");
      const webhookPid = pids[1];
      assert.ok(webhookPid);
      const environ = readFileSync(`/proc/${webhookPid}/environ`).toString("utf8");
      assert.match(environ, /STRIPE_WEBHOOK_SECRET=whsec_fromreal/);
      assert.doesNotMatch(environ, /STRIPE_WEBHOOK_SECRET=whsec_from_dotenv/);
      assert.match(environ, /DEMO_MODE=dry-run/);
    } finally {
      session.stop();
      assert.equal(await session.done, 0);
    }
    assert.equal(errors.join("\n"), "");
  });
});
