import { h, download, silhouette, sendMessage } from '../shared/dom.js';
import { groupByLayer, categoryLabel, toJSON, toMarkdown, reportFilename } from '../shared/format.js';

const $ = (id) => document.getElementById(id);
let report = null;
let tabId = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try {
    $('hostname').textContent = new URL(tab.url).hostname || 'StackLens';
  } catch {
    /* keep default */
  }
  $('rescan').addEventListener('click', () => load('scan'));
  $('search').addEventListener('input', () => renderLayers());
  $('open-report').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`src/report/report.html?id=${encodeURIComponent(report.id)}`) });
  });
  $('export-json').addEventListener('click', () => download(reportFilename(report, 'json'), toJSON(report), 'application/json'));
  $('export-md').addEventListener('click', () => download(reportFilename(report, 'md'), toMarkdown(report), 'text/markdown'));
  $('copy').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(toMarkdown(report));
    flash(e.currentTarget, 'Copied');
  });
  load('getResult');
}

async function load(type) {
  $('rescan').disabled = true;
  if (type === 'scan' || !report) {
    $('summary').textContent = type === 'scan' ? 'Scanning again…' : 'Reading this page…';
    $('content').replaceChildren();
  }
  try {
    report = await sendMessage({ type, tabId });
    $('hostname').textContent = report.hostname;
    $('actions').hidden = false;
    render();
  } catch (err) {
    report = null;
    $('summary').textContent = 'Can’t scan this page';
    $('actions').hidden = true;
    $('filter-wrap').hidden = true;
    $('warnings').hidden = true;
    $('silhouette').replaceChildren();
    $('content').replaceChildren(h('div', { class: 'message error' }, h('p', {}, err.message)));
  } finally {
    $('rescan').disabled = false;
    $('rescan').hidden = false;
  }
}

function render() {
  const techs = report.technologies;
  const layers = groupByLayer(techs);
  const used = layers.filter((l) => l.technologies.length).length;

  $('summary').textContent = techs.length
    ? `${techs.length} ${techs.length === 1 ? 'technology' : 'technologies'} ${used === 4 ? "across all 4 layers" : `in ${used} of 4 layers`}`
    : 'No technologies found';

  $('silhouette').replaceChildren(
    techs.length
      ? silhouette(layers, {
          onPick: (l) => document.querySelector(`.layer[data-layer="${l.id}"]`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }),
        })
      : '',
  );

  const warnings = techs.filter((t) => t.warning);
  $('warnings').hidden = !warnings.length;
  $('warnings').replaceChildren(...warnings.map((t) => h('p', {}, t.warning)));

  $('filter-wrap').hidden = techs.length < 10;
  renderLayers();
}

function renderLayers() {
  const techs = report.technologies;
  if (!techs.length) {
    $('content').replaceChildren(
      h('div', { class: 'message' }, h('p', {}, 'Nothing recognizable yet. If the page is still loading, wait a moment and scan again.')),
    );
    return;
  }

  const q = $('search').value.trim().toLowerCase();
  const matches = (t) => !q || t.name.toLowerCase().includes(q) || t.categories.some((c) => categoryLabel(c).toLowerCase().includes(q));

  const sections = [];
  for (const layer of groupByLayer(techs)) {
    const items = layer.technologies.filter(matches);
    if (q && !items.length) continue;
    const section = h(
      'section',
      { class: `layer${items.length ? '' : ' is-empty'}`, 'aria-label': layer.name },
      h(
        'h2',
        { class: 'layer-head display' },
        layer.name,
        items.length ? null : h('span', { class: 'hint' }, 'Nothing detected'),
        items.length ? h('span', { class: 'count' }, items.length) : null,
      ),
      items.map(techRow),
    );
    section.dataset.layer = layer.id;
    sections.push(section);
  }
  if (!sections.length) sections.push(h('p', { class: 'no-match' }, `Nothing matches “${q}”.`));
  $('content').replaceChildren(...sections);
}

function techRow(t) {
  return h(
    'details',
    { class: 'tech' },
    h(
      'summary',
      {},
      h('span', { class: 't-name' }, t.name),
      t.version ? h('span', { class: 't-ver' }, t.version) : null,
      t.warning ? h('span', { class: 't-flag issue' }, 'Issue') : null,
      t.confidence < 100 ? h('span', { class: 't-flag likely', title: `${t.confidence}% confidence` }, 'Likely') : null,
      h('span', { class: 't-cat' }, categoryLabel(t.categories[0])),
    ),
    h(
      'div',
      { class: 't-detail' },
      t.warning ? h('p', { class: 't-warn' }, t.warning) : null,
      h('p', {}, t.implied ? 'Not seen directly. Inferred because:' : `Found by (${t.confidence}% confidence):`),
      h('ul', {}, t.evidence.map((e) => h('li', {}, e))),
      t.website ? h('a', { href: t.website, target: '_blank', rel: 'noopener noreferrer' }, new URL(t.website).hostname.replace(/^www\./, '')) : null,
    ),
  );
}

function flash(btn, text) {
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = prev), 1200);
}
