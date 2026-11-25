# Connect My Portal Extension

[My Portal Extension](https://github.com/hatappo/my-portal-ext) is the dedicated Chrome Side Panel companion. Both repositories build independently. The extension retains multiple HTTPS pages, page state, and a screen-sharing blackout control.

## Connect

1. Build/install the extension using its README. Chrome Web Store publication is still pending.
2. Deploy the portal and open its ordinary `/exec` page.
3. Copy **Extension ID** from extension settings and save it under **Settings → Extension → Additional allowed extension ID** in the portal.
4. Register the portal's ordinary deployment URL as a page in the extension. The portal's extension settings also show this URL for selection and copying.

Connection parameters are added internally. A fresh per-frame nonce is generated for the first load or explicit reload; switching to an already-open page preserves it. **Open tab** uses the ordinary URL. No `{nonce}` template or parameter-set configuration is needed. Local preview and `/dev` are not deployed portal connections.

## Import bookmarks into Links

Open a connected portal, then select **Import bookmarks** in the extension’s **More options** header menu. Grant optional bookmark access, select a folder, optionally use its folder names as tags, and choose **Preview additions**. Check the destination and additions before choosing **Add to spreadsheet**.

- Up to 1,000 selected bookmarks, including descendants. Other folders never leave the extension.
- Only HTTP(S) URLs. Compare trimmed URLs exactly; fragments, queries, and path case remain significant.
- Skip URLs found in any existing row, including hidden rows and child/related links, or earlier in the selected batch.
- Add top-level entries with generated IDs. Existing entries are never edited or deleted. Columns are mapped by header name (`id`, `name`, `url` required).
- Values are written as literal strings, not formulas. Sheets appends rows and extends a matching table without overwriting an existing row.
- The destination and URLs are rechecked at confirmation. Imports in the same GAS project are serialized; separate projects and manual edits do not share the lock. Avoid simultaneous imports or header changes.
- Invalidate the user's Links cache and refresh the portal after successful additions. If the response is uncertain, preview again before retrying.

Direct writes use the existing `drive.file` scope, normally for spreadsheets created by this portal. Supplying the ID of an arbitrary spreadsheet does not grant the app write access. No new Google scopes are requested. The extension can export TSV when direct writing is unavailable; after preview it exports only additions. Before preview, the export has not been deduplicated against the spreadsheet.

## Security and deployment

The portal renders its embedding mode only for configured extension IDs. Requests must match the authorized parent origin, parent Window, random nonce, and request ID. The `bookmarks-v1` capability enables only the preview and import RPCs; there is no arbitrary RPC proxy. Google and service credentials remain in GAS. Bookmark payloads are not logged or stored in User Properties.

The readiness message retains its original wire name for deployed-client compatibility. The eight-file GAS output contract and standalone `Authorization.gs` are unchanged.

Moving an unpacked extension to a new checkout path can change its ID and settings storage. Copy registered page URLs before changing directories, load the new extension, and allow its new ID in each portal. Keep the old installation until the replacement works.

Build both projects, reload the unpacked extension, and ship the portal. Browser tests exercise mocked nested GAS frames and confirmation flows; Google sign-in, optional-permission prompts, and actual Sheets writes need a deployed smoke test.

## External navigation header

When an updated extension opens the portal, it adds `header=external` to the internal iframe URL. This is a request to delegate navigation, not unconditional CSS hiding. The portal advertises `navigation-v1` on the authorized extension channel; after the extension has rendered the portal's navigation labels, it sends a connect command. Only then does the portal hide its header. Unsupported hosts or incomplete negotiation keep the normal header; an explicit disconnect restores it.

The extension combines portal navigation, calendar pinning and a dedicated blackout button in one header. Other extension controls are grouped under **More options**; ordinary pages show their page name instead of portal navigation.

The portal owns selected tabs, calendar pinning and localized labels. The extension sends only allowlisted select/pin commands and receives state changes, including internal links and browser history. These messages do not call GAS APIs, reload the document or transfer credentials. Origin, source window and per-frame nonce checks remain mandatory. Regular browser tabs retain the original header.

Loopback previews generated by this repository carry a mock-only marker. When directly embedded by a Chrome extension, they can negotiate navigation using the same protocol. This path does not install the bookmark bridge or grant spreadsheet access. Production GAS requests continue to require the configured extension ID allowlist.
