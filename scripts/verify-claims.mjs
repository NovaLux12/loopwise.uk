#!/usr/bin/env node
/**
 * verify-claims.mjs — fail CI when a published claim stops being true.
 *
 * The site states numbers and names as facts. This script re-checks every
 * entry in claims.json against the live GitHub API and exits non-zero on
 * drift. The point is that a stale claim should break the build instead of
 * quietly rotting on a page until someone notices.
 *
 *   node scripts/verify-claims.mjs            # verify, human-readable
 *   node scripts/verify-claims.mjs --json     # machine-readable, for CI
 *
 * Set GITHUB_TOKEN (or GH_TOKEN) to raise the API rate limit from 60/h.
 * The script is read-only: it never writes to GitHub and never mutates the repo.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const AS_JSON = process.argv.includes('--json');
const UA = 'loopwise-claims-verifier';

const manifest = JSON.parse(await readFile(join(ROOT, 'claims.json'), 'utf8'));

/* ---------------------------------------------------------------- fetch --- */

const apiCache = new Map();
const rawCache = new Map();

async function api(path) {
  if (apiCache.has(path)) return apiCache.get(path);
  const url = `https://api.github.com${path}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    apiCache.set(path, null);
    return null;
  }
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    throw new Error(
      `GitHub API rate limit hit on ${path}` +
        (reset ? ` (resets ${new Date(Number(reset) * 1000).toISOString()})` : '') +
        '. Set GITHUB_TOKEN to raise the limit.'
    );
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}`);
  const json = await res.json();
  apiCache.set(path, json);
  return json;
}

const branchCache = new Map();

/** raw.githubusercontent needs an explicit ref: /owner/repo/<ref>/<path>. */
async function defaultBranch(repo) {
  if (branchCache.has(repo)) return branchCache.get(repo);
  const meta = await api(`/repos/${repo}`);
  const b = meta?.default_branch ?? 'main';
  branchCache.set(repo, b);
  return b;
}

async function raw(repo, path) {
  const key = `${repo}/${path}`;
  if (rawCache.has(key)) return rawCache.get(key);
  const ref = await defaultBranch(repo);
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const text = res.ok ? await res.text() : null;
  if (text === null) {
    throw new Error(`could not fetch ${repo}/${ref}/${path} (HTTP ${res.status})`);
  }
  rawCache.set(key, text);
  return text;
}

const full = (alias) => {
  const r = manifest.repos[alias];
  if (!r) throw new Error(`unknown repo alias "${alias}" in claims.json`);
  return r;
};

function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/* --------------------------------------------------------------- checks --- */

const versionKey = (s) => {
  const [maj, min] = String(s).split('.').map((n) => parseInt(n, 10) || 0);
  return maj * 1000 + min;
};

const checks = {
  async repo({ repo, field }) {
    const r = await api(`/repos/${full(repo)}`);
    return r ? dig(r, field) : null;
  },

  async pathExists({ repo, path }) {
    const r = await api(`/repos/${full(repo)}/contents/${path}`);
    return r !== null;
  },

  async dirCount({ repo, path, exclude = [] }) {
    const r = await api(`/repos/${full(repo)}/contents/${path}`);
    if (!r) return null;
    return r.filter((f) => f.type === 'file' && !exclude.includes(f.name)).length;
  },

  async releaseCount({ repo }) {
    const r = await api(`/repos/${full(repo)}/releases?per_page=100`);
    return Array.isArray(r) ? r.length : null;
  },

  /**
   * State of one specific issue. Preferred over counting open issues:
   * open_issues_count also counts open pull requests, and it drifts every
   * time anything is triaged, so asserting it would fail CI for no useful
   * reason.
   */
  async issueState({ repo, number }) {
    const r = await api(`/repos/${full(repo)}/issues/${number}`);
    return r ? r.state : null;
  },

  async latestRelease({ repo, field }) {
    const r = await api(`/repos/${full(repo)}/releases?per_page=100`);
    if (!Array.isArray(r) || r.length === 0) return null;
    // newest by publish date, not API order
    const newest = [...r].sort((a, b) =>
      String(b.published_at ?? '').localeCompare(String(a.published_at ?? ''))
    )[0];
    return dig(newest, field);
  },

  async tomlKey({ repo, path, key }) {
    const text = await raw(full(repo), path);
    if (!text) return null;
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
    return m ? m[1] : null;
  },

  async ciMatrix({ repo, path, key, pick = 'min' }) {
    const text = await raw(full(repo), path);
    if (!text) return null;
    // matches: python-version: ['3.9', '3.10']  |  python-version: [3.9, 3.10]
    const m = text.match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]+)\\]`));
    if (!m) return null;
    const versions = [...m[1].matchAll(/\d+\.\d+/g)].map((v) => v[0]);
    if (versions.length === 0) return null;
    const sorted = [...versions].sort((a, b) => versionKey(a) - versionKey(b));
    // de-duplicate so a repeated version cannot skew min/max
    const unique = [...new Set(sorted)];
    return pick === 'max' ? unique[unique.length - 1] : unique[0];
  },

  async countPublicOf() {
    const names = Object.values(manifest.repos);
    // Read .private rather than treating a 404 as "private": an authenticated
    // request for your own private repo returns 200, not 404, so a
    // status-code check would quietly count nightscout-mcp as public.
    const flags = await Promise.all(
      names.map(async (n) => {
        try {
          const r = await api(`/repos/${n}`);
          return r ? r.private !== true : false;
        } catch {
          return false;
        }
      })
    );
    return flags.filter(Boolean).length;
  },
};

/* ----------------------------------------------------------------- main --- */

const results = [];
let hardFailures = 0;
let softFailures = 0;

for (const claim of manifest.claims) {
  const { check } = claim;
  const fn = checks[check?.type];
  let actual;
  let error = null;

  if (!fn) {
    error = `unknown check type "${check?.type}"`;
  } else {
    try {
      actual = await fn(check);
    } catch (e) {
      error = e.message;
    }
  }

  // A null actual on a 404 means "not found", which is a real answer for
  // pathExists(false) but a broken expectation for everything else.
  const pass = !error && JSON.stringify(actual) === JSON.stringify(claim.expect);

  if (pass) {
    results.push({ id: claim.id, pass: true, expect: claim.expect, actual });
    continue;
  }

  const kind = error || actual === null ? 'UNVERIFIED' : 'FAIL';
  if (kind === 'UNVERIFIED') softFailures += 1;
  else hardFailures += 1;
  results.push({
    id: claim.id,
    pass: false,
    kind,
    expect: claim.expect,
    actual: actual === undefined ? '(not checked)' : actual,
    error,
    assertedIn: claim.assertedIn,
    note: claim.note,
  });

  // optional: the literal must still be present in the page that states it
  if (claim.htmlMustContain) {
    for (const file of Object.keys(claim.htmlMustContain)) {
      const body = await readFile(join(ROOT, file), 'utf8');
      if (!body.includes(claim.htmlMustContain[file])) {
        hardFailures += 1;
        results.push({
          id: `${claim.id} (html literal in ${file})`,
          pass: false,
          kind: 'FAIL',
          error: `expected ${file} to still contain: ${claim.htmlMustContain[file]}`,
        });
      }
    }
  }
}

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        ok: hardFailures === 0 && softFailures === 0,
        hardFailures,
        softFailures,
        total: results.length,
        results,
      },
      null,
      2
    )
  );
} else {
  const pad = Math.max(...results.map((r) => r.id.length));
  for (const r of results) {
    const mark = r.pass ? 'ok  ' : r.kind === 'UNVERIFIED' ? 'warn' : 'FAIL';
    const got = r.actual === null ? 'not found' : JSON.stringify(r.actual);
    console.log(`[${mark}] ${r.id.padEnd(pad)}  expect ${JSON.stringify(r.expect)}  got ${got}`);
    if (r.error) console.log(`         ${r.error}`);
    if (!r.pass && r.assertedIn) console.log(`         stated in: ${r.assertedIn.join(', ')}`);
    if (!r.pass && r.note) console.log(`         note: ${r.note}`);
  }
  console.log(
    `\n${results.length} claims checked · ${results.length - hardFailures - softFailures} ok · ` +
      `${hardFailures} failed · ${softFailures} unverified`
  );
  if (hardFailures) {
    console.log(
      '\nA claim drifted from reality. Either the site is now wrong, or\n' +
        'claims.json is out of date. Fix whichever is actually untrue before merging.'
    );
  }
}

process.exit(hardFailures === 0 ? 0 : 1);