import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { readJob, readJobLog, recoverInterruptedJobs, type JobLog } from "../src/jobs.ts";
import { committedPaymentsWei, reservePayment } from "../src/payments.ts";

function worker(t: TestContext, dir: string, role: string, label: string, id = "", pause = false) {
  const child = fork(new URL("./fixtures/job-race-worker.ts", import.meta.url), [dir, role, label, id, pause ? "pause" : ""], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const message = once(child, "message");
  const exited = once(child, "exit");
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  t.after(() => child.kill("SIGKILL"));
  return { child, message, stop: async () => { child.kill("SIGTERM"); await exited; },
    done: async () => { const [code] = await exited; assert.equal(code, 0, errors); } };
}

async function waitFile(path: string): Promise<void> {
  const deadline = Date.now() + 9000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`missing job race barrier: ${path}`);
    await delay(10);
  }
}

async function pausedRecovery(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "job-race-"));
  const path = join(dir, "jobs.json");
  const old = worker(t, dir, "owner", "old", "X");
  await old.message; await old.stop();
  const active = worker(t, dir, "owner", "active", "Y");
  await active.message;
  const recovery = worker(t, dir, "recover", "recovery", "", true);
  await waitFile(join(dir, "paused-recovery.json"));
  const pending = JSON.parse(readFileSync(join(dir, "paused-recovery.json"), "utf8")) as JobLog;
  assert.equal(pending.jobs.find(job => job.checkoutId === "X")?.status, "failed");
  // Recovery queried Y's real owner and did not include Y among abandoned candidates.
  assert.equal(pending.jobs.find(job => job.checkoutId === "Y")?.status, "running");
  assert.equal(pending.jobs.find(job => job.checkoutId === "Y")?.result, null);
  return { dir, path, active, recovery };
}

test("completion and a new claim survive recovery paused immediately before rename", { timeout: 15000 }, async (t) => {
  const { dir, path, active, recovery } = await pausedRecovery(t);
  const completed = once(active.child, "message"); active.child.send("complete");
  const claimant = worker(t, dir, "claim", "claimant", "Z");
  await Promise.all([waitFile(join(dir, "contended-active")), waitFile(join(dir, "contended-claimant"))]);
  assert.equal(readJob(path, "Y")?.status, "running");
  assert.equal(readJob(path, "Z"), null);
  writeFileSync(join(dir, "resume-recovery"), "resume");
  await recovery.done();
  assert.deepEqual((await completed)[0], { type: "completed" });
  assert.deepEqual((await claimant.message)[0], { type: "claimed", claimed: true });
  await claimant.done();
  assert.equal(readJob(path, "X")?.status, "failed");
  assert.equal(readJob(path, "Y")?.status, "done");
  assert.equal(readJob(path, "Y")?.result, "saved");
  assert.equal(readJob(path, "Y")?.linksReady, true);
  assert.equal(readJob(path, "Z")?.status, "queued");
  assert.equal(readJobLog(path).jobs.length, 3);
  await active.stop();
});

test("two processes cannot both claim a checkout at the late rename boundary", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "job-claim-race-"));
  const first = worker(t, dir, "claim", "first", "same", true);
  await waitFile(join(dir, "paused-first.json"));
  const second = worker(t, dir, "claim", "second", "same");
  await waitFile(join(dir, "contended-second"));
  writeFileSync(join(dir, "resume-first"), "resume");
  assert.deepEqual((await first.message)[0], { type: "claimed", claimed: true });
  assert.deepEqual((await second.message)[0], { type: "claimed", claimed: false });
  await Promise.all([first.done(), second.done()]);
  assert.equal(readJobLog(join(dir, "jobs.json")).jobs.length, 1);
});

test("a killed journal writer requires explicit lock recovery and preserves reservations", { timeout: 15000 }, async (t) => {
  const { dir, path, active, recovery } = await pausedRecovery(t);
  await recovery.stop(); await active.stop();
  const receiptsPath = join(dir, "receipts.jsonl");
  reservePayment(receiptsPath, { paymentId: `0x${"11".repeat(32)}`, amountWei: "42", txHash: `0x${"22".repeat(32)}` });
  const before = readFileSync(path, "utf8");
  await assert.rejects(recoverInterruptedJobs(path), /Locked:.*jobs\.json\.lock/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(committedPaymentsWei(receiptsPath), 42n);
  // The operator has stopped all writers and inspected the journal before removing its lock.
  rmSync(`${path}.lock`);
  await recoverInterruptedJobs(path);
  assert.equal(readJob(path, "X")?.status, "failed");
  assert.equal(readJob(path, "Y")?.status, "failed");
  assert.equal(committedPaymentsWei(receiptsPath), 42n);
});
