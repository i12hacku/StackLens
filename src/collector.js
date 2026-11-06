/**
 * Runs inside the inspected page (MAIN world) via chrome.scripting.executeScript.
 * MUST be fully self-contained: it is serialized with Function#toString, so it
 * cannot reference anything outside its own body.
 *
 * @param {{ globals: string[], dom: {selector: string, attr: string|null}[] }} spec
 */
export function collectPageData(spec) {
  const MAX_HTML = 500_000;
  const MAX_CSS = 300_000;
  const MAX_URLS = 2000;
  const MAX_ELEMENTS = 4000;

  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const uniq = (arr) => Array.from(new Set(arr.filter((x) => typeof x === 'string' && x)));
  const doc = document;

  // ---- URLs of scripts, styles, frames and every loaded resource ----
  const scripts = uniq(Array.from(doc.scripts, (s) => s.src));
  const stylesheets = uniq(Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'), (l) => l.href));
  const iframes = uniq(Array.from(doc.querySelectorAll('iframe[src]'), (f) => f.src));
  const resourceEntries = safe(() => performance.getEntriesByType('resource'), []);
  const resources = uniq(resourceEntries.map((e) => e.name)).slice(0, MAX_URLS);

  // ---- Meta tags ----
  const meta = {};
  for (const m of doc.querySelectorAll('meta')) {
    const key = (m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv') || '').toLowerCase();
    const content = m.getAttribute('content');
    if (!key || content == null) continue;
    meta[key] = (meta[key] ? `${meta[key]} | ${content}` : content).slice(0, 1000);
  }

  // ---- Markup and same-origin CSS ----
  const html = safe(() => doc.documentElement.outerHTML.slice(0, MAX_HTML), '');
  let css = '';
  for (const sheet of Array.from(doc.styleSheets)) {
    if (css.length > MAX_CSS) break;
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        css += rule.cssText + '\n';
        if (css.length > MAX_CSS) break;
      }
    } catch {
      /* cross-origin stylesheet */
    }
  }

  // ---- JavaScript globals ----
  const serialize = (v) => {
    if (v === undefined || v === null) return undefined;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return String(v).slice(0, 200);
    if (Array.isArray(v) || v instanceof Set) {
      const first = Array.from(v).find((x) => typeof x === 'string' || typeof x === 'number');
      return first !== undefined ? String(first).slice(0, 200) : true;
    }
    return true;
  };
  const windowKeys = safe(() => Object.getOwnPropertyNames(window), []);
  const globals = {};
  for (const path of spec.globals) {
    if (path.endsWith('*')) {
      const prefix = path.slice(0, -1);
      if (windowKeys.some((k) => k.startsWith(prefix))) globals[path] = true;
      continue;
    }
    const value = safe(() => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), window), undefined);
    const s = serialize(value);
    if (s !== undefined) globals[path] = s;
  }

  // ---- DOM selectors ----
  const dom = {};
  for (const { selector, attr } of spec.dom) {
    const el = safe(() => doc.querySelector(selector), null);
    if (el) dom[`${selector}|${attr || ''}`] = { attr: attr ? (el.getAttribute(attr) || '').slice(0, 200) : null };
  }

  // ---- Framework probes that need to look at element internals ----
  const elements = doc.querySelectorAll('body, body *');
  let reactFound = false;
  let vueRef = null;
  const limit = Math.min(elements.length, MAX_ELEMENTS);
  for (let i = 0; i < limit && !(reactFound && vueRef); i++) {
    const el = elements[i];
    const keys = safe(() => Object.keys(el), []);
    for (const k of keys) {
      if (
        !reactFound &&
        (k.startsWith('__reactFiber$') ||
          k.startsWith('__reactContainer$') ||
          k.startsWith('__reactInternalInstance$') ||
          k === '_reactRootContainer')
      ) {
        reactFound = true;
      } else if (!vueRef && (k === '__vue_app__' || k === '__vue__' || k === '__vueParentComponent')) {
        vueRef = safe(() => el[k], null) || true;
      }
    }
  }

  const probes = {};
  let reactVersion = safe(() => window.React && window.React.version, null);
  if (!reactVersion) {
    safe(() => window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.forEach((r) => (reactVersion = reactVersion || r.version)));
  }
  if (reactFound || reactVersion) probes.react = reactVersion ? String(reactVersion) : true;

  if (vueRef || safe(() => window.__VUE__, false)) {
    const ver = safe(
      () => vueRef.version || (vueRef.$root && vueRef.$root.constructor && vueRef.$root.constructor.version) || (vueRef.appContext && vueRef.appContext.app.version),
      null,
    ) || safe(() => window.Vue.version, null);
    probes.vue = ver ? String(ver) : true;
  }

  const svelteVersions = safe(() => window.__svelte && window.__svelte.v, null);
  if (svelteVersions && svelteVersions.size) probes.svelte = String(Array.from(svelteVersions)[0]);

  if (safe(() => !!navigator.serviceWorker.controller, false)) probes.serviceWorker = true;

  // ---- Performance snapshot ----
  const nav = safe(() => performance.getEntriesByType('navigation')[0], null);
  const perf = nav
    ? {
        ttfb: Math.round(nav.responseStart),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd) || null,
        load: Math.round(nav.loadEventEnd) || null,
        documentTransferSize: nav.transferSize || null,
        documentDecodedSize: nav.decodedBodySize || null,
        protocol: nav.nextHopProtocol || null,
        navigationType: nav.type,
      }
    : null;

  const byType = {};
  let transfer = 0;
  for (const e of resourceEntries) {
    byType[e.initiatorType] = (byType[e.initiatorType] || 0) + 1;
    transfer += e.transferSize || 0;
  }

  const thirdPartyHosts = new Set();
  for (const u of resources) {
    const host = safe(() => new URL(u).hostname, '');
    if (host && host !== location.hostname) thirdPartyHosts.add(host);
  }

  return {
    url: location.href,
    title: doc.title,
    lang: doc.documentElement.lang || null,
    scripts,
    stylesheets,
    iframes,
    resources,
    meta,
    html,
    css,
    globals,
    dom,
    probes,
    perf,
    cookieNames: uniq(doc.cookie.split(';').map((c) => c.split('=')[0].trim())),
    pageStats: {
      domElements: elements.length,
      scripts: doc.scripts.length,
      stylesheets: stylesheets.length,
      iframes: iframes.length,
      requests: resourceEntries.length,
      requestsByType: byType,
      resourceTransferSize: transfer,
      thirdPartyHosts: Array.from(thirdPartyHosts).sort(),
    },
  };
}
