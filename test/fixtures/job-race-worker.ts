import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { claimJob, recoverInterruptedJobs, updateJob } from "../../src/jobs.ts";

globalThis.fetch = async () => { throw new Error("real network disabled in job race test"); };
const [dir, role, label, id, pause] = process.argv.slice(2) as [string, string, string, string, string];
const path = join(dir, "jobs.json");
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;

// Report actual lock contention, so the controller never relies on scheduling delays.
fs.writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
  try { return originalWrite(...args); }
  catch (error) {
    if (args[0] === `${path}.lock` && (error as NodeJS.ErrnoException).code === "EEXIST") {
      originalWrite(join(dir, `contended-${label}`), "waiting");
    }
    throw error;
  }
};
fs.renameSync = (from, to) => {
  if (to === path && pause === "pause") {
    // Pause after the final read and flushed temp write, immediately before commit.
    const marker = join(dir, `paused-${label}.json`);
    originalWrite(`${marker}.tmp`, fs.readFileSync(from));
    originalRename(`${marker}.tmp`, marker);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(join(dir, `resume-${label}`))) {
      if (Date.now() > deadline) throw new Error("job rename barrier timed out");
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  originalRename(from, to);
};
syncBuiltinESMExports();

if (role === "owner" || role === "claim") {
  const result = await claimJob(path, { checkoutId: id, stripePaymentId: null, task: "local race test", livemode: false, dryRun: true });
  if (role === "claim") {
    process.send?.({ type: "claimed", claimed: result.claimed });
    process.disconnect?.();
  } else {
    await updateJob(path, id, { status: "running", linksReady: false });
    process.on("message", (message) => {
      if (message !== "complete") return;
      void updateJob(path, id, { status: "done", result: "saved", linksReady: true }).then(
        () => process.send?.({ type: "completed" }),
        (error: Error) => process.send?.({ type: "error", message: error.message }),
      );
    });
    process.send?.({ type: "ready" });
  }
} else if (role === "recover") {
  await recoverInterruptedJobs(path);
  process.disconnect?.();
} else {
  throw new Error(`Unexpected job race role: ${role}`);
}
