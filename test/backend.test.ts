import test from "node:test";
import assert from "node:assert/strict";
const FAST = { pollMs: 1, waitMs: 50, confirmMs: 50 };
import { buildExpression, createBackend, pickMessagesTab, validateId, type Call } from "../src/chromefile.ts";

test("validateId accepts ids and rejects injection attempts", () => {
  assert.equal(validateId("abc_-123"), "abc_-123");
  for (const bad of ["", "a b", "a/b", "a'); alert(1);//", "a\n", "../x"]) assert.throws(() => validateId(bad));
});

test("buildExpression escapes quotes and newlines via JSON", () => {
  const nasty = `it's "x"\nline2 \${boom}  `;
  const expr = buildExpression((s: string) => s, nasty);
  const call = expr.slice(expr.indexOf(")(") + 2, -1);
  assert.equal(JSON.parse(call), nasty);
  assert.ok(!call.includes("\n"));
  // The expression is real JS that round-trips the value.
  assert.equal(eval(expr), nasty);
});

test("pickMessagesTab matches by url prefix", () => {
  const tabs = [{ id: 1, url: "https://example.com" }, { id: 2, url: "https://messages.google.com/web/conversations/x" }];
  assert.equal(pickMessagesTab(tabs)?.id, 2);
  assert.equal(pickMessagesTab([tabs[0]!]), undefined);
});

function mock(handlers: Record<string, (p: any) => unknown>) {
  const calls: Array<[string, any]> = [];
  const call: Call = async (m, p) => {
    calls.push([m, p]);
    const h = handlers[m];
    if (!h) throw new Error("unexpected " + m);
    return h(p);
  };
  return { call, calls };
}

test("reuses an existing Messages tab without opening one", async () => {
  const { call, calls } = mock({
    "tabs.list": () => ({ tabs: [{ id: 7, url: "https://messages.google.com/web/conversations" }] }),
    "page.eval": () => ({ value: [] }),
  });
  // First eval is pageState, which must report ready.
  const ready = { url: "u", ready: true, problem: null };
  let n = 0;
  const b = createBackend(async (m, p) => (m === "page.eval" ? (n++ === 0 ? { value: ready } : { value: [] }) : call(m, p)), FAST);
  assert.deepEqual(await b.listConversations(5), []);
  assert.ok(!calls.some(([m]) => m === "tabs.open"));
});

test("opens a background tab when none exists", async () => {
  const { call, calls } = mock({
    "tabs.list": () => ({ tabs: [] }),
    "tabs.open": () => ({ tab: { id: 9, url: "https://messages.google.com/web/conversations" } }),
    "page.eval": () => ({ value: { url: "u", ready: true, problem: null } }),
  });
  await createBackend(call, FAST).status().catch(() => {});
  await createBackend(call, FAST).listConversations(1).catch(() => {});
  const open = calls.find(([m]) => m === "tabs.open");
  assert.deepEqual(open?.[1], { url: "https://messages.google.com/web/conversations", active: false });
});

test("pairing and use-here interstitials give clear errors", async () => {
  for (const [problem, re] of [["in_use_elsewhere", /Use here/], ["needs_pairing", /not paired/]] as const) {
    const { call } = mock({
      "tabs.list": () => ({ tabs: [{ id: 1, url: "https://messages.google.com/web/authentication" }] }),
      "page.eval": () => ({ value: { url: "u", ready: false, problem } }),
    });
    await assert.rejects(createBackend(call, FAST).listConversations(1), re);
  }
});

test("sendMessage rejects empty and oversized text before touching the browser", async () => {
  const { call, calls } = mock({});
  const b = createBackend(call, FAST);
  await assert.rejects(b.sendMessage("abc", "   "), /empty/);
  await assert.rejects(b.sendMessage("abc", "x".repeat(2001)), /2000/);
  assert.equal(calls.length, 0);
});

// Fake page: answers page.eval by the name of the serialised function.
type Fake = Partial<Record<string, (...args: any[]) => unknown>>;
function fakePage(fns: Fake, extra: Record<string, (p: any) => unknown> = {}) {
  const calls: Array<[string, any]> = [];
  const call: Call = async (method, params: any) => {
    calls.push([method, params]);
    if (method === "tabs.list") return { tabs: [{ id: 1, url: "https://messages.google.com/web/conversations" }] };
    if (method === "page.eval") {
      const name = /function (\w+)\(/.exec(params.expression)?.[1] ?? "";
      const h = fns[name];
      if (!h) throw new Error("unexpected eval " + name);
      const args = JSON.parse("[" + params.expression.slice(params.expression.lastIndexOf(")(") + 2, -1) + "]");
      return { value: h(...args) };
    }
    const e = extra[method];
    if (!e) throw new Error("unexpected " + method);
    return e(params);
  };
  return { call, calls };
}
const ready = () => ({ url: "u", ready: true, problem: null });

test("refuses a stale-DOM ready: old thread never satisfies the new one", async () => {
  const stale = { path: "/web/conversations/old", name: "Old", ids: ["1"], compose: true };
  const { call, calls } = fakePage(
    { pageState: ready, threadInfo: () => stale, clickConversation: () => "New" },
    { "tabs.navigate": () => ({}) },
  );
  await assert.rejects(createBackend(call, FAST).readMessages("newid", 5), /Could not open/);
  assert.ok(calls.some(([m]) => m === "tabs.navigate"), "fell back to a full reload");
});

test("name match alone is not enough: ids must change after the click", async () => {
  let path = "/web/conversations/old";
  const { call } = fakePage({
    pageState: ready,
    threadInfo: () => ({ path, name: path.endsWith("old") ? "Old" : "New", ids: path.endsWith("old") ? ["1"] : ["2"], compose: true }),
    clickConversation: () => ((path = "/web/conversations/newid"), "New"),
    readMessages: () => ({ name: "New", messages: [] }),
  });
  const r = await createBackend(call, FAST).readMessages("newid", 5);
  assert.equal(r.name, "New");
});

function sendFake(opts: { sendInPage: (...a: any[]) => unknown; messages: () => unknown[]; cdp?: (p: any) => unknown }) {
  return fakePage(
    {
      pageState: ready,
      threadInfo: () => ({ path: "/web/conversations/abc", name: "Alice Example", ids: ["1"], compose: true }),
      sendInPage: opts.sendInPage,
      readMessages: () => ({ name: "Alice Example", messages: opts.messages() }),
    },
    { "page.cdp": opts.cdp ?? (() => ({ result: {} })) },
  );
}
const msg = (id: string, text: string, outgoing = true) => ({ id, outgoing, text, time: null, rcs: false, has_image: false, status: "Sending" });

test("send succeeds when the last message is new, outgoing and matches", async () => {
  const { call } = sendFake({ sendInPage: () => ({ ready: true }), messages: () => [msg("1", "old", false), msg("2", "hello")] });
  const r: any = await createBackend(call, FAST).sendMessage("abc", "hello");
  assert.equal(r.sent, true);
  assert.equal(r.status, "Sending");
  assert.equal(r.note, undefined);
});

test("send succeeds with a note when the new outgoing text differs", async () => {
  const { call } = sendFake({ sendInPage: () => ({ ready: true }), messages: () => [msg("2", "hello \u{1F600}")] });
  const r: any = await createBackend(call, FAST).sendMessage("abc", "hello :)");
  assert.equal(r.sent, true);
  assert.match(r.note, /differs/);
});

test("an error once Enter is dispatched says the message may have been sent", async () => {
  const typingFails = sendFake({
    sendInPage: () => {
      throw new Error("transport died");
    },
    messages: () => [],
  });
  await assert.rejects(createBackend(typingFails.call, FAST).sendMessage("abc", "hi"), /transport died/);
  const enterFails = sendFake({
    sendInPage: () => ({ ready: true }),
    messages: () => [],
    cdp: () => {
      throw new Error("transport died");
    },
  });
  await assert.rejects(createBackend(enterFails.call, FAST).sendMessage("abc", "hi"), /^Error: The message may have been sent\. Do NOT retry/);
  // Confirmation timeout is also ambiguous.
  const eval2 = sendFake({ sendInPage: () => ({ ready: true }), messages: () => [msg("1", "hi", false)] });
  await assert.rejects(createBackend(eval2.call, FAST).sendMessage("abc", "hi"), /may have been sent/);
});

test("a draft-present refusal is reported as nothing sent", async () => {
  const { call } = sendFake({
    sendInPage: () => ({ ready: false, reason: "The compose box already holds a draft; refusing to overwrite it" }),
    messages: () => [],
  });
  const err = await createBackend(call, FAST).sendMessage("abc", "hi").catch((e: Error) => e);
  assert.match((err as Error).message, /draft.*nothing was sent/);
  assert.doesNotMatch((err as Error).message, /may have been sent/);
});

test("operations are serialised by the mutex", async () => {
  let active = 0;
  let maxActive = 0;
  const call: Call = async (method) => {
    if (method === "tabs.list") {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { tabs: [] };
    }
    throw new Error("stop");
  };
  const b = createBackend(call, FAST);
  await Promise.all([b.status(), b.status(), b.status()]);
  assert.equal(maxActive, 1);
});
