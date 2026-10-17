# Loopwise — branch handoff

Branch `fix/truth-pass-2026-10-17`, 7 commits ahead of `main`. Nothing is merged.

## Merge it

    gh pr create --base main --head fix/truth-pass-2026-10-17 \
      --title "Correct claims the repositories contradict, and make them checkable"

or push straight to main (Cloudflare deploys from main).

## One thing I could not do: enable CI

`.github/workflows/ci.yml` is in this folder as `ci.yml` but is NOT committed.
The `NovaLux12` token has scopes `gist,read:org,repo` and GitHub refuses workflow
writes without `workflow` scope.

    gh auth refresh -h github.com -s workflow

then, from the repo:

    git add -f .github/workflows/ci.yml && git commit -m "Add CI" && git push

Until that lands, nothing runs the checks automatically. They all work locally:

    npm test

## Then, and only then

    gh api -X PUT repos/NovaLux12/loopwise.uk/branches/main/protection \
      -F required_status_checks[strict]=false \
      -F 'required_status_checks[contexts][]=verify' \
      -F enforce_admins=true \
      -F required_pull_request_reviews[required_approvals]=0 \
      -F restrictions[users][]=

(I have admin on the repo but did not apply this: requiring a status check that
does not exist yet would block every merge.)

## Still needs you, not a machine

1. **The inference cost figure.** `/build/` says every token is out of pocket
   and names no number. I did not invent one. Put the real figure there.
2. **Real sample artifacts.** The morning brief and the weekly report are still
   labelled illustrative because nothing has run on real hardware. Once the 780G
   lands, ship one redacted real capture of each — that is the highest-value
   remaining item, and it removes the "sample vs real" problem at the root.
