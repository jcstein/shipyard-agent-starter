import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Same sentence as the dry-run demo, used when the Checkout Session has no task. */
export const DEFAULT_TASK =
  "In one sentence, name a service a small agent could sell to a person for GBP. Do not spend money.";

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
      throw new Error('Usage: npm run checkout -- --task "what the agent should do"');
    }
    return requireTask(value);
  }
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) {
    throw new Error('Pass one task: npm run checkout -- --task "what the agent should do"');
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

/** HTML for GET /success. A missing or unfinished job asks the browser to refresh. */
export function renderSuccess(input: { sessionId: string | null; job: Job | null }): string {
  const title = "Payment received";
  if (!input.sessionId) {
    return page(title, `<h1>${title}</h1><p>Payment received.</p><p>${revenueLine(false)}</p>`);
  }
  const job = input.job;
  if (!job || job.status === "queued" || job.status === "running") {
    const task = job ? `<p>Task</p><pre>${escapeHtml(job.task)}</pre>` : "";
    const mock = job?.dryRun ? "<p>This run uses mock inference and spends no TIA.</p>" : "";
    return page(
      title,
      `<meta http-equiv="refresh" content="2"><h1>${title}</h1><p>Working on it. Refresh this page.</p>${task}${mock}<p>${revenueLine(job?.livemode === true)}</p>`,
    );
  }
  if (job.status === "failed") {
    return page(
      title,
      `<h1>${title}</h1><p>The job failed. A resent webhook does not run it again.</p><pre>${escapeHtml(job.error ?? "job failed")}</pre><p>${revenueLine(job.livemode)}</p>`,
    );
  }
  const kind = job.dryRun
    ? "Mock inference. No Houston call was made and no TIA was spent."
    : "Houston inference finished.";
  return page(
    title,
    `<h1>${title}</h1><p>Task</p><pre>${escapeHtml(job.task)}</pre><p>Result</p><pre>${escapeHtml(job.result ?? "")}</pre><p>${kind}</p><p>${revenueLine(job.livemode)}</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;
}
