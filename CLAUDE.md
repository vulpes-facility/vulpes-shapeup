# CLAUDE.md

vulpes-shapeup is the GitHub App server that draws Shape Up hill charts from the GitHub Project,\
on the hill chart engine that gh-vulpes-shapeup hands over in its v2.\
It is at the design stage: the README is the specification, and there is no code yet.

## Rules

- This repository is public and serves any organization that runs it with its own App,\
  so it MUST NOT hold a private key, a webhook secret, a database credential, a deployment manifest or any organization's setting.
- Everything organization-specific MUST come from the environment variables in the README.
- A workflow MUST pin every action to a full-length commit SHA, as the organization requires,\
  and MUST NOT use the `pull_request_target` trigger.
- Every commit MUST be signed, since the organization requires signed commits on the default branch.

## Index

- `README.md` - What the server does, its components, events, configuration and the GitHub App it needs.
- `LICENSE` - The MIT License.
- `.gitattributes` - LF line endings for every text file.
