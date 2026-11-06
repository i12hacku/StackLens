import { h, download, silhouette, sendMessage } from '../shared/dom.js';
import { groupByLayer, categoryLabel, toJSON, toMarkdown, reportFilename, formatBytes, formatMs } from '../shared/format.js';

const params = new URLSearchParams(location.search);
const main = document.getElementById('main');
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const longFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

init();

async function init() {
  document.getElementById('clear-history').addEventListener('click', async () => {
    if (!confirm('Clear all saved scans? This can’t be undone.')) return;
    await sendMessage({ type: 'clearHistory' });
    renderHistory([], null);
  });

  const history = await sendMessage({ type: 'getHistory' });
  const report = history.find((r) => r.id === params.get('id')) || history[0];
  renderHistory(history, report?.id);
  if (!report) {
    main.replaceChildren(h('p', { class: 'message' }, 'No scans yet. Open StackLens from the toolbar on any website and its report will appear here.'));
    return;
  }
  renderReport(report);
}

function renderHistory(history, currentId) {
  const nav = document.getElementById('history');
  document.getElementById('clear-history').hidden = !history.length;
  if (!history.length) {
    nav.replaceChildren(h('p', { class: 'empty-history' }, 'Sites you scan will be listed here.'));
    return;
  }
  nav.replaceChildren(
    ...history.map((r) =>
      h(
        'a',
        { href: `?id=${encodeURIComponent(r.id)}`, 'aria-current': r.id === currentId ? 'page' : null },
        silhouette(groupByLayer(r.technologies), { size: 'tiny' }),
        h('span', { class: 'h-host' }, r.hostname),
        h('span', { class: 'h-date' }, `${dateFmt.format(new Date(r.scannedAt))}, ${r.technologies.length} found`),
      ),
    ),
  );
}

function renderReport(r) {
  document.title = `${r.hostname} – StackLens`;
  const layers = groupByLayer(r.technologies);
  const p = r.performance || {};
  const s = r.page || {};
  const headers = r.server?.headers || {};
  const warnings = r.technologies.filter((t) => t.warning);
  const used = layers.filter((l) => l.technologies.length).length;

  const hero = h(
    'header',
    { class: 'hero' },
    h(
      'div',
      {},
      h('h1', { class: 'display' }, r.hostname.split('.').flatMap((part, i) => (i ? ['.', h('wbr'), part] : [part]))),
      h('a', { class: 'url', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.url),
      h('p', { class: 'scanned' }, `Scanned ${longFmt.format(new Date(r.scannedAt))}.${r.title ? ` Page title: “${r.title}”.` : ''}`),
      h(
        'div',
        { class: 'hero-actions' },
        h('button', { class: 'btn', onclick: () => download(reportFilename(r, 'json'), toJSON(r), 'application/json') }, 'Save as JSON'),
        h('button', { class: 'btn', onclick: () => download(reportFilename(r, 'md'), toMarkdown(r), 'text/markdown') }, 'Save as Markdown'),
        h('button', { class: 'btn primary', onclick: () => window.print() }, 'Print or save PDF'),
      ),
    ),
    h(
      'figure',
      {},
      silhouette(layers, { size: 'large', labels: true }),
      h('figcaption', {}, `${r.technologies.length} technologies ${used === 4 ? "across all 4 layers" : `in ${used} of 4 layers`}`),
    ),
  );

  const warningBlock = warnings.length
    ? h('section', { class: 'warnings', role: 'note' }, h('h2', { class: 'display' }, warnings.length === 1 ? 'One thing to fix' : `${warnings.length} things to fix`), h('ul', {}, warnings.map((t) => h('li', {}, t.warning))))
    : null;

  const strata = h('div', { class: 'strata' }, layers.map(layerSection));

  const facts = h(
    'div',
    { class: 'facts' },
    h(
      'section',
      {},
      h('h2', { class: 'display' }, 'Server and speed'),
      dl([
        ['Status', r.server?.statusCode],
        ['IP address', r.server?.ip],
        ['Server', headers.server],
        ['Protocol', r.server?.protocol],
        ['Compression', headers['content-encoding'] || 'None reported'],
        ['First byte', formatMs(p.ttfb)],
        ['Page ready', formatMs(p.domContentLoaded)],
        ['Fully loaded', formatMs(p.load)],
        ['Requests', s.requests],
        ['Transferred', formatBytes((p.documentTransferSize || 0) + (s.resourceTransferSize || 0))],
        ['Elements on page', s.domElements],
      ]),
    ),
    h(
      'section',
      {},
      h('h2', { class: 'display' }, 'Security headers'),
      r.security?.score !== null && r.security?.score !== undefined ? h('p', { class: 'score' }, `${r.security.score}% of recommended protections are in place.`) : null,
      h(
        'ul',
        { class: 'checks' },
        (r.security?.checks || []).map((c) => {
          const [cls, mark, label] = c.present === null ? ['unknown', '?', 'unknown'] : c.present ? ['ok', '✓', 'present'] : ['bad', '✕', 'missing'];
          return h('li', {}, h('span', { class: `mark ${cls}`, 'aria-label': label }, mark), h('span', {}, c.label, h('span', { class: 'why' }, c.why)));
        }),
      ),
      r.security?.versionLeaks?.length ? h('p', { class: 'leaks' }, `These headers reveal software versions: ${r.security.versionLeaks.join(', ')}.`) : null,
    ),
  );

  const domains = s.thirdPartyHosts?.length
    ? h('section', { class: 'domains' }, h('h2', { class: 'display' }, `Other domains this page contacted (${s.thirdPartyHosts.length})`), h('ul', {}, s.thirdPartyHosts.map((x) => h('li', {}, x))))
    : null;

  const raw = h(
    'details',
    { class: 'raw' },
    h('summary', {}, `Response headers (${Object.keys(headers).length})`),
    Object.keys(headers).length
      ? dl(Object.keys(headers).sort().map((k) => [k, headers[k]]))
      : h('p', {}, 'Headers weren’t captured for this page. Reload it and scan again.'),
  );

  main.replaceChildren(...[hero, warningBlock, strata, facts, domains, raw].filter(Boolean));
}

function layerSection(l) {
  const section = h(
    'section',
    { class: 'layer', id: `layer-${l.id}`, 'aria-labelledby': `h-${l.id}` },
    h(
      'div',
      { class: 'layer-head' },
      h('h2', { class: 'display', id: `h-${l.id}` }, l.name),
      h('span', { class: 'hint' }, l.hint),
      h('span', { class: 'count' }, l.technologies.length),
    ),
    l.technologies.length
      ? h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', { class: 'c-name' }, 'Technology'), h('th', { class: 'c-ver' }, 'Version'), h('th', { class: 'c-cat' }, 'Type'), h('th', {}, 'How it was found'))),
          h(
            'tbody',
            {},
            l.technologies.map((t) =>
              h(
                'tr',
                {},
                h(
                  'td',
                  { class: 'name' },
                  t.website ? h('a', { href: t.website, target: '_blank', rel: 'noopener noreferrer' }, t.name) : t.name,
                  t.warning ? h('span', { class: 'flag', title: t.warning }, 'Issue') : null,
                  t.confidence < 100 ? h('span', { class: 'likely' }, `Likely, ${t.confidence}% confidence`) : null,
                ),
                h('td', { class: 'ver' }, t.version || '–'),
                h('td', { class: 'cat' }, categoryLabel(t.categories[0])),
                h('td', { class: 'how' }, t.evidence.map((e) => h('div', {}, e))),
              ),
            ),
          ),
        )
      : h('p', { class: 'none' }, l.id === 'backend' ? 'Nothing detected. Many servers hide what they run.' : 'Nothing detected.'),
  );
  section.dataset.layer = l.id;
  return section;
}

function dl(pairs) {
  return h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v === null || v === undefined || v === '' ? '–' : v)]));
}
