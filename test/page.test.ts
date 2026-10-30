import test from "node:test";
import assert from "node:assert/strict";
import * as page from "../src/page.ts";
import { FIXTURE, installDom } from "./fixture.ts";

test("listConversations parses items and honours limit", () => {
  installDom(FIXTURE);
  const all = page.listConversations(25);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { id: "abc123", name: "Alice Example", snippet: "See you at 8", time: "20:32", unread: true, pinned: false, muted: false });
  assert.deepEqual([all[1]?.id, all[1]?.pinned, all[1]?.muted, all[1]?.unread], ["def_456-x", true, true, false]);
  assert.equal(page.listConversations(1).length, 1);
});

test("readMessages parses incoming, outgoing, image-only and skips tombstones", () => {
  installDom(FIXTURE);
  const r = page.readMessages(30);
  assert.equal(r.name, "Alice Example");
  assert.equal(r.messages.length, 3);
  assert.deepEqual(r.messages[0], { id: "15601", outgoing: false, text: "Hello there", time: "20:30", rcs: true, has_image: false, status: null });
  assert.deepEqual(r.messages[1], { id: "15602", outgoing: true, text: 'Hi "Alice"', time: "20:31", rcs: false, has_image: false, status: "20:31" });
  assert.deepEqual(r.messages[2], { id: "15603", outgoing: false, text: null, time: null, rcs: true, has_image: true, status: null });
  assert.deepEqual(page.readMessages(2).messages.map((m) => m.id), ["15602", "15603"]);
});

test("pageState detects ready and interstitials", () => {
  installDom(FIXTURE);
  assert.equal(page.pageState().ready, true);
  installDom("<div>Messages is open in another window. Use here</div>");
  assert.equal(page.pageState().problem, "in_use_elsewhere");
  installDom("<div>Scan this QR code</div>");
  assert.equal(page.pageState().problem, "needs_pairing");
});

test("clickConversation returns the item name and never fakes navigation", () => {
  installDom(FIXTURE);
  assert.equal(page.clickConversation("abc123"), "Alice Example");
  installDom(FIXTURE);
  assert.equal(page.clickConversation("zzz"), null);
  assert.equal(location.pathname, "/web/conversations");
});

test("threadInfo reports path, header name and ids", () => {
  installDom(FIXTURE, "https://messages.google.com/web/conversations/abc123");
  const t = page.threadInfo();
  assert.deepEqual([t.path, t.name, t.ids, t.compose], ["/web/conversations/abc123", "Alice Example", ["15601", "15602", "15603"], true]);
});

test("sendInPage refuses a wrong conversation and an existing draft", () => {
  installDom(FIXTURE, "https://messages.google.com/web/conversations/abc123");
  assert.match(page.sendInPage("other", "Alice Example", "hi").reason ?? "", /not the requested/);
  assert.match(page.sendInPage("abc123", "Bob Sample", "hi").reason ?? "", /not the requested/);
  document.querySelector("[data-e2e-message-input-box]")!.textContent = "my unsent draft";
  const r = page.sendInPage("abc123", "Alice Example", "hi");
  assert.equal(r.clicked, false);
  assert.match(r.reason ?? "", /draft/);
  assert.equal(document.querySelector("[data-e2e-message-input-box]")!.textContent, "my unsent draft");
});
