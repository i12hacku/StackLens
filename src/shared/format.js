// Report helpers shared by the service worker, popup and report page. No DOM access.
import { CATEGORIES } from '../signatures.js';

export function groupByCategory(technologies) {
  const groups = new Map();
  for (const id of Object.keys(CATEGORIES)) groups.set(id, []);
  for (const t of technologies) {
    for (const cat of t.categories) {
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(t);
    }
  }
  return [...groups.entries()]
    .filter(([, techs]) => techs.length)
    .map(([id, techs]) => ({ id, ...(CATEGORIES[id] || { name: id, one: id }), technologies: techs }));
}

// The four layers of a stack, top (closest to the visitor) to bottom (closest to the wire).
export const LAYERS = [
  { id: 'frontend', name: 'Frontend', hint: 'Runs in the browser', cats: ['web-framework', 'js-framework', 'static-site', 'ui', 'js-library', 'build', 'misc'] },
  { id: 'services', name: 'Third-party services', hint: 'Loaded from other companies', cats: ['analytics', 'tag-manager', 'advertising', 'monitoring', 'ab-testing', 'marketing', 'chat', 'payments', 'auth', 'baas', 'fonts', 'media', 'social'] },
  { id: 'backend', name: 'Backend', hint: 'Runs on the server', cats: ['cms', 'ecommerce', 'backend', 'language', 'database', 'web-server'] },
  { id: 'infra', name: 'Infrastructure', hint: 'Hosting, CDN and protection', cats: ['hosting', 'cdn', 'security'] },
];

export const categoryLabel = (id) => CATEGORIES[id]?.one || id;

/** Every technology lands in exactly one layer, decided by its first category. Empty layers are kept. */
export function groupByLayer(technologies) {
  return LAYERS.map((layer, index) => {
    const techs = technologies
      .filter((t) => layer.cats.includes(t.categories[0]))
      .sort((a, b) => layer.cats.indexOf(a.categories[0]) - layer.cats.indexOf(b.categories[0]) || a.name.localeCompare(b.name));
    return { ...layer, index, technologies: techs };
  });
}

const SECURITY_HEADERS = [
  { header: 'strict-transport-security', label: 'Strict-Transport-Security', why: 'Forces HTTPS on future visits.', httpsOnly: true },
  { header: 'content-security-policy', label: 'Content-Security-Policy', why: 'Restricts where scripts and other resources can load from.' },
  { header: 'x-content-type-options', label: 'X-Content-Type-Options', why: 'Stops MIME-type sniffing.' },
  { header: 'x-frame-options', label: 'X-Frame-Options', why: 'Protects against clickjacking (or use CSP frame-ancestors).', alt: (h) => /frame-ancestors/i.test(h['content-security-policy'] || '') },
  { header: 'referrer-policy', label: 'Referrer-Policy', why: 'Controls how much referrer information is sent.' },
  { header: 'permissions-policy', label: 'Permissions-Policy', why: 'Limits browser features such as camera and geolocation.' },
];

export function securityChecks(headers = {}, url = '') {
  const https = url.startsWith('https:');
  const hasHeaders = Object.keys(headers).length > 0;
  const checks = [{ label: 'HTTPS', present: https, why: 'Page is served over an encrypted connection.' }];
  for (const s of SECURITY_HEADERS) {
    const value = headers[s.header];
    checks.push({
      label: s.label,
      present: hasHeaders ? Boolean(value) || Boolean(s.alt?.(headers)) : null, // null = unknown
      value: value || null,
      why: s.why,
    });
  }
  const leaks = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator']
    .filter((h) => headers[h] && /\d/.test(headers[h]))
    .map((h) => `${h}: ${headers[h]}`);
  const known = checks.filter((c) => c.present !== null);
  return {
    checks,
    versionLeaks: leaks,
    score: known.length ? Math.round((known.filter((c) => c.present).length / known.length) * 100) : null,
  };
}

export function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`;
}

export function toJSON(report) {
  return JSON.stringify(report, null, 2);
}

const md = (s) => String(s ?? '').replace(/[|\\`*_<>]/g, (ch) => `\\${ch}`).replace(/\n/g, ' ');

export function toMarkdown(report) {
  const groups = groupByCategory(report.technologies);
  const lines = [
    `# StackLens report: ${md(report.hostname)}`,
    '',
    `- **URL:** ${report.url}`,
    `- **Title:** ${md(report.title || '—')}`,
    `- **Scanned:** ${new Date(report.scannedAt).toLocaleString()}`,
    `- **Detected:** ${report.technologies.length} technologies in ${groups.length} categories`,
    '',
    '## Technologies',
    '',
  ];
  for (const g of groups) {
    lines.push(`### ${g.name}`, '', '| Technology | Version | Confidence | Evidence |', '| --- | --- | --- | --- |');
    for (const t of g.technologies) {
      const name = t.website ? `[${md(t.name)}](${t.website})` : md(t.name);
      lines.push(`| ${name}${t.warning ? ' ⚠️' : ''} | ${md(t.version || '—')} | ${t.confidence}% | ${md(t.evidence.slice(0, 2).join('; '))} |`);
    }
    lines.push('');
  }

  const warnings = report.technologies.filter((t) => t.warning);
  if (warnings.length) {
    lines.push('## Warnings', '');
    for (const t of warnings) lines.push(`- **${md(t.name)}:** ${md(t.warning)}`);
    lines.push('');
  }

  const p = report.performance || {};
  const s = report.page || {};
  lines.push(
    '## Server & performance',
    '',
    `- **Status:** ${report.server?.statusCode ?? '—'}`,
    `- **IP address:** ${report.server?.ip ?? '—'}`,
    `- **Protocol:** ${report.server?.protocol ?? '—'}`,
    `- **Server header:** ${md(report.server?.headers?.server ?? '—')}`,
    `- **Compression:** ${md(report.server?.headers?.['content-encoding'] ?? 'none / unknown')}`,
    `- **Time to first byte:** ${formatMs(p.ttfb)}`,
    `- **DOMContentLoaded:** ${formatMs(p.domContentLoaded)}`,
    `- **Load:** ${formatMs(p.load)}`,
    `- **Requests:** ${s.requests ?? '—'} (${s.thirdPartyHosts?.length ?? 0} third-party hosts)`,
    `- **DOM elements:** ${s.domElements ?? '—'}`,
    '',
    '## Security headers',
    '',
  );
  for (const c of report.security?.checks || []) {
    const mark = c.present === null ? '❔' : c.present ? '✅' : '❌';
    lines.push(`- ${mark} ${c.label}`);
  }
  if (report.security?.versionLeaks?.length) {
    lines.push('', `Version disclosure in headers: ${report.security.versionLeaks.map(md).join(', ')}`);
  }
  lines.push('', `_Generated by StackLens ${report.extensionVersion || ''}_`, '');
  return lines.join('\n');
}

export function reportFilename(report, ext) {
  const date = report.scannedAt.slice(0, 10);
  return `stacklens-${report.hostname.replace(/[^a-z0-9.-]/gi, '_')}-${date}.${ext}`;
}
