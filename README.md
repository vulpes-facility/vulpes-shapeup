# vulpes-shapeup

A GitHub App server that keeps each Shape Up pitch's hill chart in step with its scopes on the GitHub Project.\
Install the App on a repository, add `.github/shapeup.json`, and the charts follow the board,\
with no workflow and no secret in the repository.

> **Status: the server runs and ships as an image, but it has not yet run against GitHub; the admin API is not built.**\
> This README is the specification of the server.

## How it fits

| Part | Used by | Does |
| --- | --- | --- |
| [gh-vulpes-shapeup](https://github.com/vulpes-facility/gh-vulpes-shapeup) | People and agents: the `gh vulpes-shapeup` CLI, its Claude Code skill and the board Action | Writes pitches and scopes and changes the board |
| vulpes-shapeup (this repository) | The repositories the App is installed on | Draws the hill charts from what the board holds |

The server works the way Mend Renovate Community Edition does:\
one container that listens to webhooks, schedules work and runs it from a queue.\
Each organization runs its own server with its own GitHub App;\
nobody hosts it for other organizations.

## What it does

- **Reacts to the board.**\
  A change to a scope's Hill Position, a person's comment on a scope,\
  or a scope that opens, closes or reopens\
  queues the scope's pitch, and the worker redraws its chart.
- **Draws as the hill chart Action did.**\
  It renders the SVG, commits it to the `generated/shapeup` branch\
  and writes the chart between the hill markers of the pitch body,\
  only when the board no longer matches what the body last showed.
- **Heals what it missed.**\
  GitHub does not redeliver a failed webhook,\
  so a scheduled rebuild aligns every open pitch of every installed repository,\
  and the server runs one when it starts.
- **Follows the installations.**\
  Installing the App or adding a repository to it queues that repository;\
  a repository without `.github/shapeup.json` on its default branch is skipped.

## Components

All of them run in one process.

| Component | Role |
| --- | --- |
| HTTP server | `POST /webhook` for GitHub and `GET /healthz`; an admin API is planned |
| Webhook handler | Checks `X-Hub-Signature-256` over the raw body before parsing it, drops a repeated `X-GitHub-Delivery`, keeps only the events below and queues a job |
| Job queue | Jobs in PostgreSQL. One pending job per repository and pitch; a worker takes one with `FOR UPDATE SKIP LOCKED`, and never two for the same repository at once |
| Scheduler | Cron schedules for the rebuild and for the installation sync |
| Installation registry | The installations and repositories, each repository's config state and its last result |
| Token issuer | Signs the App's JWT with its private key and mints an installation token per job, narrowed to that repository |
| Config loader | Reads `.github/shapeup.json` from the default branch through the API and checks it with gh-vulpes-shapeup's `parseConfig` |
| Worker | Runs a job through the hill chart engine; retries a transient failure with backoff, and on `SIGTERM` finishes its job and stops |
| Job log | Each finished job's result, duration and error code |
| Migrations | Brings the database schema up to date at start |

Job priority, highest first:

1. A webhook event, since someone is likely waiting for the chart.
2. A repository that was just installed.
3. The scheduled rebuild.

The database holds only state the server can rebuild:\
losing it costs one installation sync and one rebuild.

## Events

| Event | Actions | Queues |
| --- | --- | --- |
| `projects_v2_item` | `edited`, on an item that is an issue, found through GraphQL | The issue, when it is a scope; the chart changes only if the board no longer matches it |
| `issues` | `opened`, `closed`, `reopened`, on an issue with the scope label | The scope's pitch |
| `issue_comment` | `created` by a person on an issue with the scope label | The scope's pitch |
| `installation`, `installation_repositories` | Created, added, removed, suspended | A sync, and a rebuild of each new repository |

`projects_v2_item` webhooks are in public preview,\
which is one more reason for the scheduled rebuild.

## Configuration

Everything that belongs to one organization comes from the environment.\
Secrets come from files, so that a deployment can mount them.

| Variable | Default | Value |
| --- | --- | --- |
| `SHAPEUP_PORT` | `8080` | The port to listen on |
| `SHAPEUP_GITHUB_API_URL` | `https://api.github.com` | The REST API root, for GitHub Enterprise Server |
| `SHAPEUP_APP_CLIENT_ID` | | The App's Client ID, the issuer of its JWT |
| `SHAPEUP_APP_PRIVATE_KEY_FILE` | | Path of the App's private key (PEM) |
| `SHAPEUP_WEBHOOK_SECRET_FILE` | | Path of the webhook secret |
| `SHAPEUP_DATABASE_URL_FILE` | | Path of the PostgreSQL connection string |
| `SHAPEUP_REBUILD_SCHEDULE` | `0 * * * *` | Cron schedule of the rebuild |
| `SHAPEUP_SYNC_SCHEDULE` | `0 */4 * * *` | Cron schedule of the installation sync, which also prunes jobs older than 30 days |
| `SHAPEUP_ADMIN_TOKEN_FILE` | | Path of the admin API's bearer token, read for the admin API that is not built yet |

The server does not start when a required variable or file is missing or invalid.\
A schedule has five numeric fields in UTC: minute, hour, day of month, month and day of week,\
each `*`, a number, a range, a step or a list of those; names and `@` macros are not taken.

## GitHub App

Create an App in the organization that owns the project, with these settings:

| Setting | Value |
| --- | --- |
| Webhook URL | `https://<host>/webhook` |
| Webhook secret | The contents of `SHAPEUP_WEBHOOK_SECRET_FILE` |
| Repository permissions | Contents: read and write (the chart commits), Issues: read and write (the pitch bodies), Metadata: read-only |
| Organization permissions | Projects: read-only |
| Events | Issues, Issue comment, Projects v2 item |
| Where it can be installed | Only on this account |

Install it on the repositories that use Shape Up, never on all of them.\
If the same App also serves the board Action, which changes the project, give it Projects: read and write;\
the server still narrows its own tokens to read.

## Running it

The server needs PostgreSQL, the App's private key and webhook secret as files,\
and a public HTTPS address that routes `/webhook` to it.\
Keep the admin API off the internet once it exists: its answers name private repositories.

```sh
npm ci --omit=dev
npm start   # node bin/server.mjs
```

At start the server migrates the database, syncs the installations and queues a rebuild of every repository,\
so whatever happened while it was down is healed.\
It logs one JSON line per event to stdout, with codes, names and numbers only.\
On `SIGTERM` or `SIGINT` it stops taking webhooks, finishes the job in hand and exits.

Or run the image, with the secrets mounted as files:

```sh
docker run -p 8080:8080 -v /path/to/secrets:/run/secrets/shapeup:ro \
  -e SHAPEUP_APP_CLIENT_ID=<client id> \
  -e SHAPEUP_APP_PRIVATE_KEY_FILE=/run/secrets/shapeup/key.pem \
  -e SHAPEUP_WEBHOOK_SECRET_FILE=/run/secrets/shapeup/webhook-secret \
  -e SHAPEUP_DATABASE_URL_FILE=/run/secrets/shapeup/database-url \
  ghcr.io/vulpes-facility/vulpes-shapeup:<version>
```

The image runs as the `node` user on `linux/amd64`.

## Releases

Pushing a `vX.Y.Z` tag on a commit of `main` runs `.github/workflows/release.yml`,\
which builds the image and pushes it as `ghcr.io/vulpes-facility/vulpes-shapeup:X.Y.Z` and `X.Y`.\
The tag's version matches `version` in `package.json`.\
This repository only publishes images; each organization deploys them on its own.

## What does not live here

This repository holds code and documentation only.\
No private key, webhook secret, database credential, deployment manifest or organization's setting is ever committed here;\
each organization keeps those with its own deployment.

## Development

```sh
npm ci                                                       # gh-vulpes-shapeup, pinned in package.json
npm test                                                     # every test, one file at a time
node test/render-fixtures.mjs | python3 test/validate-svg.py  # parse the rendered SVGs with a real XML parser
```

The tests in `test/db.test.mjs` and `test/main.test.mjs` run only when `SHAPEUP_TEST_DATABASE_URL` names a throwaway database,\
which they empty first; CI gives them one.\
Locally, a container serves:

```sh
docker run -d --rm --name shapeup-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=shapeup_test -p 127.0.0.1:55432:5432 postgres:17-alpine
SHAPEUP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/shapeup_test npm test
```

The hill chart engine came from gh-vulpes-shapeup v2:\
`src/service.mjs` (`HillService`), `src/store.mjs` (`GeneratedStore`) and `src/render.mjs` (the SVG renderer).\
It imports the config, the hill block and the `GitHub` transport from gh-vulpes-shapeup's `exports`.

## License

[MIT](LICENSE)
