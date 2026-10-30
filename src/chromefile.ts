import { execFile } from "node:child_process";
import * as page from "./page.ts";

export const MESSAGES_PREFIX = "https://messages.google.com/web";
export const CONVERSATIONS_URL = "https://messages.google.com/web/conversations";
export const MAX_TEXT = 2000;

export type Call = (method: string, params?: object) => Promise<any>;
type Tab = { id: number; url: string };

export function validateId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid conversation_id");
  return id;
}

// User values travel only as JSON literals, never as raw source text.
export function buildExpression(fn: (...args: any[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
}

export function makeCall(bin = process.env.CHROMEFILE_BIN || "chromefile"): Call {
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      execFile(bin, ["call", method, JSON.stringify(params)], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          const detail = stderr.trim() || err.message;
          reject(new Error(code === "ENOENT" ? `chromefile not found (${bin}); set CHROMEFILE_BIN` : `chromefile ${method} failed: ${detail}`));
          return;
        }
        try {
          resolve(stdout.trim() === "" ? {} : JSON.parse(stdout));
        } catch {
          reject(new Error(`chromefile ${method} returned invalid JSON`));
        }
      });
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function pickMessagesTab(tabs: Tab[]): Tab | undefined {
  return tabs.find((t) => t.url.startsWith(MESSAGES_PREFIX));
}

// Every operation drives the same tab and compose box, so run them one at a time.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const MAY_HAVE_SENT = "The message may have been sent. Do NOT retry; call read_messages to check.";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export type Options = { pollMs?: number; waitMs?: number; confirmMs?: number };

export function createBackend(call: Call, { pollMs = 500, waitMs = 20_000, confirmMs = 15_000 }: Options = {}) {
  const evalIn = async <T>(tabId: number, fn: (...args: any[]) => unknown, ...args: unknown[]): Promise<T> =>
    (await call("page.eval", { tabId, expression: buildExpression(fn, ...args), awaitPromise: true })).value as T;

  async function until<T>(timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T | undefined> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await probe();
      if (v !== undefined) return v;
      if (Date.now() >= end) return undefined;
      await sleep(pollMs);
    }
  }

  // Page is mid-reload or mid-render: eval errors are transient while polling.
  const transient = async <T>(fn: () => Promise<T | undefined>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  const problemText = (p: page.PageState["problem"]) =>
    p === "in_use_elsewhere"
      ? 'Messages for web is open in another window. Click "Use here" in the Messages tab, then retry.'
      : "Messages for web is not paired. Pair it by scanning the QR code in the Messages tab (Google Messages app > Device pairing), then retry.";

  async function waitReady(tabId: number): Promise<void> {
    let last: page.PageState | undefined;
    let lastErr: unknown;
    const ok = await until(waitMs, async () => {
      try {
        last = await evalIn<page.PageState>(tabId, page.pageState);
      } catch (e) {
        lastErr = e;
        return undefined;
      }
      if (last.ready) return true;
      if (last.problem) throw new Error(problemText(last.problem));
      return undefined;
    });
    if (!ok) throw new Error(`Messages for web did not become ready within ${waitMs / 1000}s (url: ${last?.url ?? "unknown"}${lastErr ? `, last error: ${(lastErr as Error).message}` : ""})`);
  }

  async function ensureTab(): Promise<number> {
    const { tabs } = await call("tabs.list", {});
    const candidates = (tabs as Tab[]).filter((t) => t.url.startsWith(MESSAGES_PREFIX));
    let tab = candidates[0];
    if (candidates.length > 1) {
      // Several tabs: prefer the one that is actually loaded and paired.
      for (const c of candidates) {
        const s = await transient(() => evalIn<page.PageState>(c.id, page.pageState));
        if (s?.ready) {
          tab = c;
          break;
        }
      }
    }
    if (!tab) {
      // Background tab: do not steal focus from the user.
      tab = (await call("tabs.open", { url: CONVERSATIONS_URL, active: false })).tab as Tab;
    }
    await waitReady(tab.id);
    return tab.id;
  }

  const info = (tabId: number) => evalIn<page.ThreadInfo>(tabId, page.threadInfo);

  // Resolves to the thread's header name and message ids once the thread is the
  // requested one and stable. Never trusts DOM that may belong to the previous thread.
  async function openConversation(tabId: number, rawId: string): Promise<{ name: string; ids: string[] }> {
    const id = validateId(rawId);
    const path = "/web/conversations/" + id;
    const before = await info(tabId);
    const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    let expected: string | null = null;

    if (before.path === path && before.name !== "") {
      expected = before.name;
    } else {
      const clicked = await evalIn<string | null>(tabId, page.clickConversation, id);
      if (clicked) {
        const ok = await until(Math.min(waitMs, 8000), () =>
          transient(async () => {
            const now = await info(tabId);
            return now.path === path && now.name === clicked && !sameIds(now.ids, before.ids) ? true : undefined;
          }),
        );
        if (ok) expected = clicked;
      }
      if (!expected) {
        // Full reload: no stale DOM can survive it.
        await call("tabs.navigate", { tabId, url: `${CONVERSATIONS_URL}/${id}` });
        await waitReady(tabId);
        const nav = await until(waitMs, () =>
          transient(async () => {
            const now = await info(tabId);
            return now.path === path && now.name !== "" && (now.ids.length > 0 || now.compose) ? now.name : undefined;
          }),
        );
        if (!nav) throw new Error(`Could not open conversation ${id}`);
        expected = nav;
      }
    }

    // Stable: the same ids on two consecutive probes.
    let prev: string[] | undefined;
    const stable = await until(waitMs, () =>
      transient(async () => {
        const now = await info(tabId);
        if (now.path !== path || now.name !== expected) {
          prev = undefined;
          return undefined;
        }
        const done = prev !== undefined && sameIds(prev, now.ids);
        prev = now.ids;
        return done ? now : undefined;
      }),
    );
    if (!stable) throw new Error(`Conversation ${id} did not settle`);
    return { name: stable.name, ids: stable.ids };
  }

  async function status() {
    let tabs: Tab[];
    try {
      tabs = (await call("tabs.list", {})).tabs;
    } catch (e) {
      return { chromefile: false, error: (e as Error).message };
    }
    const tab = pickMessagesTab(tabs);
    if (!tab) return { chromefile: true, tab_open: false, state: "no_tab" };
    const s = await evalIn<page.PageState>(tab.id, page.pageState);
    return { chromefile: true, tab_open: true, url: s.url, state: s.ready ? "ready" : (s.problem ?? "loading") };
  }

  async function listConversations(limit: number) {
    const tabId = await ensureTab();
    return evalIn<page.Conversation[]>(tabId, page.listConversations, limit);
  }

  async function readMessages(conversationId: string, limit: number) {
    const tabId = await ensureTab();
    await openConversation(tabId, conversationId);
    const r = await evalIn<{ name: string; messages: page.Message[] }>(tabId, page.readMessages, limit);
    return { conversation_id: conversationId, ...r };
  }

  // The app ignores synthetic clicks on its send button; a trusted Enter in the
  // focused compose box (left focused by sendInPage) sends, even in a background tab.
  async function pressEnter(tabId: number): Promise<void> {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await call("page.cdp", { tabId, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", ...key } });
    await call("page.cdp", { tabId, method: "Input.dispatchKeyEvent", params: { type: "char", text: "\r", ...key } });
    await call("page.cdp", { tabId, method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...key } });
  }

  async function sendMessage(conversationId: string, text: string) {
    if (text.trim() === "") throw new Error("text must not be empty");
    if (text.length > MAX_TEXT) throw new Error(`text exceeds ${MAX_TEXT} characters`);
    const id = validateId(conversationId);
    const tabId = await ensureTab();
    const { name, ids } = await openConversation(tabId, id);
    const before = new Set(ids);

    const r = await evalIn<{ ready?: boolean; reason?: string }>(tabId, page.sendInPage, id, name, text);
    if (!r.ready) throw new Error(`${r.reason ?? "Not sent"}; nothing was sent`);
    // From here on any error may hide a send that went through.
    try {
      await pressEnter(tabId);
      const sent = await until(confirmMs, () =>
        transient(async () => {
          const { messages } = await evalIn<{ messages: page.Message[] }>(tabId, page.readMessages, 20);
          const last = messages[messages.length - 1];
          return last && last.outgoing && !before.has(last.id) ? last : undefined;
        }),
      );
      if (!sent) throw new Error(`No new outgoing message appeared within ${confirmMs / 1000}s`);
      // `sent` means the bubble appeared, not that delivery was confirmed; see `status`.
      const matches = sent.text !== null && norm(sent.text) === norm(text);
      return {
        sent: true,
        message: sent,
        status: sent.status,
        ...(matches ? {} : { note: "The new outgoing message text differs from what was typed (emoji or segmentation); check read_messages" }),
      };
    } catch (e) {
      throw new Error(`${MAY_HAVE_SENT} (${(e as Error).message})`);
    }
  }

  return {
    status: () => serialize(status),
    listConversations: (limit: number) => serialize(() => listConversations(limit)),
    readMessages: (id: string, limit: number) => serialize(() => readMessages(id, limit)),
    sendMessage: (id: string, text: string) => serialize(() => sendMessage(id, text)),
  };
}
