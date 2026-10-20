import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blobPayload, fetchReceiptBlob, submitReceiptBlob, v0Namespace } from "../src/celestia.ts";

describe("celestia", () => {
  it("uses a 29-byte v0 namespace", () => {
    const namespace = v0Namespace("shipyardmm");
    assert.equal(namespace.length, 29);
    assert.equal(namespace.subarray(0, 19).every((byte) => byte === 0), true);
    assert.equal(namespace.subarray(19).toString("utf8"), "shipyardmm");
  });

  it("submits a blob and reads the same bytes back", async () => {
    const lines = ['{"type":"human"}'];
    const payload = blobPayload(lines);
    const namespace = v0Namespace("shipyardmm").toString("base64");
    const commitment = Buffer.from("c".repeat(32)).toString("base64");
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test-token");
      if (body.method === "blob.Submit") {
        const blobs = body.params[0] as Array<{ namespace: string; data: string }>;
        assert.equal(blobs[0]?.namespace, namespace);
        assert.equal(Buffer.from(blobs[0]?.data ?? "", "base64").toString("utf8"), payload);
        assert.deepEqual(body.params[1], {});
        return Response.json({ jsonrpc: "2.0", id: 1, result: 1847001 });
      }
      if (body.method === "blob.GetAll") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: [{ namespace, data: Buffer.from(payload).toString("base64"), commitment }],
        });
      }
      if (body.method === "blob.Get") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { namespace, data: Buffer.from(payload).toString("base64"), commitment },
        });
      }
      throw new Error(body.method);
    };
    const posted = await submitReceiptBlob({
      rpcUrl: "http://127.0.0.1:26658",
      token: "test-token",
      namespaceId: "shipyardmm",
      lines,
      fetchImpl,
    });
    assert.equal(posted.height, 1847001);
    const data = await fetchReceiptBlob({
      rpcUrl: "http://127.0.0.1:26658",
      token: "test-token",
      namespaceId: "shipyardmm",
      height: posted.height,
      commitment: posted.commitment,
      fetchImpl,
    });
    assert.equal(data.toString("utf8"), payload);
  });
});
