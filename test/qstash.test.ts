import test from "node:test";
import assert from "node:assert/strict";
import { deliveryTimestamp } from "../src/lib/scheduling/qstash";

test("QStash delivery is never scheduled before the requested instant", () => {
  const scheduledFor = "2026-07-14T15:50:00.800Z";
  assert.equal(deliveryTimestamp(scheduledFor), 1784044201);
});
