// Page-side functions. Each one is serialised with fn.toString() and run in the
// Messages tab via page.eval, so every function must be fully self-contained:
// no imports, no references to other module-level names, no closures.

export type PageState = {
  url: string;
  ready: boolean;
  problem: "needs_pairing" | "in_use_elsewhere" | null;
};

export type Conversation = {
  id: string;
  name: string;
  snippet: string;
  time: string;
  unread: boolean;
  pinned: boolean;
  muted: boolean;
};

export type Message = {
  id: string;
  outgoing: boolean;
  text: string | null;
  time: string | null;
  rcs: boolean;
  has_image: boolean;
  status: string | null;
};

export function pageState(): PageState {
  const text = (document.body?.innerText ?? "").toLowerCase();
  const ready = document.querySelector("a[data-e2e-conversation]") !== null;
  let problem: PageState["problem"] = null;
  if (!ready) {
    if (text.includes("use here") || text.includes("open in another window")) {
      problem = "in_use_elsewhere";
    } else if (
      location.pathname.includes("/authentication") ||
      document.querySelector("mw-qr-code, mw-authentication-container") !== null ||
      text.includes("qr code")
    ) {
      problem = "needs_pairing";
    }
  }
  return { url: location.href, ready, problem };
}

export function listConversations(limit: number): Conversation[] {
  const out: Conversation[] = [];
  for (const a of Array.from(document.querySelectorAll("a[data-e2e-conversation]"))) {
    if (out.length >= limit) break;
    const href = a.getAttribute("href") ?? "";
    const m = /\/web\/conversations\/([A-Za-z0-9_-]+)/.exec(href);
    if (!m) continue;
    const t = (sel: string) =>
      (a.querySelector(sel) as HTMLElement | null)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    out.push({
      id: m[1] as string,
      name: t("[data-e2e-conversation-name]"),
      snippet: t("mws-conversation-snippet"),
      time: t("mws-relative-timestamp"),
      unread: a.getAttribute("data-e2e-is-unread") === "true",
      pinned: a.getAttribute("data-e2e-is-pinned") === "true",
      muted: a.getAttribute("data-e2e-is-muted") === "true",
    });
  }
  return out;
}

export function readMessages(limit: number): { name: string; messages: Message[] } {
  const header = (document.querySelector("mw-conversation-header") as HTMLElement | null)?.innerText ?? "";
  const name = header.split("\n")[0]?.trim() ?? "";
  const messages: Message[] = [];
  // Tombstones (date separators) are different elements, so this selector skips them.
  for (const w of Array.from(document.querySelectorAll("mws-message-wrapper"))) {
    const core = w.querySelector("[data-e2e-message-wrapper-core]");
    const textEl = w.querySelector("[data-e2e-text-message-content]") as HTMLElement | null;
    const timeEl = w.querySelector("mws-absolute-timestamp, [data-e2e-message-status]") as HTMLElement | null;
    const text = textEl ? (textEl.innerText ?? textEl.textContent ?? "").trim() : "";
    messages.push({
      id: w.getAttribute("msg-id") ?? core?.getAttribute("data-e2e-message-id") ?? "",
      outgoing: w.getAttribute("is-outgoing") === "true",
      text: text === "" ? null : text,
      time: timeEl ? (timeEl.textContent ?? "").replace(/\s+/g, " ").trim() || null : null,
      rcs: core?.getAttribute("data-e2e-message-rcs") === "true",
      has_image: w.querySelector("mws-image-message-part") !== null,
      status: (w.querySelector("[data-e2e-message-status]") as HTMLElement | null)?.innerText?.trim() || null,
    });
  }
  return { name, messages: messages.slice(-limit) };
}

export type ThreadInfo = { path: string; name: string; ids: string[]; compose: boolean };

export function threadInfo(): ThreadInfo {
  const header = (document.querySelector("mw-conversation-header") as HTMLElement | null)?.innerText ?? "";
  return {
    path: location.pathname,
    name: header.split("\n")[0]?.trim() ?? "",
    ids: Array.from(document.querySelectorAll("mws-message-wrapper")).map((w) => w.getAttribute("msg-id") ?? ""),
    compose: document.querySelector('[data-e2e-message-input-box][contenteditable="true"]') !== null,
  };
}

// Real SPA navigation. Returns the list item's name (the expected header), or null
// when the item is not in the list; there is deliberately no pushState fallback,
// because the Angular router can leave the previous thread's DOM in place.
export function clickConversation(id: string): string | null {
  const link = document.querySelector('a[data-e2e-conversation][href="/web/conversations/' + id + '"]') as HTMLElement | null;
  if (!link) return null;
  const name = (link.querySelector("[data-e2e-conversation-name]") as HTMLElement | null)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  link.click();
  return name || null;
}

// Types, verifies and clicks in a single eval so nothing can change in between.
export async function sendInPage(
  id: string,
  expectedName: string,
  text: string,
): Promise<{ ready: boolean; reason?: string }> {
  const header = (document.querySelector("mw-conversation-header") as HTMLElement | null)?.innerText ?? "";
  if (location.pathname !== "/web/conversations/" + id || header.split("\n")[0]?.trim() !== expectedName) {
    return { ready: false, reason: "The open conversation is not the requested one" };
  }
  const box = document.querySelector('[data-e2e-message-input-box][contenteditable="true"]') as HTMLElement | null;
  if (!box) return { ready: false, reason: "Compose box not found" };
  const read = () => (box.innerText ?? box.textContent ?? "").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  if (read().trim() !== "") return { ready: false, reason: "The compose box already holds a draft; refusing to overwrite it" };
  const sendBtn = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("[data-e2e-send-text-button]")).find(
      (b) => b.getClientRects().length > 0,
    );
  box.focus();
  // insertText fires the input events the Angular app listens to.
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    if (i > 0) document.execCommand("insertLineBreak", false);
    if (line !== "") document.execCommand("insertText", false, line);
  });
  // Angular enables the send button on its next change detection, not synchronously.
  let btn = sendBtn();
  let enabled = false;
  for (let i = 0; i < 20; i++) {
    btn = sendBtn();
    enabled = !!btn && !btn.disabled && !btn.classList.contains("mat-mdc-button-disabled");
    if (enabled) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (read() !== text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ") || !enabled) {
    // The box was empty before, so clearing removes only what we typed.
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    return { ready: false, reason: "Could not enter the text into the compose box" };
  }
  // A synthetic click is ignored by the app, so the backend sends a trusted Enter via CDP.
  return { ready: true };
}
