import { test } from "node:test";
import assert from "node:assert/strict";
import { requestId } from "../src/request-id";

test("HTTP contexts without randomUUID still generate distinct UUIDv4 request IDs", () => {
  const httpCrypto = {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  } as Pick<Crypto, "randomUUID" | "getRandomValues">;
  const ids = Array.from({ length: 100 }, () => requestId(httpCrypto));
  assert.equal(new Set(ids).size, ids.length);
  for (const value of ids) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
