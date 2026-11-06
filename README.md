# StackLens – Website Technology Detector

A browser extension (Chrome / Edge, Manifest V3) that shows what a website is built with: frameworks, CMS, analytics and tracking, CDN and hosting, web servers, JavaScript libraries and more. It also generates a report you can export.

## Features

- **280+ technologies in 29 categories**, including React, Next.js, Vue, Nuxt, Angular, Svelte, Laravel, Django, Rails, WordPress, Shopify, Webflow, Tailwind, Bootstrap, Google Analytics, GTM, Meta Pixel, Hotjar, Sentry, Stripe, Cloudflare, Fastly, CloudFront, Vercel, Netlify, nginx, Apache, and more.
- **Versions** where the site exposes them (e.g. `WordPress 6.5.2`, `jQuery 3.4.1`, `Next.js 15.0.3`).
- **Evidence for every detection**: expand a technology to see why it was detected (header, cookie, global variable, script URL, DOM marker…).
- **Confidence scores** for weaker signals, plus **implied technologies** (Next.js → React, WordPress → PHP).
- **Warnings** for risky dependencies (outdated jQuery with known XSS CVEs, end-of-life AngularJS, the hijacked polyfill.io).
- **Toolbar badge** with the number of technologies found on each page.
- **Full report page** with a performance snapshot (TTFB, load, requests, transfer size, protocol, compression), a security-headers checklist, third-party hosts, raw response headers, and scan history.
- **Export** as JSON or Markdown, copy to clipboard, or print to PDF.

## How detection works

| Signal | Where it comes from |
| --- | --- |
| Response headers (`server`, `x-powered-by`, `cf-ray`, `x-vercel-id`…) | `chrome.webRequest` for the main document (re-fetched if the page loaded before the extension) |
| Cookies, including HttpOnly (`laravel_session`, `_ga`, `__cf_bm`…) | `chrome.cookies`. Only cookie **names** are read, never values |
| JS globals (`jQuery.fn.jquery`, `__NEXT_DATA__`, `Shopify`…) | Collector script injected into the page's main world |
| Framework internals (React fiber keys, Vue app instances, Svelte 5 version set) | Built-in runtime probes |
| HTML, meta tags, `<script src>`, every loaded resource URL, same-origin CSS | Collector script + Performance API |

Signals are matched against [`src/signatures.js`](src/signatures.js) by the pure engine in [`src/detector.js`](src/detector.js).

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
4. Pin StackLens and open it on any website.

No build step is needed. The extension is plain ES modules.

## Development

```bash
npm test            # detector + signature tests (Node 20+)
npm run icons       # regenerate icons/*.png
node scripts/dev-server.mjs   # UI preview with a mocked chrome API
```

With the dev server running, open `http://localhost:5173/dev/popup-preview.html` or `http://localhost:5173/dev/report-preview.html` to work on the UI without reloading the extension. These previews run the real collector and detector against fake signals on the preview page.

### Adding a technology

Add an entry to `TECHNOLOGIES` in `src/signatures.js`:

```js
{
  name: 'Example CMS',
  cats: ['cms'],
  website: 'https://example.com',
  meta: { generator: v(/Example CMS ([\d.]+)/) },   // v() captures a version
  headers: { 'x-powered-by': /ExampleCMS/ },
  js: { ExampleCMS: '', 'ExampleCMS.version': V },  // '' = exists, V = value is the version
  cookies: { example_session: '' },
  resources: /cdn\.example-cms\.com/,
  implies: ['PHP'],
}
```

Patterns can carry a `confidence` (default 100). A technology's score is the capped sum of its matching patterns. Run `npm test` to validate categories and `implies` references.

## Project layout

```
manifest.json
src/
  background.js        service worker: header capture, scanning, badge, history
  collector.js         injected into pages; gathers signals (must stay self-contained)
  detector.js          pure matching engine
  signatures.js        technology + category database
  shared/              report formatting, security checks, DOM helpers, base styles
  popup/               toolbar popup
  report/              full report + history page
dev/                   UI previews with a mocked chrome API
scripts/               icon generator, dev server
test/                  node:test suite
```

## Privacy

Everything runs locally in your browser. StackLens sends no data anywhere. Scan history is kept in `chrome.storage.local` (the last 50 sites) and can be cleared from the report page. Cookie values are never read.

## Roadmap ideas

- Firefox build (`background.scripts` manifest variant)
- DNS-based detection (mail provider, nameservers) through a DNS-over-HTTPS lookup
- Compare two sites side by side
- Signature updates without publishing a new extension version

## License

MIT
