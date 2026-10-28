import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { blobPayload, mochaReadHint, readPostLog, submitReceiptBlob, unpostedLines, v0Namespace, writePostLog } from "./celestia.ts";
import { loadConfig, type Config } from "./config.ts";
import { MOCHA_CHAIN, MOCHA_EXPLORER, MOCHA_FAUCET } from "./eden.ts";
import { sha256Hex } from "./hash.ts";
import { readReceiptLines } from "./receipts.ts";

export type HelperResult = { code: number; stdout: Buffer; stderr: string };

export type HelperRequest = {
  bin: string;
  args: string[];
  stdin?: Buffer;
  timeoutMs: number;
};

export type HelperRun = (request: HelperRequest) => Promise<HelperResult>;

/** Passed into checkout fulfillment and the live demo so tests can mock the helper. */
export type ReceiptPostDeps = {
  fetchImpl?: typeof fetch;
  run?: HelperRun;
};

/** Celenium page for a posted Mocha blob. `hash` is the 29-byte v0 namespace. */
export function mochaBlobUrl(height: number, commitment: string, namespaceId: string): string {
  const params = new URLSearchParams({
    commitment,
    hash: v0Namespace(namespaceId).toString("base64"),
    height: String(height),
  });
  return `${MOCHA_EXPLORER}/blob?${params.toString()}`;
}

/** Celenium URL for the blob that contains this checkout's inference line. Null when none was posted. */
export function mochaBlobUrlForCheckout(cfg: Config, checkoutId: string): string | null {
  const lines = readReceiptLines(cfg.receiptsPath);
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    let event: { type?: unknown; checkoutId?: unknown };
    try {
      event = JSON.parse(line) as { type?: unknown; checkoutId?: unknown };
    } catch {
      continue;
    }
    if (event.type === "inference" && event.checkoutId === checkoutId) index = i;
  }
  if (index < 0) return null;
  let log;
  try {
    log = readPostLog(cfg.postsPath, cfg.namespaceId);
  } catch {
    return null;
  }
  for (let i = log.posts.length - 1; i >= 0; i -= 1) {
    const post = log.posts[i];
    if (!post || post.mock || post.height === null || !post.commitment) continue;
    if (post.lineStart <= index && index < post.lineEnd) {
      return mochaBlobUrl(post.height, post.commitment, cfg.namespaceId);
    }
  }
  return null;
}

export function runMochaHelper(request: HelperRequest): Promise<HelperResult> {
  if (!existsSync(request.bin)) {
    return Promise.reject(new Error(`Mocha helper not found at ${request.bin}. ${mochaReadHint()}`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(request.bin, request.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // The node client logs "balance does not exist" at error for an unfunded
        // account, then returns a zero balance. Keep that off the funds line.
        GOLOG_LOG_LEVEL: process.env.GOLOG_LOG_LEVEL ?? "fatal",
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Mocha helper timed out after ${request.timeoutMs}ms`)));
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString("utf8"),
        }),
      );
    });
    if (request.stdin) child.stdin.end(request.stdin);
    else child.stdin.end();
  });
}

export function addressArgs(cfg: Config): string[] {
  return ["address", "--keyring", cfg.celestiaKeyring, "--key", cfg.celestiaKeyName];
}

export function headArgs(cfg: Config): string[] {
  return ["head", "--da", cfg.celestiaDaUrl, `--da-tls=${cfg.celestiaDaTls}`, "--network", MOCHA_CHAIN];
}

export function submitArgs(cfg: Config): string[] {
  return [
    "submit",
    "--keyring", cfg.celestiaKeyring,
    "--key", cfg.celestiaKeyName,
    "--namespace", cfg.namespaceId,
    "--da", cfg.celestiaDaUrl,
    `--da-tls=${cfg.celestiaDaTls}`,
    "--core", cfg.celestiaCoreGrpc,
    `--core-tls=${cfg.celestiaCoreTls}`,
    "--network", MOCHA_CHAIN,
  ];
}

export function getArgs(cfg: Config, height: number, commitment: string): string[] {
  return [
    "get",
    "--namespace", cfg.namespaceId,
    "--height", String(height),
    "--commitment", commitment,
    "--da", cfg.celestiaDaUrl,
    `--da-tls=${cfg.celestiaDaTls}`,
    "--network", MOCHA_CHAIN,
  ];
}

type PostedBlob = {
  height: number;
  commitment: string;
  payloadSha256: string;
  address?: string;
  balance?: string;
  stderr?: string;
};

function helperFailure(result: HelperResult): Error {
  const detail = result.stderr.trim() || result.stdout.toString("utf8").trim();
  return new Error(detail || `Mocha helper exited ${result.code}`);
}

function parseSubmit(stdout: Buffer): { height: number; commitment: string; address?: string; balance?: string } {
  const line = stdout
    .toString("utf8")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("{"))
    .at(-1);
  if (!line) throw new Error(`Mocha helper returned no JSON: ${stdout.toString("utf8").slice(0, 240)}`);
  const parsed = JSON.parse(line) as { height?: unknown; commitment?: unknown; address?: unknown; balance?: unknown };
  const height = typeof parsed.height === "number" ? parsed.height : Number(parsed.height);
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`Mocha helper returned an unexpected height: ${JSON.stringify(parsed.height)}`);
  }
  if (typeof parsed.commitment !== "string" || parsed.commitment.length === 0) {
    throw new Error("Mocha helper returned no commitment");
  }
  return {
    height,
    commitment: parsed.commitment,
    address: typeof parsed.address === "string" ? parsed.address : undefined,
    balance: typeof parsed.balance === "string" ? parsed.balance : undefined,
  };
}

async function submitWithHelper(cfg: Config, lines: string[], run: HelperRun): Promise<PostedBlob> {
  const payload = blobPayload(lines);
  const result = await run({
    bin: cfg.celestiaHelper,
    args: submitArgs(cfg),
    stdin: Buffer.from(payload),
    timeoutMs: 240_000,
  });
  if (result.code !== 0) throw helperFailure(result);
  const posted = parseSubmit(result.stdout);
  return {
    height: posted.height,
    commitment: posted.commitment,
    payloadSha256: sha256Hex(payload),
    address: posted.address,
    balance: posted.balance,
    stderr: result.stderr,
  };
}

export async function postReceipts(
  env: NodeJS.ProcessEnv = process.env,
  deps: ReceiptPostDeps & { cfg?: Config } = {},
): Promise<string[]> {
  const cfg = deps.cfg ?? loadConfig(env);
  const lines = readReceiptLines(cfg.receiptsPath);
  const log = readPostLog(cfg.postsPath, cfg.namespaceId);
  if (log.namespaceId !== cfg.namespaceId) {
    throw new Error(`posts.json namespace is ${log.namespaceId}, config is ${cfg.namespaceId}`);
  }
  const pending = unpostedLines(lines, log);
  if (pending.lines.length === 0) {
    const mocks = log.posts.filter((post) => post.mock).length;
    if (mocks > 0 && mocks === log.posts.length) {
      return [
        "No unposted receipt lines. The recorded post is a local mock and was not sent to Mocha. A live inference, a Stripe sale, or `npm run human` adds lines you can submit.",
      ];
    }
    return ["No unposted receipt lines."];
  }
  const posted = cfg.celestiaRpc
    ? await submitReceiptBlob({
        rpcUrl: cfg.celestiaRpc,
        token: cfg.celestiaToken,
        namespaceId: cfg.namespaceId,
        lines: pending.lines,
        fetchImpl: deps.fetchImpl,
      })
    : await submitWithHelper(cfg, pending.lines, deps.run ?? runMochaHelper);
  log.posts.push({
    at: new Date().toISOString(),
    lineStart: pending.start,
    lineEnd: pending.start + pending.lines.length,
    mock: false,
    height: posted.height,
    commitment: posted.commitment,
    payloadSha256: posted.payloadSha256,
  });
  writePostLog(cfg.postsPath, log);
  const notes = [
    `Submitted ${pending.lines.length} lines to Mocha (${cfg.namespaceId}).`,
    `height ${posted.height} ${mochaBlobUrl(posted.height, posted.commitment, cfg.namespaceId)}`,
    `commitment ${posted.commitment}`,
  ];
  const helperAddress = "address" in posted && typeof posted.address === "string" ? posted.address : "";
  const helperBalance = "balance" in posted && typeof posted.balance === "string" ? posted.balance : "";
  const helperStderr = "stderr" in posted && typeof posted.stderr === "string" ? posted.stderr : "";
  if (helperAddress) notes.push(`address ${helperAddress}`);
  if (helperBalance) notes.push(`balance ${helperBalance}`);
  for (const line of helperStderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("New Mocha key.") || trimmed.startsWith("Fund this address")) notes.push(trimmed);
  }
  notes.push("Mocha is testnet. This blob is a log, not revenue.");
  return notes;
}

/** What to print when an automatic Mocha post fails. The receipt log is left as it is. */
export function describePostFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = /[.!?]$/.test(raw) ? raw : `${raw}.`;
  if (/insufficient funds/i.test(raw)) {
    return `Mocha post failed: ${detail} Run \`npm run celestia:address\` and fund that celestia1 address at ${MOCHA_FAUCET}. Receipt lines already written were kept. Run \`npm run post\` after that address has faucet TIA.`;
  }
  return `Mocha post failed: ${detail} Receipt lines already written were kept. Run \`npm run post\` to submit unposted lines.`;
}

/**
 * Submit receipt lines that are not in posts.json yet.
 * Logs height and commitment on success. Logs a Mocha failure and does not throw,
 * so a Stripe sale or Houston deposit that already succeeded stays recorded.
 */
export async function postUnpostedReceipts(cfg: Config, deps: ReceiptPostDeps = {}, label = ""): Promise<void> {
  try {
    const notes = await postReceipts(process.env, { fetchImpl: deps.fetchImpl, run: deps.run, cfg });
    for (const note of notes) console.log(note);
  } catch (error) {
    const message = describePostFailure(error);
    console.error(label ? `${label}: ${message}` : message);
  }
}

export async function readReceiptBlob(cfg: Config, height: number, commitment: string, run: HelperRun): Promise<Buffer> {
  const result = await run({
    bin: cfg.celestiaHelper,
    args: getArgs(cfg, height, commitment),
    timeoutMs: 120_000,
  });
  if (result.code !== 0) throw helperFailure(result);
  return result.stdout;
}
