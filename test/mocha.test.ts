import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { blobPayload, readPostLog, v0Namespace, writePostLog } from "../src/celestia.ts";
import { MOCHA_PUBLIC_CORE_GRPC, MOCHA_PUBLIC_RPC } from "../src/eden.ts";
import { sha256Hex } from "../src/hash.ts";
import { describePostFailure, getArgs, mochaBlobUrl, postReceipts, submitArgs, type HelperRun } from "../src/mocha.ts";
import { loadConfig } from "../src/config.ts";
import { verifyReceipts } from "../src/verify.ts";

function humanLine(): string {
  return JSON.stringify({
    type: "human",
    ts: "2026-10-21T00:00:00.000Z",
    prev: "0".repeat(64),
    who: "ada",
    what: "noted",
    why: "test",
  });
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "mocha-"));
  return {
    RECEIPTS_PATH: join(dir, "receipts.jsonl"),
    POSTS_PATH: join(dir, "posts.json"),
    CELESTIA_HELPER: join(dir, "missing-helper"),
    CELESTIA_KEYRING: join(dir, "keys"),
  };
}

describe("mocha helper", () => {
  it("links a posted blob on Celenium", () => {
    const commitment = Buffer.from("c".repeat(32)).toString("base64");
    const url = new URL(mochaBlobUrl(1847001, commitment, "shipyardmm"));
    assert.equal(url.origin, "https://mocha.celenium.io");
    assert.equal(url.pathname, "/blob");
    assert.equal(url.searchParams.get("height"), "1847001");
    assert.equal(url.searchParams.get("commitment"), commitment);
    assert.equal(url.searchParams.get("hash"), v0Namespace("shipyardmm").toString("base64"));
  });

  it("points an insufficient-funds failure at celestia:address and the faucet", () => {
    const text = describePostFailure(
      new Error(
        "insufficient funds: celestia1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7y7k3e balance 0utia. Fund this address at https://mocha.celenium.io/faucet",
      ),
    );
    assert.match(text, /insufficient funds/);
    assert.match(text, /npm run celestia:address/);
    assert.match(text, /https:\/\/mocha\.celenium\.io\/faucet/);
    assert.match(text, /npm run post/);
    assert.match(text, /already written were kept/);
  });

  it("submits receipt bytes through the helper and records the commitment", async () => {
    const env = paths();
    const line = humanLine();
    writeFileSync(env.RECEIPTS_PATH, `${line}\n`);
    const payload = blobPayload([line]);
    let seen: { args: string[]; stdin?: Buffer } | undefined;
    const run: HelperRun = async (request) => {
      seen = { args: request.args, stdin: request.stdin };
      return {
        code: 0,
        stdout: Buffer.from(
          `${JSON.stringify({
            height: 1847001,
            commitment: Buffer.from("c".repeat(32)).toString("base64"),
            address: "celestia1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7y7k3e",
            balance: "1000000utia",
          })}\n`,
        ),
        stderr: "New Mocha key. Mnemonic saved to /tmp/keys/shipyard.mnemonic\n",
      };
    };
    const notes = await postReceipts(env, { run });
    assert.equal(seen?.stdin?.toString("utf8"), payload);
    assert.deepEqual(seen?.args, submitArgs(loadConfig(env)));
    assert.equal(seen?.args.includes("shipyardmm"), true);
    assert.equal(seen?.args.includes(MOCHA_PUBLIC_RPC), true);
    assert.equal(seen?.args.includes(MOCHA_PUBLIC_CORE_GRPC), true);
    const commitment = Buffer.from("c".repeat(32)).toString("base64");
    assert.equal(notes.join("\n").includes(`height 1847001 ${mochaBlobUrl(1847001, commitment, "shipyardmm")}`), true);
    assert.match(notes.join("\n"), /not revenue/);
    assert.match(notes.join("\n"), /Mnemonic saved/);
    const log = readPostLog(env.POSTS_PATH, "shipyardmm");
    assert.equal(log.posts.length, 1);
    assert.equal(log.posts[0]?.mock, false);
    assert.equal(log.posts[0]?.height, 1847001);
    assert.equal(log.posts[0]?.payloadSha256, sha256Hex(payload));
  });

  it("does not record a post when the helper reports insufficient funds", async () => {
    const env = paths();
    writeFileSync(env.RECEIPTS_PATH, `${humanLine()}\n`);
    const run: HelperRun = async () => ({
      code: 1,
      stdout: Buffer.alloc(0),
      stderr:
        "insufficient funds: celestia1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7y7k3e balance 0utia. Fund this address at https://mocha.celenium.io/faucet\n",
    });
    await assert.rejects(() => postReceipts(env, { run }), /insufficient funds/);
    assert.equal(existsSync(env.POSTS_PATH), false);
  });

  it("keeps the light-node JSON-RPC path when CELESTIA_RPC_URL is set", async () => {
    const env = { ...paths(), CELESTIA_RPC_URL: "http://127.0.0.1:26658", CELESTIA_AUTH_TOKEN: "test-token" };
    const line = humanLine();
    writeFileSync(env.RECEIPTS_PATH, `${line}\n`);
    const payload = blobPayload([line]);
    const namespace = Buffer.alloc(29);
    Buffer.from("shipyardmm").copy(namespace, 19);
    const commitment = Buffer.from("c".repeat(32)).toString("base64");
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test-token");
      if (body.method === "blob.Submit") {
        const blobs = body.params[0] as Array<{ namespace: string; data: string; share_version: number }>;
        assert.equal(blobs[0]?.namespace, namespace.toString("base64"));
        assert.equal(Buffer.from(blobs[0]?.data ?? "", "base64").toString("utf8"), payload);
        assert.equal(blobs[0]?.share_version, 0);
        return Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
      }
      if (body.method === "blob.GetAll") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: [{ data: Buffer.from(payload).toString("base64"), commitment }],
        });
      }
      throw new Error(body.method);
    };
    const run: HelperRun = async () => {
      throw new Error("light-node path must not spawn the helper");
    };
    const notes = await postReceipts(env, { fetchImpl, run });
    assert.equal(notes.join("\n").includes(`height 42 ${mochaBlobUrl(42, commitment, "shipyardmm")}`), true);
    assert.equal(readPostLog(env.POSTS_PATH, "shipyardmm").posts[0]?.mock, false);
  });

  it("verifies a real post by reading the helper stdout bytes", async () => {
    const env = paths();
    const line = humanLine();
    writeFileSync(env.RECEIPTS_PATH, `${line}\n`);
    const payload = blobPayload([line]);
    const commitment = Buffer.from("c".repeat(32)).toString("base64");
    const log = readPostLog(env.POSTS_PATH, "shipyardmm");
    log.posts.push({
      at: "2026-10-21T00:00:00.000Z",
      lineStart: 0,
      lineEnd: 1,
      mock: false,
      height: 42,
      commitment,
      payloadSha256: sha256Hex(payload),
    });
    writePostLog(env.POSTS_PATH, log);
    let sawGet = false;
    const run: HelperRun = async (request) => {
      assert.deepEqual(request.args, getArgs(loadConfig(env), 42, commitment));
      sawGet = true;
      return { code: 0, stdout: Buffer.from(payload), stderr: "" };
    };
    const notes = await verifyReceipts(env, async () => {
      throw new Error("helper path must not use fetch");
    }, run);
    assert.equal(sawGet, true);
    assert.equal(
      notes.join("\n").includes(`Mocha height 42, commitment ${commitment} ${mochaBlobUrl(42, commitment, "shipyardmm")}`),
      true,
    );
    assert.match(notes.join("\n"), /not revenue/);
  });

  it("does not spawn the helper for a mock post", async () => {
    const env = paths();
    const line = humanLine();
    writeFileSync(env.RECEIPTS_PATH, `${line}\n`);
    const payload = blobPayload([line]);
    const log = readPostLog(env.POSTS_PATH, "shipyardmm");
    log.posts.push({
      at: "2026-10-21T00:00:00.000Z",
      lineStart: 0,
      lineEnd: 1,
      mock: true,
      height: null,
      commitment: null,
      payloadSha256: sha256Hex(payload),
    });
    writePostLog(env.POSTS_PATH, log);
    const notes = await verifyReceipts(
      env,
      async () => {
        throw new Error("mock verify must not fetch");
      },
      async () => {
        throw new Error("mock verify must not spawn the helper");
      },
    );
    assert.match(notes.join("\n"), /Mocha was not queried/);
    assert.equal(notes.join("\n").includes("/blob?"), false);
    assert.equal(readFileSync(env.POSTS_PATH, "utf8").includes('"mock": true'), true);
  });
});
