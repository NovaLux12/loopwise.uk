# loopwise.uk

The public site for **Loopwise Health** — a bootstrapped health-infrastructure
startup building open Type 1 diabetes tooling.

Live at <https://loopwise.uk/>.

## The three pages

| Page | What it is |
|---|---|
| [`index.html`](index.html) | The everyday-person front door: what you get (a morning brief, a weekly clinic page, a written record), how it works, who it is for, the sample brief, the pilot programme, a plain-language FAQ and contact. The only acronyms on it are Nightscout, CGM and MIT, and each is explained where it appears. |
| [`build.html`](build.html) | The engineering page: the repositories, what each one does, and the claims this project makes about its own work. |
| [`research.html`](research.html) | A read-only research page on the Medtronic CareLink API surface. |

[`llms.txt`](llms.txt) is the same summary written for an agent rather than a
person.

## A site that cannot quietly rot

Every factual figure the pages publish is declared in
[`claims.json`](claims.json) — 23 of them at present — together with the
source it must agree with. [`scripts/verify-claims.mjs`](scripts/verify-claims.mjs)
re-checks each one against the live GitHub API and exits non-zero on drift, so
a stale claim fails the build instead of rotting quietly on a page.

That is the whole point of the mechanism: the site makes claims about
repositories that change on their own schedule, and a claim that stops
matching the repository it describes should be caught by a machine rather than
by a reader noticing.

The check types are the interesting part — they are not all "look up a
repository": `repo`, `ciMatrix`, `countPublicOf`, `countPublicTools`,
`dirCount`, `issueState`, `latestRelease`, `pathExists`, `releaseCount`,
`tomlKey`.

## Development

```bash
npm ci
npm test
```

`npm test` runs the four gates CI runs:

- `lint:html` — `html-validate` over the three pages
- `lint:css` — `stylelint` over `styles.css` and `css/`
- `check:links` — internal links and anchors resolve
- `verify:claims` — every published claim still agrees with the GitHub API

## Deployment

The site is served by a Cloudflare Worker. [`wrangler.toml`](wrangler.toml)
holds the deployment config, including the routing that keeps it on the
`loopwise.uk` edge rather than a `workers.dev` subdomain — the security
headers the Worker sets do not apply off the edge.

### The Worker source is not in this repository

`wrangler.toml` names `worker.js` as the module entrypoint, but `worker.js` is
**deliberately untracked** (see `.gitignore` for the reasoning). The deployed
source is maintained in the workspace working copy at
`projects/loopwise-health/worker.js` and uploaded with a multipart modules
PUT.

The reason is the `PIN` constant at the top of the Worker. It is a commit
hash, and the Worker serves the static assets for **that** commit from
jsDelivr. Tracking `worker.js` here would put the Worker and the assets it
serves in the same commit — so the Worker would serve the commit that
contains it, and the pin would be chasing its own tail. The pin is bumped by
hand for every deploy instead. That coupling is what broke on 2026-10-08.

Concretely, a deploy is:

1. Commit the site files here, and note the commit hash.
2. Bump `PIN` in the workspace `worker.js` to that hash.
3. Upload the Worker with a multipart modules PUT — **not** `wrangler deploy`,
   which would enable `workers.dev` and take the site off the `loopwise.uk`
   edge.
4. The Worker now serves the assets from step 1 and reports repo activity
   from the live API.

## Licence

MIT. See [`LICENSE`](LICENSE).
