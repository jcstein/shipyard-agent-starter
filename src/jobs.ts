import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Same sentence as the dry-run demo, used when the Checkout Session has no task. */
export const DEFAULT_TASK =
  "In one sentence, pitch a £15–£30 service a small agent could sell to a person or small business for GBP this week. Do not spend money.";

export type JobStatus = "queued" | "running" | "done" | "failed";

export type Job = {
  checkoutId: string;
  stripePaymentId: string | null;
  task: string;
  livemode: boolean;
  /** True when this job must not call Houston or spend TIA. */
  dryRun: boolean;
  status: JobStatus;
  result: string | null;
  error: string | null;
  requestId: string | null;
  createdAt: string;
  finishedAt: string | null;
  /**
   * False once the job result is saved, until the Mocha post attempt finishes.
   * The success page refreshes only while this is false. Absent on older jobs.
   */
  linksReady?: boolean;
};

export type JobLog = {
  version: 1;
  jobs: Job[];
};

export type SessionTaskSource = {
  metadata?: { task?: string } | null;
  custom_fields?: Array<{ key?: string; text?: { value?: string | null } | null }> | null;
};

const TASK_LIMIT = 500;

export function normalizeTask(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

function requireTask(value: string): string {
  const task = normalizeTask(value);
  if (task.length === 0) throw new Error("task is empty");
  if (task.length > TASK_LIMIT) throw new Error(`task must be ${TASK_LIMIT} characters or fewer`);
  return task;
}

/** `--task "…"` or one positional argument. Omitted means the Checkout page asks. */
export function taskFromArgv(argv: string[]): string | null {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  const index = args.indexOf("--task");
  if (index !== -1) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error('Usage: npm run live -- --task "what the agent should do"');
    }
    return requireTask(value);
  }
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) {
    throw new Error('Pass one task: npm run live -- --task "what the agent should do"');
  }
  const only = positional[0];
  return only ? requireTask(only) : null;
}

/** Custom field wins when the customer typed one. Otherwise metadata, otherwise the demo sentence. */
export function taskFromSession(session: SessionTaskSource): string {
  const fields = session.custom_fields ?? [];
  for (const field of fields) {
    if (field.key !== "task") continue;
    const value = normalizeTask(field.text?.value ?? "");
    if (value.length > 0) return value.slice(0, TASK_LIMIT);
  }
  const metadata = normalizeTask(session.metadata?.task ?? "");
  if (metadata.length > 0) return metadata.slice(0, TASK_LIMIT);
  return DEFAULT_TASK;
}

export function emptyJobLog(): JobLog {
  return { version: 1, jobs: [] };
}

export function readJobLog(path: string): JobLog {
  if (!existsSync(path)) return emptyJobLog();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as JobLog;
  if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) throw new Error("unsupported jobs.json version");
  return parsed;
}

export function writeJobLog(path: string, log: JobLog): void {
  const dir = dirname(path);
  if (dir !== "." && dir !== "") mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`);
}

export function readJob(path: string, checkoutId: string): Job | null {
  return readJobLog(path).jobs.find((job) => job.checkoutId === checkoutId) ?? null;
}

export function claimJob(
  path: string,
  input: {
    checkoutId: string;
    stripePaymentId: string | null;
    task: string;
    livemode: boolean;
    dryRun: boolean;
  },
  now = new Date(),
): { job: Job; claimed: boolean } {
  const log = readJobLog(path);
  const existing = log.jobs.find((job) => job.checkoutId === input.checkoutId);
  if (existing) return { job: existing, claimed: false };
  const job: Job = {
    ...input,
    status: "queued",
    result: null,
    error: null,
    requestId: null,
    createdAt: now.toISOString(),
    finishedAt: null,
  };
  log.jobs.push(job);
  writeJobLog(path, log);
  return { job, claimed: true };
}

export function updateJob(path: string, checkoutId: string, patch: Partial<Job>): Job {
  const log = readJobLog(path);
  const job = log.jobs.find((item) => item.checkoutId === checkoutId);
  if (!job) throw new Error(`no job for ${checkoutId}`);
  Object.assign(job, patch);
  writeJobLog(path, log);
  return job;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function revenueLine(livemode: boolean | null): string {
  if (livemode === true) return "Only an outside customer paying in live mode is revenue.";
  return "Test-mode payments are not revenue.";
}

export type SuccessLinks = {
  /** Celenium page for the Mocha blob that includes this checkout. Omit when absent. */
  mochaUrl?: string | null;
  /** Eden Blockscout page for the Houston deposit. Omit when this job did not deposit. */
  edenUrl?: string | null;
};

function explorerLink(label: string, url: string | null | undefined): string {
  if (!url) return "";
  const safe = escapeHtml(url);
  return `<li><a href="${safe}">${escapeHtml(label)}</a></li>`;
}

function explorerList(links: SuccessLinks | undefined): string {
  const items =
    explorerLink("Celenium Mocha blob", links?.mochaUrl) +
    explorerLink("Eden Blockscout", links?.edenUrl);
  return items ? `<ul class="links">${items}</ul>` : "";
}

/** HTML for GET /success. Pending jobs auto-refresh every 2s. */
export function renderSuccess(input: { sessionId: string | null; job: Job | null; links?: SuccessLinks }): string {
  const title = "Payment received";
  if (!input.sessionId) {
    return page(
      title,
      `<h1>${title}</h1><p class="lede">Payment received.</p><p class="meta">${revenueLine(false)}</p>`,
    );
  }
  const job = input.job;
  if (!job || job.status === "queued" || job.status === "running") {
    const task = job
      ? `<section><h2>Task</h2><pre>${escapeHtml(job.task)}</pre></section>`
      : "";
    const mock = job?.dryRun
      ? `<p class="status">This run uses mock inference and spends no TIA.</p>`
      : "";
    return page(
      title,
      `<meta http-equiv="refresh" content="2"><h1>${title}</h1><p class="status">Working on it.</p>${task}${mock}<p class="meta">${revenueLine(job?.livemode === true)}</p>`,
    );
  }
  if (job.status === "failed") {
    return page(
      title,
      `<h1>${title}</h1><p class="status">The job failed. A resent webhook does not run it again.</p><pre class="error">${escapeHtml(job.error ?? "job failed")}</pre><p class="meta">${revenueLine(job.livemode)}</p>`,
    );
  }
  const kind = job.dryRun
    ? "Mock inference. No Houston call was made and no TIA was spent."
    : "Houston inference finished.";
  const waiting =
    job.linksReady === false
      ? `<meta http-equiv="refresh" content="2"><p class="status">Posting the receipt to Mocha.</p>`
      : "";
  const links = explorerList(input.links);
  return page(
    title,
    `${waiting}<h1>${title}</h1><section><h2>Task</h2><pre>${escapeHtml(job.task)}</pre></section><section><h2>Result</h2><pre>${escapeHtml(job.result ?? "")}</pre></section><p class="status">${kind}</p>${links}<p class="meta">${revenueLine(job.livemode)}</p>`,
  );
}

/** Readable workshop page: short labels, wrapped body text, explorers as named links. */
const PAGE_STYLE = [
  "html{color:#111;background:#f6f5f2}",
  "body{box-sizing:border-box;margin:0 auto;padding:2rem 1.25rem 3rem;max-width:40rem;font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;white-space:normal;overflow-wrap:anywhere}",
  "h1{margin:0 0 1rem;font-size:1.75rem;line-height:1.2;letter-spacing:-0.02em}",
  "h2{margin:0 0 0.4rem;font-size:0.75rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#666}",
  "section{margin:1.25rem 0}",
  "pre{box-sizing:border-box;margin:0;padding:0.9rem 1rem;max-width:100%;border:1px solid #e4e2dc;border-radius:0.5rem;background:#fff;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}",
  "pre.error{border-color:#e8c4c4;background:#fff7f7}",
  ".lede,.status{margin:0 0 1rem}",
  ".meta{margin:1.5rem 0 0;color:#666;font-size:0.9rem}",
  "ul.links{margin:1rem 0 0;padding:0;list-style:none;display:grid;gap:0.5rem}",
  "ul.links a{display:inline-block;color:#0b57d0;text-decoration:none;border-bottom:1px solid transparent}",
  "ul.links a:hover{border-bottom-color:currentColor}",
].join("");

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}
