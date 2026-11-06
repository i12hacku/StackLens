// Dev-only: fakes the bits of the chrome.* API the popup/report use, and builds a real
// report by running the actual collector + detector against this preview page.
import { collectPageData } from '../src/collector.js';
import { detect, getCollectorSpec } from '../src/detector.js';
import { securityChecks } from '../src/shared/format.js';

// ---- Fake "website" signals on this page ----
window.jQuery = { fn: { jquery: '3.4.1' } };
window.__NEXT_DATA__ = { props: {} };
window.next = { version: '15.0.3' };
window.dataLayer = [];
window.google_tag_manager = {};
window.Stripe = function () {};
const root = document.createElement('div');
root.id = '__next';
root['__reactContainer$x1y2'] = {};
root.className = 'flex md:hidden text-slate-700';
document.body.append(root);
for (const [name, content] of [['generator', 'WordPress 6.5.2'], ['og:title', 'Demo']]) {
  const m = document.createElement('meta');
  m.name = name;
  m.content = content;
  document.head.append(m);
}

const fakeHeaders = {
  server: 'nginx/1.25.3',
  'cf-ray': '8f00-LHR',
  'x-powered-by': 'PHP/8.2.12',
  'strict-transport-security': 'max-age=31536000',
  'content-encoding': 'br',
};

function buildReport() {
  const page = collectPageData(getCollectorSpec());
  // Simulate script URLs the page "loaded"
  page.scripts.push('https://www.googletagmanager.com/gtm.js?id=GTM-ABC', 'https://js.stripe.com/v3/', 'https://demo.test/_next/static/chunks/main.js');
  const technologies = detect({ ...page, headers: fakeHeaders, cookies: ['_ga', 'laravel_session', 'XSRF-TOKEN'] });
  return {
    id: 'preview',
    url: 'https://demo.example.com/pricing',
    hostname: 'demo.example.com',
    title: 'Demo – Pricing',
    scannedAt: new Date().toISOString(),
    extensionVersion: '0.1.0-dev',
    technologies,
    server: { statusCode: 200, ip: '104.16.0.1', protocol: page.perf?.protocol, headersSource: 'mock', headers: fakeHeaders },
    performance: page.perf,
    page: page.pageStats,
    security: securityChecks(fakeHeaders, 'https://demo.example.com/'),
  };
}

let report;
window.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://demo.example.com/pricing' }],
    create: ({ url }) => console.log('[mock] open', url),
  },
  runtime: {
    getURL: (p) => `/${p}`,
    sendMessage: async (msg) => {
      await new Promise((r) => setTimeout(r, 300));
      report ||= buildReport();
      if (msg.type === 'getHistory') return { ok: true, data: [report] };
      return { ok: true, data: report };
    },
  },
};
window.__stacklensPreviewReport = () => (report ||= buildReport());
