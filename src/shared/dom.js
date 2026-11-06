// Tiny DOM builder. Page-derived strings only ever go through textContent / attributes,
// never innerHTML, so a hostile page can't inject markup into the extension UI.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [prop, val] of Object.entries(v)) el.style.setProperty(prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'href') el.setAttribute('href', safeHref(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function safeHref(v) {
  try {
    const u = new URL(v, location.href);
    return ['http:', 'https:', 'chrome-extension:', 'moz-extension:', 'blob:'].includes(u.protocol) ? u.href : '#';
  } catch {
    return '#';
  }
}

export function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The stack silhouette: one bar per layer, as wide as the number of technologies found in it.
 * Every site ends up with its own shape.
 * @param layers output of groupByLayer()
 * @param {{ size?: 'tiny'|'small'|'large', onPick?: (layer) => void, labels?: boolean }} opts
 */
export function silhouette(layers, { size = 'small', onPick, labels = false } = {}) {
  const max = Math.max(1, ...layers.map((l) => l.technologies.length));
  const rows = layers.map((l) => {
    const n = l.technologies.length;
    const width = n ? 14 + (86 * n) / max : 0;
    const bar = h(onPick ? 'button' : 'span', {
      class: `bar${n ? '' : ' empty'}`,
      type: onPick ? 'button' : null,
      style: { '--w': `${width}%`, '--i': String(l.index) },
      'aria-label': onPick ? `${l.name}: ${n} found` : null,
      title: `${l.name}: ${n}`,
      onclick: onPick ? () => onPick(l) : null,
    });
    bar.dataset.layer = l.id;
    if (!labels) return h('div', { class: 'row' }, h('span', { class: 'track' }, bar));
    return h(
      'div',
      { class: 'row' },
      h('span', { class: 'track' }, bar),
      h('span', { class: 'row-label' }, h('span', { class: 'row-name' }, l.name), h('span', { class: 'row-count' }, n)),
    );
  });
  return h('div', { class: `silhouette ${size}`, role: onPick ? 'group' : 'img', 'aria-label': onPick ? 'Jump to layer' : layers.map((l) => `${l.name} ${l.technologies.length}`).join(', ') }, rows);
}

export function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'No response from StackLens background worker.');
    return res.data;
  });
}
