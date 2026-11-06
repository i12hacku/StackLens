// Pure detection engine: (page data + signatures) -> detected technologies.
// No browser APIs here, so it runs in the service worker and in Node tests.
import { TECHNOLOGIES, CATEGORIES } from './signatures.js';

/**
 * Pattern forms accepted in signatures:
 *   ''                         -> "exists" (headers, cookies, globals, meta)
 *   /regex/                    -> must match
 *   { re, version, confidence } -> version template like '\\1'; confidence 0-100
 */
function toPattern(p) {
  if (p === '' || p === null || p === undefined || p === true) return { re: null, version: null, confidence: 100 };
  if (p instanceof RegExp) return { re: withI(p), version: null, confidence: 100 };
  if (typeof p === 'string') return { re: new RegExp(p, 'i'), version: null, confidence: 100 };
  return { re: p.re ? (p.caseSensitive ? p.re : withI(p.re)) : null, version: p.version ?? null, confidence: p.confidence ?? 100 };
}

function withI(re) {
  return re.flags.includes('i') ? re : new RegExp(re.source, re.flags + 'i');
}

const list = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

function keyMatcher(key) {
  if (key.length > 2 && key.startsWith('/') && key.endsWith('/')) {
    const re = new RegExp(key.slice(1, -1), 'i');
    return (name) => re.test(name);
  }
  const lower = key.toLowerCase();
  return (name) => name.toLowerCase() === lower;
}

export function slugify(name) {
  return name.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function compileTech(t) {
  const entries = (obj) => Object.entries(obj || {}).map(([k, v]) => [k, list(v).map(toPattern)]);
  return {
    ...t,
    slug: slugify(t.name),
    url: list(t.url).map(toPattern),
    html: list(t.html).map(toPattern),
    css: list(t.css).map(toPattern),
    scriptSrc: list(t.scriptSrc).map(toPattern),
    resources: list(t.resources).map(toPattern),
    meta: entries(t.meta).map(([k, ps]) => [k.toLowerCase(), ps]),
    headers: entries(t.headers).map(([k, ps]) => [k.toLowerCase(), ps]),
    cookies: entries(t.cookies).map(([k, ps]) => [k, keyMatcher(k), ps]),
    js: entries(t.js),
    dom: list(t.dom).map((d) =>
      typeof d === 'string'
        ? { selector: d, attr: null, pattern: toPattern('') }
        : { selector: d.selector, attr: d.attr || null, pattern: toPattern(d.attr ? { re: /^(.+)$/, version: '\\1', confidence: d.confidence } : { confidence: d.confidence }) },
    ),
    implies: list(t.implies),
  };
}

const compiledCache = new WeakMap();
function getCompiled(technologies) {
  if (!compiledCache.has(technologies)) compiledCache.set(technologies, technologies.map(compileTech));
  return compiledCache.get(technologies);
}

/** What the in-page collector needs to look up (global paths and selectors). */
export function getCollectorSpec(technologies = TECHNOLOGIES) {
  const globals = new Set();
  const dom = new Map();
  for (const t of getCompiled(technologies)) {
    for (const [path] of t.js) globals.add(path);
    for (const d of t.dom) dom.set(`${d.selector}|${d.attr || ''}`, { selector: d.selector, attr: d.attr });
  }
  return { globals: [...globals], dom: [...dom.values()] };
}

function resolveVersion(template, match) {
  if (!template || !match) return null;
  const v = template.replace(/\\(\d)/g, (_, i) => match[Number(i)] ?? '').trim();
  return v && /\d/.test(v) && v.length <= 40 ? v : null;
}

function test(pattern, value) {
  if (value === undefined || value === null) return null;
  if (!pattern.re) return { version: null };
  if (typeof value !== 'string') return { version: null }; // object/boolean global: existence only
  const m = pattern.re.exec(value);
  return m ? { version: resolveVersion(pattern.version, m) } : null;
}

const short = (s, n = 90) => {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
};

/**
 * @param {object} input page data: url, html, css, scripts[], resources[], stylesheets[], iframes[],
 *   meta{}, headers{}, cookies[] (names), globals{}, dom{}, probes{}
 * @returns {Array<{name, slug, categories, version, confidence, website, evidence, implied, warning}>}
 */
export function detect(input, technologies = TECHNOLOGIES) {
  const compiled = getCompiled(technologies);
  const byName = new Map(compiled.map((t) => [t.name, t]));
  const found = new Map();

  const hit = (tech, pattern, version, evidence) => {
    let f = found.get(tech.name);
    if (!f) found.set(tech.name, (f = { tech, confidence: 0, versions: [], evidence: [], implied: false, direct: false }));
    f.confidence = Math.min(100, f.confidence + pattern.confidence);
    if (version) f.versions.push(version);
    if (evidence && f.evidence.length < 6 && !f.evidence.includes(evidence)) f.evidence.push(evidence);
    if (pattern.confidence > 0) f.direct = true;
  };

  const html = input.html || '';
  const css = input.css || '';
  const scripts = input.scripts || [];
  const allUrls = [...new Set([...scripts, ...(input.stylesheets || []), ...(input.iframes || []), ...(input.resources || [])])];
  const meta = input.meta || {};
  const headers = lowerKeys(input.headers || {});
  const cookies = input.cookies || [];
  const globals = input.globals || {};
  const dom = input.dom || {};
  const probes = input.probes || {};

  for (const t of compiled) {
    for (const p of t.url) {
      const r = test(p, input.url || '');
      if (r) hit(t, p, r.version, `URL matches ${p.re?.source}`);
    }
    for (const p of t.html) {
      const m = p.re && p.re.exec(html);
      if (m) hit(t, p, resolveVersion(p.version, m), `HTML contains “${short(m[0], 60)}”`);
    }
    for (const p of t.css) {
      const m = p.re && p.re.exec(css);
      if (m) hit(t, p, resolveVersion(p.version, m), `CSS contains “${short(m[0], 60)}”`);
    }
    for (const p of t.scriptSrc) {
      for (const src of scripts) {
        const r = test(p, src);
        if (r) {
          hit(t, p, r.version, `Script ${short(src)}`);
          break;
        }
      }
    }
    for (const p of t.resources) {
      for (const u of allUrls) {
        const r = test(p, u);
        if (r) {
          hit(t, p, r.version, `Loads ${short(u)}`);
          break;
        }
      }
    }
    for (const [name, ps] of t.meta) {
      for (const p of ps) {
        const r = test(p, meta[name]);
        if (r) hit(t, p, r.version, `<meta ${name}="${short(meta[name], 60)}">`);
      }
    }
    for (const [name, ps] of t.headers) {
      for (const p of ps) {
        const r = test(p, headers[name]);
        if (r) hit(t, p, r.version, `Header ${name}: ${short(headers[name], 60)}`);
      }
    }
    for (const [, matches, ps] of t.cookies) {
      const name = cookies.find(matches);
      if (name) for (const p of ps) hit(t, p, null, `Cookie ${name}`);
    }
    for (const [path, ps] of t.js) {
      for (const p of ps) {
        const r = test(p, globals[path]);
        if (r) hit(t, p, r.version, `window.${path}${typeof globals[path] === 'string' ? ` = ${short(globals[path], 40)}` : ''}`);
      }
    }
    for (const d of t.dom) {
      const found = dom[`${d.selector}|${d.attr || ''}`];
      if (!found) continue;
      const r = d.attr ? test(d.pattern, found.attr) : { version: null };
      if (r) hit(t, d.pattern, r.version, `DOM ${d.selector}`);
    }
    if (t.probe && probes[t.probe]) {
      const v = probes[t.probe];
      hit(t, { confidence: 100 }, typeof v === 'string' && /\d/.test(v) ? v : null, `Runtime: ${t.probe} detected in page`);
    }
  }

  // Version-only matches (confidence 0) don't count as a detection on their own.
  for (const [name, f] of found) if (f.confidence <= 0) found.delete(name);

  // Resolve implications (e.g. Next.js -> React, WordPress -> PHP).
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...found.values()]) {
      for (const imp of f.tech.implies) {
        const target = byName.get(typeof imp === 'string' ? imp : imp.name);
        if (!target) continue;
        const conf = Math.min(f.confidence, typeof imp === 'string' ? 100 : imp.confidence ?? 100);
        const existing = found.get(target.name);
        if (!existing) {
          found.set(target.name, { tech: target, confidence: conf, versions: [], evidence: [`Implied by ${f.tech.name}`], implied: true, direct: false });
          changed = true;
        } else if (!existing.direct && existing.confidence < conf) {
          existing.confidence = conf;
          changed = true;
        }
      }
    }
  }

  const catOrder = Object.keys(CATEGORIES);
  return [...found.values()]
    .map((f) => {
      const version = pickVersion(f.versions);
      return {
        name: f.tech.name,
        slug: f.tech.slug,
        categories: f.tech.cats,
        version,
        confidence: f.confidence,
        website: f.tech.website || null,
        evidence: f.evidence,
        implied: !f.direct,
        warning: typeof f.tech.warning === 'function' ? f.tech.warning(version) || null : f.tech.warning || null,
      };
    })
    .sort((a, b) => catOrder.indexOf(a.categories[0]) - catOrder.indexOf(b.categories[0]) || a.name.localeCompare(b.name));
}

function pickVersion(versions) {
  if (!versions.length) return null;
  // Prefer the most specific version string (most dot segments), then the most common one.
  const counts = new Map();
  for (const v of versions) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[0].split('.').length - a[0].split('.').length || b[1] - a[1])[0][0];
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}
