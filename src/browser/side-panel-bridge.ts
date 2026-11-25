import { allowedPanelAncestor, READY_MESSAGE } from './side-panel-protocol';
import { installExternalNavigation, type PortalNavigation, type PanelConnection } from './external-navigation';
let parentOrigin: string | undefined;
let connection: PanelConnection | undefined;
/** Reject unauthorized embedding before mounting controls or starting any RPCs. */
export function allowSidePanel(): boolean {
  parentOrigin = undefined;
  connection = undefined;
  const ids = document.querySelector<HTMLMetaElement>('meta[name="portal-extensions"]')?.content;
  if (ids === undefined) {
    // Only mock previews on loopback hosts can negotiate navigation without the GAS allowlist.
    const local = location.hostname === 'localhost' || location.hostname.endsWith('.localhost') || location.hostname === '127.0.0.1';
    const query = new URLSearchParams(location.search);
    const ancestors = Array.from(location.ancestorOrigins || []);
    if (local && document.querySelector('meta[name="portal-preview"][content="true"]') && query.get('header') === 'external' &&
      /^[a-f0-9]{32}$/.test(query.get('panelNonce') || '') && ancestors.length === 1 && /^chrome-extension:\/\/[a-p]{32}$/.test(ancestors[0])) {
      connection = { origin: ancestors[0], nonce: query.get('panelNonce')!, external: true, preview: true };
    }
    return true;
  }
  const ancestors = Array.from(location.ancestorOrigins || []);
  if (!allowedPanelAncestor(ancestors, ids.split(','))) {
    document.body.replaceChildren(document.createTextNode(PortalI18n.t('Open this portal in its configured extension or in a browser tab.', document.documentElement.lang)));
    document.getElementById('side-panel-guard')?.remove();
    return false;
  }
  parentOrigin = ancestors[ancestors.length - 1];
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="portal-panel-nonce"]')?.content || '';
  if (/^[a-f0-9]{32}$/.test(nonce)) connection = { origin: parentOrigin, nonce, external: document.querySelector<HTMLMetaElement>('meta[name="portal-header"]')?.content === 'external', preview: false };
  document.getElementById('side-panel-guard')?.remove();
  return true;
}
export function notifySidePanelReady(navigation?: PortalNavigation) {
  if (!connection) return;
  const { origin, nonce, preview, external } = connection;
  const capabilities = [];
  if (!preview) { installBookmarkBridge(origin, nonce); capabilities.push('bookmarks-v1'); }
  const bridge = external && navigation ? installExternalNavigation(connection, navigation) : undefined;
  if (bridge) capabilities.push('navigation-v1');
  window.top?.postMessage({ type: READY_MESSAGE, nonce, capabilities, navigation: bridge?.snapshot() }, origin);
}

let bookmarkBridgeInstalled = false;
function installBookmarkBridge(origin: string, nonce: string) {
  if (bookmarkBridgeInstalled) return;
  bookmarkBridgeInstalled = true;
  let busy = false;
  window.addEventListener('message', event => {
    if (event.source !== window.top || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.type !== 'my-portal:bookmarks-request' || data.nonce !== nonce ||
      typeof data.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(data.requestId) ||
      !['preview', 'import'].includes(data.operation)) return;
    const reply = (result: unknown) => window.top?.postMessage({
      type: 'my-portal:bookmarks-response', nonce, requestId: data.requestId, result,
    }, origin);
    if (busy) { reply({ ok: false, error: 'BOOKMARK_BUSY' }); return; }
    try {
      if (!data.payload || !Array.isArray(data.payload.bookmarks) || data.payload.bookmarks.length > 1000 || JSON.stringify(data.payload).length > 1000000) throw new Error('Invalid payload');
    } catch { reply({ ok: false, error: 'BOOKMARK_INVALID_INPUT' }); return; }
    busy = true;
    const finish = (result: {ok?: boolean, added?: number}) => {
      busy = false;
      reply(result);
      if (data.operation === 'import' && result.ok && result.added) document.dispatchEvent(new Event('portal:bookmarks-imported'));
    };
    try {
      const runner = google.script.run.withSuccessHandler(finish)
        .withFailureHandler(() => { busy = false; reply({ ok: false, error: 'BOOKMARK_REQUEST_FAILED' }); });
      if (data.operation === 'preview') runner.previewBookmarkImport(data.payload);
      else runner.importBookmarks(data.payload);
    } catch { busy = false; reply({ ok: false, error: 'BOOKMARK_REQUEST_FAILED' }); }
  });
}
