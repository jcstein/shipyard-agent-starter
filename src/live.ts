import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { loadConfig, type Config, type DemoMode } from "./config.ts";
import { taskFromArgv } from "./jobs.ts";
import { createCheckout } from "./stripe.ts";

/** Stripe CLI Ready line. Docs and the CLI print one of these (color codes stripped):
 *  > Ready! Your webhook signing secret is whsec_… (^C to quit)
 *  Ready! You are using Stripe API Version [2025-03-31.basil]. Your webhook signing secret is whsec_… (^C to quit)
 * The whsec_ token is the HMAC key the webhook already checks. It is not a Dashboard endpoint secret.
 */
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const SECRET = /whsec_[A-Za-z0-9_+/=-]+/;

/** Matches the listening line printed by src/webhook.ts. Importing that file would bind a port. */
const WEBHOOK_READY_PREFIX = "Stripe webhook listening on";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

/** Pull the signing secret from one complete `stripe listen` line. Incomplete lines return null. */
export function parseListenSecret(line: string): string | null {
  const plain = stripAnsi(line).trim();
  if (!/webhook signing secret/i.test(plain) && !/\bReady!/.test(plain)) return null;
  return plain.match(SECRET)?.[0] ?? null;
}

export function stripeListenArgs(port: number): string[] {
  return [
    "listen",
    "--events",
    "checkout.session.completed",
    "--forward-to",
    `localhost:${port}/webhook`,
  ];
}

export function webhookChildArgs(cwd: string): string[] {
  const script = fileURLToPath(new URL("./webhook.ts", import.meta.url));
  return [`--env-file-if-exists=${join(cwd, ".env")}`, script];
}

/** Child env wins over `--env-file`, so the listen secret replaces STRIPE_WEBHOOK_SECRET without editing .env. */
export function webhookChildEnv(base: NodeJS.ProcessEnv, cfg: Config, secret: string): NodeJS.ProcessEnv {
  return {
    ...base,
    DEMO_MODE: cfg.mode,
    WEBHOOK_PORT: String(cfg.webhookPort),
    STRIPE_WEBHOOK_SECRET: secret,
  };
}

/** Point the default success and cancel URLs at the webhook port this command binds. */
export function checkoutConfig(cfg: Config, secret: string): Config {
  const retarget = (url: string, path: string): string => {
    const defaults = [`http://localhost:8787${path}`, `http://127.0.0.1:8787${path}`];
    if (!defaults.includes(url)) return url;
    return `http://localhost:${cfg.webhookPort}${path}`;
  };
  return {
    ...cfg,
    stripeWebhookSecret: secret,
    successUrl: retarget(cfg.successUrl, "/success"),
    cancelUrl: retarget(cfg.cancelUrl, "/cancel"),
  };
}

export function modeLine(mode: DemoMode): string {
  return mode === "live"
    ? "DEMO_MODE=live: a paid checkout runs Houston inference and can spend TIA, then posts receipts to Mocha."
    : "DEMO_MODE=dry-run: a paid checkout uses mock inference and spends no TIA.";
}

export function listenFailureMessage(output: string, missingBinary: boolean): string {
  if (missingBinary) {
    return "Stripe CLI was not found on PATH. Install it from https://docs.stripe.com/stripe-cli, run `stripe login`, then run `npm run live` again.";
  }
  if (/expired api key/i.test(output) || /invalid api key/i.test(output)) {
    return "Stripe CLI rejected the API key. Run `stripe login`, then run `npm run live` again.";
  }
  if (/not configured API keys/i.test(output) || /stripe login/i.test(output) || /not authenticated/i.test(output)) {
    return "Stripe CLI is not logged in. Run `stripe login`, then run `npm run live` again.";
  }
  return "stripe listen stopped before printing a whsec_ signing secret. Run `stripe login` if the CLI has no API keys, then try `npm run live` again.";
}

export type LiveSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
};

export type LiveChild = {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

export type LiveSpawn = (command: string, args: readonly string[], options: LiveSpawnOptions) => LiveChild;

export type StartLiveInput = {
  cfg: Config;
  task: string | null;
  spawn?: LiveSpawn;
  log?: (line: string) => void;
  error?: (line: string) => void;
  createCheckout?: (
    cfg: Config,
    fetchImpl: typeof fetch,
    task: string | null,
  ) => Promise<{ id: string; url: string }>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nodePath?: string;
  stripeBin?: string;
  secretTimeoutMs?: number;
  readyTimeoutMs?: number;
  killGraceMs?: number;
};

export type LiveSession = {
  done: Promise<number>;
  stop: () => void;
};

function defaultSpawn(command: string, args: readonly string[], options: LiveSpawnOptions): LiveChild {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
    windowsHide: true,
  }) as unknown as LiveChild;
}

function drainLines(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer;
  while (rest.length > 0) {
    const match = /\r?\n/.exec(rest);
    if (!match) break;
    onLine(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return rest;
}

function signalChild(child: LiveChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The child has already exited.
  }
}

/**
 * One terminal: `stripe listen`, the existing webhook (with the listen secret), and a Checkout URL.
 * DEMO_MODE is passed through, so `live` still runs Houston and the Mocha post.
 */
export function startLive(input: StartLiveInput): LiveSession {
  const log = input.log ?? ((line: string) => console.log(line));
  const errorLog = input.error ?? ((line: string) => console.error(line));
  const spawnImpl = input.spawn ?? defaultSpawn;
  const openCheckout = input.createCheckout ?? createCheckout;
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? repoRoot;
  const nodePath = input.nodePath ?? process.execPath;
  const stripeBin = input.stripeBin ?? "stripe";
  const secretTimeoutMs = input.secretTimeoutMs ?? 45_000;
  const readyTimeoutMs = input.readyTimeoutMs ?? 15_000;
  const killGraceMs = input.killGraceMs ?? 1_500;
  const cfg = input.cfg;

  let closed = false;
  let settled = false;
  let exitCode = 0;
  let gotSecret = false;
  let webhookReady = false;
  const timers: {
    kill?: ReturnType<typeof setTimeout>;
    secret?: ReturnType<typeof setTimeout>;
    ready?: ReturnType<typeof setTimeout>;
  } = {};
  let listenOutput = "";
  const children: LiveChild[] = [];
  const exited = new Set<LiveChild>();
  const flushers: Array<() => void> = [];

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = (code: number) => {
      if (closed) return;
      closed = true;
      if (timers.kill) clearTimeout(timers.kill);
      resolve(code);
    };
  });

  function remember(text: string): void {
    listenOutput = (listenOutput + stripAnsi(text)).slice(-8_000);
  }

  function logLine(tag: string, line: string): void {
    if (line.trim().length === 0) return;
    log(`${tag} ${line}`);
  }

  function maybeDone(): void {
    if (!settled) return;
    if (children.every((child) => exited.has(child))) resolveDone(exitCode);
  }

  function finish(code: number): void {
    if (settled) return;
    settled = true;
    exitCode = code;
    if (timers.secret) clearTimeout(timers.secret);
    if (timers.ready) clearTimeout(timers.ready);
    for (const child of children) {
      if (!exited.has(child)) signalChild(child, "SIGTERM");
    }
    if (children.every((child) => exited.has(child))) {
      resolveDone(code);
      return;
    }
    timers.kill = setTimeout(() => {
      for (const child of children) {
        if (!exited.has(child)) signalChild(child, "SIGKILL");
      }
      resolveDone(code);
    }, killGraceMs);
  }

  function flushStreams(): void {
    for (const flush of flushers) flush();
  }

  function watchStream(stream: Readable | null, onLine: (line: string) => void): void {
    if (!stream) return;
    let buffer = "";
    const emitRest = () => {
      if (buffer.length === 0) return;
      const pending = buffer;
      buffer = "";
      onLine(pending);
    };
    flushers.push(emitRest);
    stream.setEncoding("utf8");
    stream.on("error", () => {
      // Pipe closed during teardown.
    });
    stream.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer = drainLines(buffer, onLine);
      if (!gotSecret && buffer.includes("(^C to quit)")) emitRest();
    });
  }

  function onListenLine(line: string): void {
    logLine("[stripe]", line);
    remember(`${line}\n`);
    if (gotSecret || settled) return;
    const secret = parseListenSecret(line);
    if (!secret) return;
    startWebhook(secret);
  }

  function startWebhook(secret: string): void {
    if (gotSecret || settled) return;
    gotSecret = true;
    if (timers.secret) clearTimeout(timers.secret);
    log("Captured the stripe listen signing secret for the webhook. .env was not changed.");
    const sessionCfg = checkoutConfig(cfg, secret);
    let child: LiveChild;
    try {
      child = spawnImpl(nodePath, webhookChildArgs(cwd), {
        cwd,
        env: webhookChildEnv(env, cfg, secret),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      errorLog(error instanceof Error ? error.message : String(error));
      finish(1);
      return;
    }
    watch(child, "webhook");
    const onWebhookLine = (line: string) => {
      logLine("[webhook]", line);
      if (webhookReady || settled) return;
      if (!stripAnsi(line).includes(WEBHOOK_READY_PREFIX)) return;
      webhookReady = true;
      if (timers.ready) clearTimeout(timers.ready);
      void openSession(sessionCfg);
    };
    watchStream(child.stdout, onWebhookLine);
    watchStream(child.stderr, onWebhookLine);
    timers.ready = setTimeout(() => {
      flushStreams();
      if (settled || webhookReady) return;
      errorLog("Timed out waiting for the webhook to listen.");
      finish(1);
    }, readyTimeoutMs);
  }

  async function openSession(sessionCfg: Config): Promise<void> {
    try {
      const session = await openCheckout(sessionCfg, fetch, input.task);
      if (settled) return;
      log(`Checkout ${session.id}`);
      log(session.url);
      if (input.task) log(`Task: ${input.task}`);
      else log("No task argument. The Checkout page asks for one.");
      log("Pay with 4242 4242 4242 4242, any future expiry, any CVC, and any postcode. Test mode is not revenue.");
      log(modeLine(cfg.mode));
      log("Ctrl-C stops stripe listen and the webhook.");
    } catch (error) {
      if (settled) return;
      errorLog(error instanceof Error ? error.message : String(error));
      finish(1);
    }
  }

  function watch(child: LiveChild, role: "listen" | "webhook"): void {
    children.push(child);
    const onGone = (
      kind: "error" | "exit",
      error: NodeJS.ErrnoException | undefined,
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (exited.has(child)) {
        maybeDone();
        return;
      }
      exited.add(child);
      if (settled) {
        maybeDone();
        return;
      }
      if (kind === "error") {
        const missing = role === "listen" && (error?.code === "ENOENT" || error?.code === "EACCES");
        errorLog(missing ? listenFailureMessage("", true) : (error?.message ?? `${role} failed`));
        finish(1);
        return;
      }
      if (signal === "SIGINT" || signal === "SIGTERM") {
        finish(0);
        return;
      }
      if (role === "listen" && !gotSecret) {
        errorLog(listenFailureMessage(listenOutput, false));
        finish(1);
        return;
      }
      if (role === "webhook" && !webhookReady) {
        errorLog("The webhook exited before it was listening.");
        finish(1);
        return;
      }
      if (code !== 0 && code !== null) {
        errorLog(role === "listen" ? "stripe listen exited." : "The webhook exited.");
        finish(1);
        return;
      }
      finish(0);
    };
    child.on("error", (error) => onGone("error", error, 1, null));
    child.on("exit", (code, signal) => {
      flushStreams();
      onGone("exit", undefined, code, signal);
    });
  }

  if (!cfg.stripeSecret) {
    errorLog(
      "STRIPE_SECRET_KEY is required (use a test-mode sk_test_ key until you mean to charge customers)",
    );
    settled = true;
    resolveDone(1);
    return { done, stop: () => finish(0) };
  }

  log(
    `Starting stripe listen for checkout.session.completed, forwarding to localhost:${cfg.webhookPort}/webhook.`,
  );
  log(modeLine(cfg.mode));

  let listenChild: LiveChild;
  try {
    listenChild = spawnImpl(stripeBin, stripeListenArgs(cfg.webhookPort), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    errorLog(error instanceof Error ? error.message : String(error));
    settled = true;
    resolveDone(1);
    return { done, stop: () => finish(0) };
  }
  watch(listenChild, "listen");
  watchStream(listenChild.stdout, onListenLine);
  watchStream(listenChild.stderr, onListenLine);
  timers.secret = setTimeout(() => {
    flushStreams();
    if (settled || gotSecret) return;
    errorLog(
      "Timed out waiting for stripe listen to print a whsec_ signing secret. If you are not logged in, run `stripe login`, then run `npm run live` again.",
    );
    finish(1);
  }, secretTimeoutMs);

  return { done, stop: () => finish(0) };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

async function runLiveCli(): Promise<void> {
  let task: string | null;
  let cfg: Config;
  try {
    task = taskFromArgv(process.argv);
    cfg = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const session = startLive({ cfg, task });
  process.on("SIGINT", () => session.stop());
  process.on("SIGTERM", () => session.stop());
  process.exit(await session.done);
}

if (isMainModule()) {
  void runLiveCli();
}
