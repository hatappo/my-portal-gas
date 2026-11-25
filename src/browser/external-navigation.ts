import type { initializeNavigation } from './navigation.js';
export type PortalNavigation = ReturnType<typeof initializeNavigation>;
export type PanelConnection = { origin: string; nonce: string; external: boolean; preview: boolean };

/** Navigation is an explicitly negotiated, UI-only capability. No arbitrary URLs or RPCs. */
export function installExternalNavigation(connection: PanelConnection, navigation: PortalNavigation) {
  let attached = false;
  const header = document.querySelector<HTMLElement>('.site-header');
  const snapshot = () => ({ ...navigation.snapshot(), attached });
  const send = () => window.top?.postMessage({ type: 'my-portal:navigation-state', nonce: connection.nonce, state: snapshot() }, connection.origin);
  const restore = () => {
    attached = false;
    if (header) header.hidden = false;
    delete document.documentElement.dataset.externalNavigation;
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.top || event.origin !== connection.origin || event.data?.nonce !== connection.nonce || event.data.type !== 'my-portal:navigation-command') return;
    const { action, tab, pinned } = event.data;
    if (action === 'connect') {
      attached = true;
      if (header) header.hidden = true;
      document.documentElement.dataset.externalNavigation = 'true';
      send();
    } else if (action === 'disconnect') { restore(); send(); }
    else if (attached && action === 'select' && typeof tab === 'string') navigation.select(tab);
    else if (attached && action === 'pin' && typeof pinned === 'boolean') navigation.calendar.pin(pinned);
  };
  window.addEventListener('message', receive);
  const unsubscribe = navigation.subscribe(() => { if (attached) send(); });
  window.addEventListener('pagehide', restore);
  return { snapshot, dispose() { restore(); unsubscribe(); window.removeEventListener('message', receive); window.removeEventListener('pagehide', restore); } };
}
