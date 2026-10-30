# google-messages-for-web-mcp

An MCP server (stdio) that reads and sends messages in [Google Messages for web](https://messages.google.com/web/conversations) by driving your already logged-in Chrome tab through the `chromefile` CLI. Not affiliated with Google.

## Requirements

- macOS
- Chrome with [chromefile](https://github.com/whirlwin/chromefile) installed
- A Messages for web tab paired with your phone (one is opened in the background if missing, but pairing is up to you)
- Node >= 24

## Install

As a Claude Code plugin (registers the MCP server for you), inside Claude Code:

```
/plugin install google-messages-for-web-mcp --marketplace whirlwin/google-messages-for-web-mcp
```

On Claude Code versions without `--marketplace`, run `/plugin marketplace add whirlwin/google-messages-for-web-mcp` first, then `/plugin install google-messages-for-web-mcp`. Restart Claude Code and run the `status` tool.

Or as a plain MCP server:

```sh
npm install -g github:whirlwin/google-messages-for-web-mcp
claude mcp add --scope user google-messages -- google-messages-for-web-mcp
```

Set `CHROMEFILE_BIN` if `chromefile` is not on the `PATH` Claude Code sees. Leave `send_message` on per-call approval.

`dist/index.js` is a single esbuild bundle committed to git, because a plugin install copies the repo without running `npm install`. Run `npm run build` after changing `src/`; CI fails when `dist/` does not match.

## Tools

| Tool | Description |
|------|-------------|
| `status` | Is chromefile reachable, is a Messages tab open, is it ready or does it need pairing |
| `list_conversations` | `limit` (default 25): id, name, snippet, time, unread, pinned, muted (read only) |
| `read_messages` | `conversation_id`, `limit` (default 30): last messages in chronological order. Navigates the Messages tab to the conversation, which marks it read |
| `send_message` | `conversation_id`, `text` (max 2000 chars): types into the compose box, presses Enter (a trusted key event via CDP, since the app ignores synthetic clicks), returns `sent: true` once the new bubble appears (not confirmed delivery; see `status`). After an error that says the message may have been sent, do not retry |

## Security

- Incoming SMS and RCS text is untrusted input and can carry prompt injection. Every tool description says so.
- This server combines private data, untrusted content and an outbound send channel. Keep `send_message` behind per-call approval and never auto-approve it.
- Only one Messages for web session is active at a time. This server uses your existing tab and never clicks "Use here" or pairs for you; it returns an error telling you to do it.
- Conversation ids are validated against `^[A-Za-z0-9_-]+$` and all values reach the page as JSON literals, never as raw source.

## How it works

Each tool runs `chromefile call page.eval` against the Messages tab. Sending also uses `chromefile call page.cdp` to dispatch a trusted Enter key in the compose box. The functions in `src/page.ts` run inside the page and are serialised with `fn.toString()`. They rely on the app's `data-e2e-*` attributes and custom elements (`a[data-e2e-conversation]`, `mws-message-wrapper`, the compose box and send button). These selectors are reverse engineered and will break when Google changes the UI.

## Testing

```sh
npm test        # unit tests against a synthetic DOM fixture (happy-dom), no browser needed
npm run lint    # typecheck
```

End-to-end, against your real tab (not part of `npm test`):

```sh
GM_E2E_CONVERSATION=<conversation id> npm run test:e2e
GM_E2E_CONVERSATION=<conversation id> GM_E2E_SEND_TEXT="test" npm run test:e2e   # also sends a real message
```

## Alternatives

[openmessage](https://github.com/maxghenis/openmessage) talks to Google Messages at the protocol level (Go, via mautrix/gmessages libgm, AGPL-3.0) and needs no browser tab.

## License

MIT
