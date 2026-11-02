import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readPostLog, recordMockPost, writePostLog } from "../src/celestia.ts";
import { fulfillCheckout, successExplorerLinks } from "../src/fulfill.ts";
import { readJob, renderSuccess } from "../src/jobs.ts";
import { postReceipts } from "../src/mocha.ts";
import { committedPaymentsWei, readPayments } from "../src/payments.ts";
import { appendReceipt, findByCheckout, readReceiptLines } from "../src/receipts.ts";
import { runDemo } from "../src/run.ts";
import { startWebhook } from "../src/stripe.ts";
import { config, deferred, fresh, helper, houston, job, json } from "./recovery-helpers.ts";

for (const failure of ["timeout", "html", "send"] as const) {
  test(`keeps a durable deposit reservation after ${failure} and refuses overspending`, async () => {
    const cfg = config(); const quote = await fresh(); const mock = houston(quote, { failure });
    const current = job(cfg, `cs_${failure}`);
    await fulfillCheckout(cfg, current, mock.fetchImpl);
    assert.equal(readJob(cfg.jobsPath, current.checkoutId)?.status, "failed");
    assert.ok(findByCheckout(cfg.receiptsPath, "inference", current.checkoutId)?.type === "inference");
    const amount = BigInt(quote.accepted.amount) + 3000n;
    assert.equal(committedPaymentsWei(cfg.receiptsPath), amount);
    assert.equal(readPayments(cfg.receiptsPath).reservations.length, 1);
    const second = houston(await fresh());
    await fulfillCheckout(cfg, job(cfg, `cs_after_${failure}`), second.fetchImpl);
    assert.equal(second.calls.filter((url) => url.endsWith("/deposit/send")).length, 0);
    assert.equal(committedPaymentsWei(cfg.receiptsPath), amount);
  });
}

test("overlapping checkout jobs share the cap, including reserved gas", async () => {
  const cfg = config(); const gate = deferred(); const sent = deferred();
  const firstMock = houston(await fresh(), { paidGate: gate, onSend: sent.resolve });
  const secondMock = houston(await fresh()); const post = helper();
  const firstJob = job(cfg, "cs_first"); const secondJob = job(cfg, "cs_second");
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
  const server = startWebhook(cfg, { runJob: async () => { runs++; } }); server.close();
  const saved = readJob(cfg.jobsPath, "cs_interrupted");
  assert.equal(saved?.status, "failed"); assert.equal(runs, 0);
  const page = renderSuccess({ sessionId: "cs_interrupted", job: saved });
  assert.match(page, /interrupted/); assert.doesNotMatch(page, /http-equiv="refresh"/);
});

test("another process and an interrupted deposit both fail closed with the reservation intact", { timeout: 10000 }, async (t) => {
  const worker = await interruptedWorker(t, "deposit"); const cfg = config({ SPEND_CAP_TIA: "0.1" }, worker.dir);
  const amount = committedPaymentsWei(cfg.receiptsPath);
  assert.equal(amount, 30000000000003000n);
  assert.equal(findByCheckout(cfg.receiptsPath, "inference", "cs_interrupted"), null);
  const mock = houston(await fresh());
  await fulfillCheckout(cfg, job(cfg, "cs_other"), mock.fetchImpl);
  assert.equal(mock.calls.filter((url) => url.endsWith("/deposit/send")).length, 0);
  assert.match(readJob(cfg.jobsPath, "cs_other")?.error ?? "", /Locked:/);
  await worker.stop();
  const restarted = startWebhook(cfg); restarted.close();
  assert.equal(readJob(cfg.jobsPath, "cs_interrupted")?.status, "failed");
  assert.equal(committedPaymentsWei(cfg.receiptsPath), amount);
  assert.match(readFileSync(`${cfg.receiptsPath}.payment.lock`, "utf8"), /pid/);
});

test("catch-up publication ends an interrupted posting page and preserves its result", { timeout: 10000 }, async (t) => {
  const worker = await interruptedWorker(t, "post"); await worker.stop();
  const cfg = config({}, worker.dir); const post = helper();
  const server = startWebhook(cfg); server.close();
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

test("dry-run and legacy mixed mocks leave live receipts eligible for catch-up", async () => {
  const cfg = config(); const mock = houston(await fresh());
  await fulfillCheckout(cfg, job(cfg, "cs_unposted"), mock.fetchImpl, { run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "mock outage" }) });
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
  assert.match(post.payloads[0]![0]!, /cs_unposted/);
  await postReceipts({}, { cfg, run: post.run }); assert.equal(post.payloads.length, 2);
});
