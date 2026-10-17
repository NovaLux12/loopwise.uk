#!/usr/bin/env node
/**
 * check-links.mjs — fail CI on a broken internal link or anchor.
 *
 * This is a static site with no router, so nothing at runtime stops a link
 * pointing at a section that was renamed or a page that moved. It walks every
 * href/src in the HTML, resolves internal targets against the files on disk,
 * and checks that any #fragment actually exists as an id.
 *
 *   node scripts/check-links.mjs
 *
 * URL-to-file mapping matters here: the host serves /build/ from build.html,
 * not from build/index.html. ROUTES below encodes that convention.
 *
 * External http(s) links are listed but not fetched: the site deliberately
 * makes no third-party requests, and this check stays network-free.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pages this check understands, and the URL path that serves each. */
const ROUTES = [
  { url: '/', file: 'index.html' },
  { url: '/build/', file: 'build.html' },
  { url: '/research/', file: 'research.html' },
];

/** Served by the origin but generated elsewhere, so not on disk. */
const EXTERNAL_ROUTES = ['/feed.xml'];

/** Non-page files that may legitimately be linked. */
const STATIC_FILES = [
  '/llms.txt',
  '/robots.txt',
  '/sitemap.xml',
  '/site.webmanifest',
  '/security.txt',
  '/styles.css',
];

const PAGES = [...ROUTES.map((r) => r.file), '404.html'].filter((f) =>
  existsSync(join(ROOT, f))
);

/** Resolve an internal URL path to { file } or null if it is served elsewhere. */
function resolvePath(urlPath) {
  const clean = urlPath.split('#')[0].split('?')[0];
  if (clean === '' || clean === '/') return { file: 'index.html' };

  for (const r of ROUTES) if (clean === r.url) return { file: r.file };
  if (EXTERNAL_ROUTES.includes(clean)) return { external: true };
  if (STATIC_FILES.includes(clean)) {
    const rel = clean.replace(/^\//, '');
    return existsSync(join(ROOT, rel)) ? { file: rel } : { missing: rel };
  }

  const rel = decodeURIComponent(clean.replace(/^\//, ''));
  if (existsSync(join(ROOT, rel))) return { file: rel };
  return { missing: rel };
}

const idsOf = new Map();
const htmlByFile = new Map();
for (const f of PAGES) {
  const html = await readFile(join(ROOT, f), 'utf8');
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  for (const m of html.matchAll(/\sname="([^"]+)"/g)) ids.add(m[1]);
  idsOf.set(f, ids);
  htmlByFile.set(f, html);
}

const problems = [];
const external = new Set();

for (const [file, html] of htmlByFile) {
  const src = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of src.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const href = m[1];
    if (!href || /^(data:|mailto:|tel:|javascript:)/i.test(href)) continue;

    if (/^https?:\/\//i.test(href)) {
      external.add(href.split('#')[0]);
      continue;
    }

    const [target, fragment] = href.split('#');

    if (target === '') {
      if (fragment && !idsOf.get(file).has(fragment)) {
        problems.push(`${file}: #${fragment} has no matching id on this page`);
      }
      continue;
    }

    if (!target.startsWith('/')) {
      problems.push(`${file}: ${href} — relative internal link; use a root-relative path`);
      continue;
    }

    const r = resolvePath(target);
    if (r.missing) {
      problems.push(`${file}: ${href} — target does not exist (looked for ${r.missing})`);
      continue;
    }
    if (r.external || !fragment) continue;

    const ids = idsOf.get(r.file);
    if (!ids) continue; // fragment into a non-HTML asset: nothing to check
    if (!ids.has(fragment)) {
      problems.push(`${file}: ${href} — #${fragment} not found in ${r.file}`);
    }
  }
}

// every routed page should be reachable from the homepage
const home = htmlByFile.get('index.html') ?? '';
for (const route of ROUTES) {
  if (route.url === '/') continue;
  if (!home.includes(`href="${route.url}"`)) {
    problems.push(`index.html: no internal link to ${route.url} (orphaned page)`);
  }
}

const unique = [...new Set(problems)];
for (const p of unique) console.log(`FAIL ${p}`);

console.log(
  `\n${htmlByFile.size} pages scanned · ${unique.length} problem(s) · ` +
    `${external.size} external link(s) not fetched (by design)`
);
if (unique.length) console.log('\nFix these before merging.');

process.exit(unique.length ? 1 : 0);