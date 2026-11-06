// StackLens service worker: captures response headers, runs scans, keeps results and history.
import { collectPageData } from './collector.js';
import { detect, getCollectorSpec } from './detector.js';
import { securityChecks } from './shared/format.js';

const SCANNABLE = /^https?:\/\//i;
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50;
const AUTO_SCAN_DELAY_MS = 1200;

const inflight = new Map(); // tabId -> Promise<report>
const autoScanTimers = new Map();

// ---------- Response headers (main document only) ----------
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = {};
    for (const { name, value } of details.responseHeaders || []) {
      const key = name.toLowerCase();
      headers[key] = headers[key] ? `${headers[key]}, ${value ?? ''}` : value ?? '';
    }
    chrome.storage.session.set({
      [`headers:${details.tabId}`]: {
        url: details.url,
        statusCode: details.statusCode,
        ip: details.ip || null,
        headers,
      },
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders'],
);

// ---------- Auto scan for the toolbar badge ----------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !SCANNABLE.test(tab.url || '')) return;
  clearTimeout(autoScanTimers.get(tabId));
  autoScanTimers.set(
    tabId,
    setTimeout(() => {
      autoScanTimers.delete(tabId);
      scanTab(tabId).catch(() => setBadge(tabId, null));
    }, AUTO_SCAN_DELAY_MS),
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(autoScanTimers.get(tabId));
  autoScanTimers.delete(tabId);
  chrome.storage.session.remove([`headers:${tabId}`, `result:${tabId}`]);
});

// ---------- Messages from popup / report page ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true; // async response
});

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'getResult': {
      const tab = await chrome.tabs.get(msg.tabId);
      const key = `result:${msg.tabId}`;
      const cached = (await chrome.storage.session.get(key))[key];
      const report = cached && cached.url === tab.url ? cached : await scanTab(msg.tabId);
      await addToHistory(report);
      return report;
    }
    case 'scan': {
      const report = await scanTab(msg.tabId, { force: true });
      await addToHistory(report);
      return report;
    }
    case 'getHistory':
      return (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
    case 'clearHistory':
      await chrome.storage.local.remove(HISTORY_KEY);
      return [];
    default:
      throw new Error(`Unknown message type: ${msg?.type}`);
  }
}

// ---------- Scanning ----------
function scanTab(tabId, { force = false } = {}) {
  if (!force && inflight.has(tabId)) return inflight.get(tabId);
  const p = runScan(tabId).finally(() => inflight.delete(tabId));
  inflight.set(tabId, p);
  return p;
}

async function runScan(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!SCANNABLE.test(tab.url || '')) {
    throw new Error('StackLens can only scan http(s) pages.');
  }

  let page;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: collectPageData,
      args: [getCollectorSpec()],
    });
    page = injection?.result;
  } catch (err) {
    throw new Error(`This page can't be scanned (${err.message}). Browser and extension store pages are protected.`);
  }
  if (!page) throw new Error('No data came back from the page. Try reloading it.');

  const server = await getServerInfo(tabId, page.url);
  const cookies = await getCookieNames(page.url, page.cookieNames);

  const technologies = detect({ ...page, headers: server.headers, cookies });

  const report = {
    id: crypto.randomUUID(),
    url: page.url,
    hostname: new URL(page.url).hostname,
    title: page.title,
    scannedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    technologies,
    server: {
      statusCode: server.statusCode,
      ip: server.ip,
      protocol: page.perf?.protocol || null,
      headersSource: server.source,
      headers: server.headers,
    },
    performance: page.perf,
    page: page.pageStats,
    security: securityChecks(server.headers, page.url),
  };

  await chrome.storage.session.set({ [`result:${tabId}`]: report });
  setBadge(tabId, technologies.length);
  return report;
}

async function getServerInfo(tabId, pageUrl) {
  const key = `headers:${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  if (stored && sameOrigin(stored.url, pageUrl)) return { ...stored, source: 'navigation' };

  // Page was loaded before the extension started listening: fetch headers once.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(pageUrl, { credentials: 'include', cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    const headers = {};
    res.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
    controller.abort(); // headers are all we need
    return { url: res.url, statusCode: res.status, ip: null, headers, source: 'refetch' };
  } catch {
    return { url: pageUrl, statusCode: null, ip: null, headers: {}, source: 'unavailable' };
  }
}

async function getCookieNames(url, documentCookieNames = []) {
  const names = new Set(documentCookieNames);
  try {
    // chrome.cookies also sees HttpOnly cookies (e.g. laravel_session). Only names are kept.
    for (const c of await chrome.cookies.getAll({ url })) names.add(c.name);
  } catch {
    /* ignore */
  }
  return [...names];
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function setBadge(tabId, count) {
  const text = count ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' }).catch(() => {});
}

async function addToHistory(report) {
  const history = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || [];
  if (history[0]?.id === report.id) return;
  // One entry per URL: newest wins.
  const next = [report, ...history.filter((r) => r.url !== report.url)].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}
