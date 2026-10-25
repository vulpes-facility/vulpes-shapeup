# CLAUDE.md

vulpes-shapeup is the GitHub App server that draws Shape Up hill charts from the GitHub Project,\
on the hill chart engine that gh-vulpes-shapeup handed over in its v2.\
The server runs against GitHub from 0.2.0 on, and the admin API is not built.

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
- The queue's SQL is tested against a real PostgreSQL in `test/db.test.mjs`, never a fake,\
  and `SHAPEUP_TEST_DATABASE_URL` MUST name a throwaway database, since the tests empty it.\
  Test files MUST run one at a time (`npm test`), because two of them share that database.
- Logs are JSON lines of codes, names and numbers; only a `ShapeUpError`'s message MAY be logged,\
  and never a token, body, header value or secret.
- A schema change is a new entry at the end of `migrations` in `src/db.mjs`; an applied migration is never edited.

## Index

- `bin/server.mjs` - The process entry: starts the server and stops it on `SIGTERM` or `SIGINT`.
- `src/main.mjs` - Wires every component into one process, heals at start, and stops after the job in hand.
- `src/worker.mjs` - `Worker`, which runs one job at a time through the engine and retries transient failures with backoff.
- `src/scheduler.mjs` - `Scheduler`, which starts the sync, rebuild and maintenance tasks on their cron minutes.
- `src/cron.mjs` - The five-field numeric cron parser and matcher, in UTC.
- `src/sync.mjs` - The installation sync and the scheduled rebuild's queuing.
- `README.md` - What the server does, its components, events, configuration, the GitHub App it needs and the test commands.
- `package.json` - The Node 24 requirement and the pinned gh-vulpes-shapeup dependency.
- `src/settings.mjs` - Reads the README's environment variables and secret files, and refuses to start without them.
- `src/app-auth.mjs` - The App's JWT, and installation tokens narrowed to one repository and the job's permissions.
- `src/repository-config.mjs` - Reads `.github/shapeup.json` from a repository's default branch, or says why it is skipped.
- `src/http.mjs` - The HTTP server: `POST /webhook` with a body limit and `GET /healthz`; it logs no body, header value or token.
- `src/webhook.mjs` - The signature check and `WebhookHandler`, which turns issue, comment, board and installation events into jobs and registry changes.
- `src/project-items.mjs` - Finds the issue and repository behind a `projects_v2_item` event through GraphQL.
- `src/db.mjs` - The PostgreSQL pool, the wait for PostgreSQL at start, and the migrations: installations, repositories, jobs and deliveries.
- `src/queue.mjs` - `Queue`, which coalesces, prioritizes and claims jobs one repository at a time, and `Deliveries`, which drops repeated webhooks.
- `src/registry.mjs` - `Registry`, the installations and repositories the App reaches and each repository's last result.
- `src/service.mjs` - `HillService`, which aligns the hill chart of a pitch with its scopes' positions, and on a rebuild every open pitch and every pitch closed in the last seven days.
- `src/store.mjs` - `GeneratedStore`, which commits the charts to the orphan `generated/` branch through the Git Data API.
- `src/render.mjs` - The SVG renderer, the chart link and the check that an issue is a scope or a pitch.
- `test/` - Unit tests on fakes, the SVG fixtures and `validate-svg.py`, which parses them in CI.
- `.github/workflows/test.yml` - CI for the unit tests, with a throwaway PostgreSQL, and the SVG check.
- `.github/workflows/release.yml` - Builds the image on a `vX.Y.Z` tag and pushes it to GitHub Container Registry.
- `Dockerfile` - The production image: Node 24 on Alpine, pinned by digest, production dependencies only, run as `node`.
- `.dockerignore` - Lets only `package.json`, the lockfile, `bin/` and `src/` into the image.
- `assets/` - The App's icon: `icon.png` at full size and `icon-512.png` for the GitHub App logo.
- `LICENSE` - The MIT License.
- `.gitattributes` - LF line endings for every text file.
