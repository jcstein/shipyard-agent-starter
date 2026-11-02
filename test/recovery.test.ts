import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readPostLog, recordMockPost, writePostLog } from "../src/celestia.ts";
import { fulfillCheckout, successExplorerLinks } from "../src/fulfill.ts";
import { claimJob, readJob, recoverInterruptedJobs, renderSuccess, updateJob } from "../src/jobs.ts";
import { postReceipts } from "../src/mocha.ts";
import { committedPaymentsWei, readPayments } from "../src/payments.ts";
import { appendReceipt, findByCheckout, readReceiptLines } from "../src/receipts.ts";
import { runDemo } from "../src/run.ts";
import { startWebhook } from "../src/stripe.ts";
import { config, deferred, fresh, helper, houston, job, json } from "./recovery-helpers.ts";

for (const failure of ["timeout", "html", "send"] as const) {
  test(`keeps a durable deposit reservation after ${failure} and refuses overspending`, async () => {
    const cfg = config(); const quote = await fresh(); const mock = houston(quote, { failure });
    const current = await job(cfg, `cs_${failure}`);
    await fulfillCheckout(cfg, current, mock.fetchImpl);
    assert.equal(readJob(cfg.jobsPath, current.checkoutId)?.status, "failed");
    assert.ok(findByCheckout(cfg.receiptsPath, "inference", current.checkoutId)?.type === "inference");
    const amount = BigInt(quote.accepted.amount) + 3000n;
    assert.equal(committedPaymentsWei(cfg.receiptsPath), amount);
    assert.equal(readPayments(cfg.receiptsPath).reservations.length, 1);
    const second = houston(await fresh());
    await fulfillCheckout(cfg, await job(cfg, `cs_after_${failure}`), second.fetchImpl);
    assert.equal(second.calls.filter((url) => url.endsWith("/deposit/send")).length, 0);
    assert.equal(committedPaymentsWei(cfg.receiptsPath), amount);
  });
}

test("overlapping checkout jobs share the cap, including reserved gas", async () => {
  const cfg = config(); const gate = deferred(); const sent = deferred();
  const firstMock = houston(await fresh(), { paidGate: gate, onSend: sent.resolve });
  const secondMock = houston(await fresh()); const post = helper();
  const firstJob = await job(cfg, "cs_first"); const secondJob = await job(cfg, "cs_second");
  const first = fulfillCheckout(cfg, firstJob, firstMock.fetchImpl, { run: post.run });
  await sent.promise;
  const second = fulfillCheckout(cfg, secondJob, secondMock.fetchImpl, { run: post.run });
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(readJob(cfg.jobsPath, firstJob.checkoutId)?.status, "done");
  assert.equal(readJob(cfg.jobsPath, secondJob.checkoutId)?.status, "failed");
  assert.match(readJob(cfg.jobsPath, secondJob.checkoutId)?.error ?? "", /spend cap/);
  assert.equal(secondMock.calls.filter((url) => url.endsWith("/deposit/send")).length, 0);
  assert.equal(committedPaymentsWei(cfg.receiptsPath), 30000000000003000n);
});

async function interruptedWorker(t: TestContext, phase: string) {
  const dir = mkdtempSync(join(tmpdir(), "interrupted-"));
  const child = fork(new URL("./fixtures/interrupted-worker.ts", import.meta.url), [dir, phase], {
    env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  t.after(() => { child.kill("SIGKILL"); });
  const [message] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => { throw new Error(`worker exited early: ${errors}`); }),
  ]);
  assert.equal(message, phase);
  return { dir, child, stop: async () => { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } };
}

test("restart marks an interrupted checkout failed without replaying it", { timeout: 10000 }, async (t) => {
  const worker = await interruptedWorker(t, "quote"); await worker.stop();
  const cfg = config({}, worker.dir); let runs = 0;
  const server = await startWebhook(cfg, { runJob: async () => { runs++; } }); server.close();
  const saved = readJob(cfg.jobsPath, "cs_interrupted");
  assert.equal(saved?.status, "failed"); assert.equal(runs, 0);
  const page = renderSuccess({ sessionId: "cs_interrupted", job: saved });
  assert.match(page, /interrupted/); assert.doesNotMatch(page, /http-equiv="refresh"/);
});

test("recovery preserves queued, running, and publishing jobs owned by this instance", async () => {
  const cfg = config();
  for (const status of ["queued", "running", "done"] as const) {
    const current = await job(cfg, `cs_active_${status}`);
    await updateJob(cfg.jobsPath, current.checkoutId, { status, linksReady: false });
    await recoverInterruptedJobs(cfg.jobsPath);
    assert.equal(readJob(cfg.jobsPath, current.checkoutId)?.status, status);
    assert.equal(readJob(cfg.jobsPath, current.checkoutId)?.linksReady, false);
  }
});

test("a live instance survives recovery but reused PIDs and mismatched tokens do not", { timeout: 10000 }, async (t) => {
  const active = await interruptedWorker(t, "quote");
  const activeCfg = config({}, active.dir);
  const old = await interruptedWorker(t, "quote"); await old.stop();
  const oldCfg = config({}, old.dir);
  const original = readJob(oldCfg.jobsPath, "cs_interrupted")!;
  for (const pid of [process.pid, active.child.pid!]) {
    await updateJob(oldCfg.jobsPath, original.checkoutId, { status: "running", ownerPid: pid });
    await recoverInterruptedJobs(oldCfg.jobsPath);
    assert.equal(readJob(oldCfg.jobsPath, original.checkoutId)?.status, "failed");
    assert.equal((await claimJob(oldCfg.jobsPath, original)).claimed, false);
  }
  // A reachable endpoint must prove the exact instance, not just that some worker exists.
  const owner = readJob(activeCfg.jobsPath, "cs_interrupted")!.owner!;
  await updateJob(oldCfg.jobsPath, original.checkoutId, { status: "running", owner: { ...owner, token: "wrong-instance" } });
  await recoverInterruptedJobs(oldCfg.jobsPath);
  assert.equal(readJob(oldCfg.jobsPath, original.checkoutId)?.status, "failed");
  await recoverInterruptedJobs(activeCfg.jobsPath);
  assert.equal(readJob(activeCfg.jobsPath, "cs_interrupted")?.status, "running");
  await active.stop();
});

test("ambiguous legacy owners stop startup without failing active work or replaying payment", { timeout: 10000 }, async (t) => {
  const worker = await interruptedWorker(t, "quote");
  const cfg = config(); const legacy = await job(cfg, "cs_legacy");
  await updateJob(cfg.jobsPath, legacy.checkoutId, { owner: undefined, ownerPid: worker.child.pid, status: "running" });
  let runs = 0;
  await assert.rejects(startWebhook(cfg, { runJob: async () => { runs++; } }), /Cannot verify legacy job owner.*Stop older webhook workers/);
  assert.equal(readJob(cfg.jobsPath, legacy.checkoutId)?.status, "running");
  assert.equal(runs, 0);
  // Explicit legacy migration after operator review; do not kill an unrelated reused PID.
  await updateJob(cfg.jobsPath, legacy.checkoutId, { ownerPid: undefined });
  await recoverInterruptedJobs(cfg.jobsPath);
  assert.equal(readJob(cfg.jobsPath, legacy.checkoutId)?.status, "failed");
  await updateJob(cfg.jobsPath, legacy.checkoutId, { ownerPid: worker.child.pid, status: "running" });
  await worker.stop();
  await recoverInterruptedJobs(cfg.jobsPath);
  assert.equal(readJob(cfg.jobsPath, legacy.checkoutId)?.status, "failed");
  await updateJob(cfg.jobsPath, legacy.checkoutId, { ownerPid: process.pid, status: "running" });
  await recoverInterruptedJobs(cfg.jobsPath);
  assert.equal(readJob(cfg.jobsPath, legacy.checkoutId)?.status, "failed");
});

test("an unresponsive owner aborts recovery without failing a possibly active job", { timeout: 10000 }, async (t) => {
  const cfg = config(); const current = await job(cfg, "cs_unresponsive");
  const path = join(mkdtempSync(join(tmpdir(), "owner-")), "owner.sock");
  const server = createServer((socket) => { socket.on("error", () => {}); t.after(() => socket.destroy()); });
  server.listen(path); await once(server, "listening"); t.after(() => server.close());
  await updateJob(cfg.jobsPath, current.checkoutId, { status: "running", owner: { token: "silent", socketPath: path } });
  await assert.rejects(recoverInterruptedJobs(cfg.jobsPath), /Could not verify the job owner/);
  assert.equal(readJob(cfg.jobsPath, current.checkoutId)?.status, "running");
});

test("recovery preserves completion written while ownership is being checked", async (t) => {
  const cfg = config(); const current = await job(cfg, "cs_finished_during_recovery");
  const path = join(mkdtempSync(join(tmpdir(), "owner-")), "owner.sock");
  const server = createServer(async (socket) => {
    await updateJob(cfg.jobsPath, current.checkoutId, { status: "done", linksReady: true, result: "saved" });
    socket.end("different-instance\n");
  });
  server.listen(path); await once(server, "listening"); t.after(() => server.close());
  await updateJob(cfg.jobsPath, current.checkoutId, { status: "running", owner: { token: "old", socketPath: path } });
  await recoverInterruptedJobs(cfg.jobsPath);
  assert.equal(readJob(cfg.jobsPath, current.checkoutId)?.status, "done");
  assert.equal(readJob(cfg.jobsPath, current.checkoutId)?.result, "saved");
});

test("another process and an interrupted deposit both fail closed with the reservation intact", { timeout: 10000 }, async (t) => {
  const worker = await interruptedWorker(t, "deposit"); const cfg = config({ SPEND_CAP_TIA: "0.1" }, worker.dir);
  const amount = committedPaymentsWei(cfg.receiptsPath);
  assert.equal(amount, 30000000000003000n);
  assert.equal(findByCheckout(cfg.receiptsPath, "inference", "cs_interrupted"), null);
  const mock = houston(await fresh());
  await fulfillCheckout(cfg, await job(cfg, "cs_other"), mock.fetchImpl);
  assert.equal(mock.calls.filter((url) => url.endsWith("/deposit/send")).length, 0);
  assert.match(readJob(cfg.jobsPath, "cs_other")?.error ?? "", /Locked:/);
  await worker.stop();
  const restarted = await startWebhook(cfg); restarted.close();
  assert.equal(readJob(cfg.jobsPath, "cs_interrupted")?.status, "failed");
  assert.equal(committedPaymentsWei(cfg.receiptsPath), amount);
  assert.match(readFileSync(`${cfg.receiptsPath}.payment.lock`, "utf8"), /pid/);
});

test("catch-up publication ends an interrupted posting page and preserves its result", { timeout: 10000 }, async (t) => {
  const worker = await interruptedWorker(t, "post"); await worker.stop();
  const cfg = config({}, worker.dir); const post = helper();
  const server = await startWebhook(cfg); server.close();
  const before = readJob(cfg.jobsPath, "cs_interrupted");
  assert.equal(before?.status, "done"); assert.match(before?.postError ?? "", /interrupted/);
  await assert.rejects(postReceipts({}, { cfg, run: post.run }), /Locked:/);
  assert.equal(post.payloads.length, 0);
  // Explicit operator recovery after stopping the old writer and checking its submission.
  rmSync(`${cfg.postsPath}.lock`);
  await postReceipts({}, { cfg, run: post.run });
  const after = readJob(cfg.jobsPath, "cs_interrupted");
  const page = renderSuccess({ sessionId: "cs_interrupted", job: after, links: successExplorerLinks(cfg, "cs_interrupted") });
  assert.equal(after?.result, before?.result);
  assert.match(page, /Celenium Mocha blob/); assert.doesNotMatch(page, /http-equiv="refresh"|publication was interrupted/);
  // Also reconcile an old linksReady=false record directly from the persisted publication.
  assert.doesNotMatch(renderSuccess({ sessionId: "cs_interrupted", job: { ...after!, linksReady: false }, links: successExplorerLinks(cfg, "cs_interrupted") }), /http-equiv="refresh"/);
});

test("concurrent posts preserve disjoint records and retries submit nothing twice", async () => {
  const cfg = config(); const post = helper(); const entered = deferred(); const release = deferred();
  appendReceipt(cfg.receiptsPath, { type: "human", who: "test", what: "first", why: "test" });
  const first = postReceipts({}, { cfg, run: async (request) => { entered.resolve(); await release.promise; return post.run(request); } });
  await entered.promise;
  appendReceipt(cfg.receiptsPath, { type: "human", who: "test", what: "second", why: "test" });
  const second = postReceipts({}, { cfg, run: post.run });
  release.resolve(); await Promise.all([first, second]);
  assert.deepEqual(readPostLog(cfg.postsPath, cfg.namespaceId).posts.map((p) => [p.lineStart, p.lineEnd]), [[0, 1], [1, 2]]);
  assert.deepEqual(post.payloads.map((lines) => lines.length), [1, 1]);
  await postReceipts({}, { cfg, run: post.run }); assert.equal(post.payloads.length, 2);
});

for (const mode of ["live", "dry-run"] as const) test(`legacy mixed mocks preserve ${mode} checkout receipts and exclude standalone demo lines`, async () => {
  const cfg = config({ DEMO_MODE: mode }); const mock = houston(await fresh());
  await fulfillCheckout(cfg, await job(cfg, "cs_unposted"), mock.fetchImpl, { run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "mock outage" }) });
  const fixture = readFileSync(new URL("./fixtures/payment-required.json", import.meta.url), "utf8");
  await runDemo({ ...cfg, mode: "dry-run", privateKey: null }, async () => json({}, 402, { "payment-required": Buffer.from(fixture).toString("base64") }));
  const current = readPostLog(cfg.postsPath, cfg.namespaceId);
  assert.deepEqual(current.posts.map((p) => [p.lineStart, p.lineEnd]), [[2, 5]]);
  // Reproduce the pre-fix format as well: one mock accidentally covered real and demo receipts.
  const legacy = { ...current, posts: [] };
  recordMockPost(legacy, readReceiptLines(cfg.receiptsPath), 0); writePostLog(cfg.postsPath, legacy);
  appendReceipt(cfg.receiptsPath, { type: "human", who: "test", what: "new", why: "test" });
  const post = helper(); await postReceipts({}, { cfg, run: post.run });
  assert.deepEqual(post.payloads.map((lines) => lines.length), [2, 1]);
  assert.deepEqual(post.payloads[0]!.map((line) => JSON.parse(line).type), ["sale", "inference"]);
  assert.equal(JSON.parse(post.payloads[0]![1]!).dryRun, mode === "dry-run");
  assert.ok(successExplorerLinks(cfg, "cs_unposted").mochaUrl);
  assert.match(post.payloads[0]![0]!, /cs_unposted/);
  await postReceipts({}, { cfg, run: post.run }); assert.equal(post.payloads.length, 2);
});
