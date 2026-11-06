import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, getCollectorSpec } from '../src/detector.js';
import { TECHNOLOGIES, CATEGORIES } from '../src/signatures.js';
import { securityChecks, toMarkdown } from '../src/shared/format.js';

const byName = (results) => Object.fromEntries(results.map((r) => [r.name, r]));

test('signatures are well-formed', () => {
  const names = new Set();
  for (const t of TECHNOLOGIES) {
    assert.ok(!names.has(t.name), `duplicate technology: ${t.name}`);
    names.add(t.name);
    assert.ok(t.cats?.length, `${t.name} has no category`);
    for (const c of t.cats) assert.ok(CATEGORIES[c], `${t.name}: unknown category ${c}`);
  }
  for (const t of TECHNOLOGIES) {
    for (const imp of t.implies || []) {
      const target = typeof imp === 'string' ? imp : imp.name;
      assert.ok(names.has(target), `${t.name} implies unknown technology ${target}`);
    }
  }
});

test('empty page detects nothing', () => {
  assert.deepEqual(detect({ url: 'https://example.com/' }), []);
});

test('collector spec lists globals and selectors', () => {
  const spec = getCollectorSpec();
  assert.ok(spec.globals.includes('jQuery.fn.jquery'));
  assert.ok(spec.globals.includes('webpackChunk*'));
  assert.ok(spec.dom.some((d) => d.selector === '[ng-version]' && d.attr === 'ng-version'));
});

test('WordPress site with WooCommerce, jQuery and analytics', () => {
  const r = byName(
    detect({
      url: 'https://shop.example.com/',
      html: '<link rel="https://api.w.org/" href="/wp-json/"><script src="/wp-content/plugins/woocommerce/x.js"></script>',
      scripts: ['https://shop.example.com/wp-includes/js/jquery/jquery.min.js', 'https://www.googletagmanager.com/gtm.js?id=GTM-X'],
      meta: { generator: 'WordPress 6.4.2 | WooCommerce 8.3.0' },
      headers: { Server: 'nginx/1.25.3', 'cf-ray': '8abc-LHR', 'X-Powered-By': 'PHP/8.2.12' },
      globals: { 'jQuery.fn.jquery': '3.4.1', woocommerce_params: true },
      cookies: ['_ga', 'PHPSESSID'],
    }),
  );
  assert.equal(r.WordPress.version, '6.4.2');
  assert.equal(r.WooCommerce.version, '8.3.0');
  assert.equal(r.PHP.version, '8.2.12');
  assert.equal(r.PHP.implied, false);
  assert.equal(r.Nginx.version, '1.25.3');
  assert.ok(r.Cloudflare);
  assert.ok(r['Google Tag Manager']);
  assert.ok(r['Google Analytics']);
  assert.equal(r.jQuery.version, '3.4.1');
  assert.match(r.jQuery.warning, /CVE-2020-11022/);
  assert.ok(r.MySQL.implied);
  assert.equal(r.MySQL.confidence, 50);
});

test('Next.js on Vercel implies React', () => {
  const r = byName(
    detect({
      url: 'https://app.example.com/',
      scripts: ['https://app.example.com/_next/static/chunks/main-abc.js'],
      globals: { __next_f: true, 'next.version': '15.0.3', 'webpackChunk*': true },
      headers: { 'x-vercel-id': 'iad1::abc', server: 'Vercel', 'x-powered-by': 'Next.js' },
      probes: { react: '19.0.0' },
    }),
  );
  assert.equal(r['Next.js'].version, '15.0.3');
  assert.equal(r.React.version, '19.0.0');
  assert.equal(r.React.implied, false);
  assert.ok(r.Vercel);
  assert.ok(r.webpack);
});

test('React is implied when only Next.js is seen', () => {
  const r = byName(detect({ url: 'https://x.dev/', scripts: ['https://x.dev/_next/static/x.js'] }));
  assert.ok(r.React.implied);
  assert.deepEqual(r.React.evidence, ['Implied by Next.js']);
});

test('Laravel via HttpOnly session cookie', () => {
  const r = byName(detect({ url: 'https://app.test/', cookies: ['XSRF-TOKEN', 'laravel_session'] }));
  assert.equal(r.Laravel.confidence, 100);
  assert.ok(r.PHP.implied);
});

test('renamed Laravel session cookie gives partial confidence', () => {
  const r = byName(detect({ url: 'https://app.test/', cookies: ['XSRF-TOKEN', 'myapp_session'] }));
  assert.equal(r.Laravel.confidence, 65);
});

test('version-only patterns do not detect alone', () => {
  // Underscore and Lodash both expose _.VERSION; only the distinguishing function counts.
  const r = byName(detect({ url: 'https://x.test/', globals: { '_.VERSION': '4.17.21', '_.flowRight': true } }));
  assert.equal(r.Lodash.version, '4.17.21');
  assert.equal(r['Underscore.js'], undefined);
});

test('Angular version from ng-version attribute', () => {
  const r = byName(detect({ url: 'https://x.test/', dom: { '[ng-version]|ng-version': { attr: '17.3.1' } } }));
  assert.equal(r.Angular.version, '17.3.1');
  assert.ok(r.TypeScript.implied);
});

test('Tailwind detected from CSS variables', () => {
  const r = byName(detect({ url: 'https://x.test/', css: '*, ::before { --tw-ring-offset-width: 0px; }' }));
  assert.equal(r['Tailwind CSS'].confidence, 100);
});

test('Apache does not match Tomcat', () => {
  const r = byName(detect({ url: 'https://x.test/', headers: { server: 'Apache-Coyote/1.1' } }));
  assert.ok(r['Apache Tomcat']);
  assert.equal(r['Apache HTTP Server'], undefined);
});

test('GitHub Pages server header is case-sensitive', () => {
  assert.ok(byName(detect({ url: 'https://x.test/', headers: { server: 'GitHub.com' } }))['GitHub Pages']);
  assert.equal(byName(detect({ url: 'https://github.com/', headers: { server: 'github.com' } }))['GitHub Pages'], undefined);
});

test('security checks and markdown export', () => {
  const sec = securityChecks({ 'strict-transport-security': 'max-age=1', server: 'nginx/1.2' }, 'https://x.test/');
  assert.equal(sec.checks.find((c) => c.label === 'HTTPS').present, true);
  assert.equal(sec.checks.find((c) => c.label === 'Content-Security-Policy').present, false);
  assert.deepEqual(sec.versionLeaks, ['server: nginx/1.2']);
  assert.equal(securityChecks({}, 'https://x.test/').checks[1].present, null);

  const technologies = detect({ url: 'https://x.test/', headers: { server: 'nginx/1.2' } });
  const md = toMarkdown({ url: 'https://x.test/', hostname: 'x.test', title: 'A | B', scannedAt: new Date().toISOString(), technologies, security: sec });
  assert.match(md, /\| \[Nginx\]\(https:\/\/nginx\.org\) \| 1\.2 \| 100% \|/);
  assert.match(md, /A \\\| B/);
});

test('every category belongs to exactly one stack layer', async () => {
  const { LAYERS, groupByLayer } = await import('../src/shared/format.js');
  for (const id of Object.keys(CATEGORIES)) {
    assert.equal(LAYERS.filter((l) => l.cats.includes(id)).length, 1, `category ${id} must be in exactly one layer`);
    assert.ok(CATEGORIES[id].one, `category ${id} needs a singular label`);
  }
  const layers = groupByLayer(detect({ url: 'https://x.test/', headers: { server: 'nginx', 'cf-ray': '1' }, cookies: ['_ga'] }));
  assert.deepEqual(layers.map((l) => l.technologies.length), [0, 1, 1, 1]);
});
