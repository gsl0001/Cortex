import test from "node:test";
import assert from "node:assert/strict";
import { createWriteClient } from "../src/writeClient.js";

function fakeFetch({ ok, status = 200, body = {} }) {
  return async () => ({ ok, status, json: async () => body });
}

test("a non-2xx response throws an error marked isHttpRejection, with the server's message", async () => {
  const client = createWriteClient({
    fetchImpl: fakeFetch({ ok: false, status: 400, body: { error: { message: "message is required" } } }),
  });
  await assert.rejects(
    () => client.capture({ agent: "a", projectPath: ".", message: "" }),
    (error) => {
      assert.equal(error.isHttpRejection, true);
      assert.equal(error.status, 400);
      assert.equal(error.message, "message is required");
      return true;
    },
  );
});

test("a network-level failure throws without isHttpRejection", async () => {
  const client = createWriteClient({
    fetchImpl: async () => { throw new Error("fetch failed"); },
  });
  await assert.rejects(
    () => client.capture({ agent: "a", projectPath: ".", message: "x" }),
    (error) => {
      assert.equal(Boolean(error.isHttpRejection), false);
      return true;
    },
  );
});

test("a 2xx response resolves normally", async () => {
  const client = createWriteClient({
    fetchImpl: fakeFetch({ ok: true, status: 201, body: { action: "accepted" } }),
  });
  const result = await client.capture({ agent: "a", projectPath: ".", message: "x" });
  assert.equal(result.action, "accepted");
});
