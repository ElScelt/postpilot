import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { config, proxy } from "../src/proxy";

process.env.AUTOMATION_SECRET = "dashboard-secret";

const dashboard = (authorization?: string) => new NextRequest("https://example.vercel.app/dashboard", {
  headers: authorization ? { authorization } : {},
});

test("the dashboard asks for Basic auth without the secret", () => {
  for (const request of [dashboard(), dashboard(`Basic ${btoa("me:wrong")}`)]) {
    const response = proxy(request);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Basic realm="postpilot dashboard"/);
  }
});

test("the dashboard opens with the secret as the password", () => {
  const response = proxy(dashboard(`Basic ${btoa("anyone:dashboard-secret")}`));
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("only the dashboard sits behind the proxy", () => {
  assert.deepEqual(config.matcher, ["/dashboard", "/dashboard/:path*"]);
});
