import { Window } from "happy-dom";

// Synthetic structure mirroring Messages for web; names are invented.
export const FIXTURE = `
<mw-conversations-list>
  <a data-e2e-conversation href="/web/conversations/abc123" data-e2e-is-unread="true" data-e2e-is-pinned="false" data-e2e-is-muted="false">
    <span data-e2e-conversation-name>Alice Example</span>
    <mws-conversation-snippet> See you   at 8 </mws-conversation-snippet>
    <mws-relative-timestamp>20:32</mws-relative-timestamp>
  </a>
  <a data-e2e-conversation href="/web/conversations/def_456-x" data-e2e-is-unread="false" data-e2e-is-pinned="true" data-e2e-is-muted="true">
    <span data-e2e-conversation-name>Bob Sample</span>
    <mws-conversation-snippet>Thanks</mws-conversation-snippet>
    <mws-relative-timestamp>Mon</mws-relative-timestamp>
  </a>
  <a data-e2e-conversation href="/somewhere/else"><span data-e2e-conversation-name>Skipped</span></a>
</mw-conversations-list>
<mw-conversation-header>Alice Example</mw-conversation-header>
<mws-tombstone-message-wrapper> 16:42 </mws-tombstone-message-wrapper>
<mws-message-wrapper msg-id="15601" is-outgoing="false">
  <div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true" data-e2e-message-id="15601">
    <div data-e2e-text-message-content>Hello there</div>
    <mws-absolute-timestamp>20:30</mws-absolute-timestamp>
  </div>
</mws-message-wrapper>
<mws-message-wrapper msg-id="15602" is-outgoing="true">
  <div data-e2e-message-wrapper-core data-e2e-message-outgoing="true" data-e2e-message-rcs="false" data-e2e-message-id="15602">
    <div data-e2e-text-message-content>Hi "Alice"</div>
    <div data-e2e-message-status>20:31</div>
  </div>
</mws-message-wrapper>
<mws-message-wrapper msg-id="15603" is-outgoing="false">
  <div data-e2e-message-wrapper-core data-e2e-message-outgoing="false" data-e2e-message-rcs="true" data-e2e-message-id="15603">
    <mws-image-message-part></mws-image-message-part>
  </div>
</mws-message-wrapper>
<div data-e2e-message-input-box contenteditable="true"></div>
<button data-e2e-send-text-button class="mat-mdc-button-disabled"></button>
`;

// The page functions read bare globals, so expose the fixture window as them.
export function installDom(html: string, url = "https://messages.google.com/web/conversations"): void {
  const win = new Window({ url });
  win.document.body.innerHTML = html;
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.location = win.location;
  g.history = win.history;
  g.PopStateEvent = win.PopStateEvent;
  g.dispatchEvent = win.dispatchEvent.bind(win);
}
