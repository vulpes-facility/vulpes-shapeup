# CLAUDE.md

vulpes-shapeup is the GitHub App server that draws Shape Up hill charts from the GitHub Project,\
on the hill chart engine that gh-vulpes-shapeup handed over in its v2.\
The engine, the settings and the App's authentication are here; the webhook handler, queue and worker are not built yet.

## Rules

- This repository is public and serves any organization that runs it with its own App,\
  so it MUST NOT hold a private key, a webhook secret, a database credential, a deployment manifest or any organization's setting.
- Everything organization-specific MUST come from the environment variables in the README.
- A workflow MUST pin every action to a full-length commit SHA, as the organization requires,\
  and MUST NOT use the `pull_request_target` trigger.
- Every commit MUST be signed, since the organization requires signed commits on the default branch.
- `main` changes only through pull requests merged with a merge commit; a ruleset blocks force pushes and deletion, with no bypass.
- gh-vulpes-shapeup MUST be pinned in `package.json` to a commit or a version tag, never to a branch,\
  and only its `exports` (`config`, `domain`, `github`) MAY be imported.
- Tests MUST NOT reach GitHub: every class takes its collaborators as arguments, and tests pass fakes.

## Index

- `README.md` - What the server does, its components, events, configuration, the GitHub App it needs and the test commands.
- `package.json` - The Node 24 requirement and the pinned gh-vulpes-shapeup dependency.
- `src/settings.mjs` - Reads the README's environment variables and secret files, and refuses to start without them.
- `src/app-auth.mjs` - The App's JWT, and installation tokens narrowed to one repository and the job's permissions.
- `src/repository-config.mjs` - Reads `.github/shapeup.json` from a repository's default branch, or says why it is skipped.
- `src/service.mjs` - `HillService`, which aligns the hill chart of a pitch with its scopes' positions.
- `src/store.mjs` - `GeneratedStore`, which commits the charts to the orphan `generated/` branch through the Git Data API.
- `src/render.mjs` - The SVG renderer, the chart link and the check that an issue is a scope or a pitch.
- `test/` - Unit tests on fakes, the SVG fixtures and `validate-svg.py`, which parses them in CI.
- `.github/workflows/test.yml` - CI for the unit tests and the SVG check.
- `LICENSE` - The MIT License.
- `.gitattributes` - LF line endings for every text file.
