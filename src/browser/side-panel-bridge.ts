import { allowedPanelAncestor, READY_MESSAGE } from './side-panel-protocol';
let parentOrigin: string | undefined;
/** Reject unauthorized embedding before mounting controls or starting any RPCs. */
export function allowSidePanel(): boolean {
  parentOrigin = undefined;
  const ids = document.querySelector<HTMLMetaElement>('meta[name="portal-extensions"]')?.content;
  if (ids === undefined) return true;
  const ancestors = Array.from(location.ancestorOrigins || []);
  if (!allowedPanelAncestor(ancestors, ids.split(','))) {
    document.body.replaceChildren(document.createTextNode(PortalI18n.t('Open this portal in its configured extension or in a browser tab.', document.documentElement.lang)));
    document.getElementById('side-panel-guard')?.remove();
    return false;
  }
  parentOrigin = ancestors[ancestors.length - 1];
  document.getElementById('side-panel-guard')?.remove();
  return true;
}
export function notifySidePanelReady() {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="portal-panel-nonce"]')?.content;
  if (parentOrigin && nonce && /^[a-f0-9]{32}$/.test(nonce)) {
    installBookmarkBridge(parentOrigin, nonce);
    window.top?.postMessage({ type: READY_MESSAGE, nonce, capabilities: ['bookmarks-v1'] }, parentOrigin);
  }
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
