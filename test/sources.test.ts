import test from "node:test";
import assert from "node:assert/strict";
import { focusEvidence, meetsEvidenceBar, sourceTier } from "../src/lib/research/sources";

test("classifies first-party announcements as primary", () => {
  assert.equal(sourceTier("https://ai.meta.com/blog/introducing-muse-spark-meta-model-api"), "primary");
  assert.equal(sourceTier("https://openai.com/index/frontier"), "primary");
  assert.equal(sourceTier("https://nextjs.org/blog/next-16-3"), "primary");
});

test("classifies established press as credible", () => {
  assert.equal(sourceTier("https://www.infoq.com/articles/self-building-agent-langchain4j/"), "credible");
  assert.equal(sourceTier("https://www.securityweek.com/nuclear-sabotage-malware-benchmark/"), "credible");
});

test("leaves aggregators and open platforms unrated", () => {
  assert.equal(sourceTier("https://aimultiple.com/ai-agent-tools"), "unrated");
  assert.equal(sourceTier("https://tech-insider.org/gemini-3-6-flash-launch-2026"), "unrated");
  assert.equal(sourceTier("https://medium.com/@someone/why-agents-matter"), "unrated");
});

test("a model card or a preprint is never first-party evidence on its own", () => {
  for (const url of ["https://huggingface.co/attacker/model", "https://arxiv.org/abs/2609.00001"]) {
    assert.equal(sourceTier(url), "credible", url);
    assert.equal(meetsEvidenceBar([url]), false, url);
  }
  assert.ok(meetsEvidenceBar(["https://github.com/vercel/next.js/releases/tag/v16.3.0", "https://www.theverge.com/2026/9/1/next-16-3"]));
});

test("a repository page is its README, and only a release page is a dated source", () => {
  assert.equal(sourceTier("https://github.com/attacker/anything"), "reference");
  assert.equal(sourceTier("https://github.com/mark3labs/kit"), "reference");
  assert.equal(sourceTier("https://github.com/vercel/next.js/blob/canary/docs/index.md"), "reference");
  assert.equal(sourceTier("https://github.com/vercel/next.js/releases/tag/v16.3.0"), "credible");
  assert.equal(meetsEvidenceBar(["https://github.com/mark3labs/kit", "https://www.infoq.com/news/2026/09/kit/"]), false);
});

test("help centres are reference material and user content is unrated, whatever domain they sit under", () => {
  assert.equal(sourceTier("https://support.anthropic.com/en/articles/9797557-what-is-the-enterprise-plan"), "reference");
  assert.equal(sourceTier("https://help.openai.com/en/articles/6825453-chatgpt-release-notes"), "reference");
  assert.equal(sourceTier("https://support.anthropic.com/en/blog/new-plan"), "primary");
  for (const url of ["https://gist.github.com/someone/abc123", "https://forum.cursor.com/t/effort-levels/1234", "https://community.cloudflare.com/t/workers/99"]) {
    assert.equal(sourceTier(url), "unrated", url);
  }
});

test("a single first-party source clears the bar", () => {
  assert.ok(meetsEvidenceBar(["https://ai.meta.com/blog/introducing-muse-spark-meta-model-api"]));
});

test("two credible publishers clear the bar", () => {
  assert.ok(meetsEvidenceBar([
    "https://www.infoq.com/articles/self-building-agent-langchain4j/",
    "https://www.cnbc.com/2026/07/09/open-ai-sam-altman-chatgpt-5-6-sol.html",
  ]));
});

test("the same article cited twice is not two sources", () => {
  const url = "https://www.infoq.com/articles/self-building-agent-langchain4j/";
  assert.equal(meetsEvidenceBar([url, url]), false);
});

test("two articles from one publisher are not corroboration", () => {
  assert.equal(meetsEvidenceBar([
    "https://www.cnbc.com/2026/07/09/open-ai-sam-altman-chatgpt-5-6-sol.html",
    "https://www.cnbc.com/2026/07/17/moonshot-ai-kimi-k3-model.html",
  ]), false);
});

test("padding with unrated sources does not clear the bar", () => {
  assert.equal(meetsEvidenceBar([
    "https://aimultiple.com/ai-agent-tools",
    "https://tech-insider.org/gemini-3-6-flash-launch-2026",
  ]), false);
});

test("one credible publisher alone does not clear the bar", () => {
  assert.equal(meetsEvidenceBar([
    "https://www.securityweek.com/nuclear-sabotage-malware-benchmark/",
    "https://www.manilatimes.net/2026/07/21/tmt-newswire/pr-newswire/tencent-cloud/2388097",
  ]), false);
});

test("documentation, guides and API references are reference material, never a dated source", () => {
  for (const url of [
    "https://docs.cypress.io/app/component-testing/react/overview",
    "https://nextjs.org/docs/app/api-reference/config/next-config-js",
    "https://react.dev/reference/react/useActionState",
    "https://developer.mozilla.org/en-US/docs/Web/API/View_Transitions_API",
    "https://docs.github.com/en/actions/writing-workflows",
  ]) {
    assert.equal(sourceTier(url), "reference", url);
    assert.equal(meetsEvidenceBar([url]), false, url);
  }
  assert.equal(sourceTier("https://docs.cypress.io/app/references/changelog"), "primary");
  assert.equal(sourceTier("https://react.dev/blog/2026/08/20/react-19-3"), "primary");
  assert.equal(sourceTier("https://developer.chrome.com/blog/new-in-chrome-142"), "primary");
  assert.equal(sourceTier("https://github.com/vercel/next.js/releases/tag/v16.3.0"), "credible");
  assert.equal(sourceTier("https://someblog.dev/docs/thing"), "unrated");
  assert.equal(meetsEvidenceBar(["https://nextjs.org/docs/app", "https://docs.cypress.io/app/get-started"]), false);
  assert.ok(meetsEvidenceBar(["https://nextjs.org/docs/app", "https://nextjs.org/blog/next-16-3"]));
});

test("developer portals and pricing pages are reference material", () => {
  assert.equal(sourceTier("https://developers.cloudflare.com/workers-ai/platform/pricing/"), "reference");
  assert.equal(sourceTier("https://openai.com/api/pricing/"), "reference");
  assert.equal(sourceTier("https://vercel.com/pricing"), "reference");
  assert.equal(sourceTier("https://blog.cloudflare.com/workers-ai-pricing-update/"), "primary");
});

test("the model writes from dated sources and their publishers' reference pages only", () => {
  const blog = { url: "https://blog.cloudflare.com/workers-ai-update/" };
  const docs = { url: "https://developers.cloudflare.com/workers-ai/platform/pricing/" };
  const readme = { url: "https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/PROVIDER_REFERENCE.md" };
  const listicle = { url: "https://aimultiple.com/list" };
  const press = { url: "https://www.infoq.com/news/2026/09/workers-ai/" };
  assert.deepEqual(focusEvidence([listicle, readme, docs, blog, press]), [docs, blog, press]);
  assert.deepEqual(focusEvidence([readme, docs, listicle]), []);
  const release = { url: "https://github.com/vercel/next.js/releases/tag/v16.3.0" };
  assert.deepEqual(focusEvidence([readme, release]), [readme, release]);
});

test("account, sign-in and status portals under a vendor domain count for nothing", () => {
  for (const url of ["https://myaccount.microsoft.com/", "https://accounts.google.com/signin", "https://status.openai.com/incidents/x", "https://login.vercel.com/"]) {
    assert.equal(sourceTier(url), "unrated", url);
  }
  assert.equal(sourceTier("https://microsoft.com/blog/2026/09/announcement"), "primary");
  assert.equal(meetsEvidenceBar(["https://myaccount.microsoft.com/"]), false);
});
