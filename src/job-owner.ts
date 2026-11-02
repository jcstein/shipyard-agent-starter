import { randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type JobOwner = { token: string; socketPath: string };
let current: Promise<JobOwner> | undefined;

/** The kernel closes this endpoint on exit; a reused PID cannot answer for the old instance. */
export function currentJobOwner(): Promise<JobOwner> {
  current ??= new Promise((resolve, reject) => {
    const token = randomUUID();
    const socketPath = join(tmpdir(), `sy-${token}.sock`);
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.setTimeout(3000, () => socket.destroy());
      socket.end(`${token}\n`);
    });
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.unref();
      process.once("exit", () => server.close());
      resolve({ token, socketPath });
    });
  });
  return current;
}

/** Uncertain liveness aborts recovery instead of failing a possibly active job. */
export async function jobOwnerIsRunning(owner: JobOwner): Promise<boolean> {
  if (current) {
    const self = await current;
    if (self.token === owner.token && self.socketPath === owner.socketPath) return true;
  }
  return new Promise((resolve, reject) => {
    const socket = connect(owner.socketPath);
    let answer = "";
    const uncertain = () => {
      socket.destroy();
      reject(new Error("Could not verify the job owner. Stop other webhook workers and restart before recovering jobs; no payment was retried."));
    };
    socket.setTimeout(3000, uncertain);
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString();
      if (answer.length > 100) uncertain();
    });
    socket.once("end", () => {
      socket.destroy();
      resolve(answer === `${owner.token}\n`);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else uncertain();
    });
  });
}
