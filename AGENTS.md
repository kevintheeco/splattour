# Repository workflow

## Requests to publish changes to pochak.kr (formerly 3dgstour.com)

- Since 2026-11-18 the public site is the Cloudflare Worker `pochak` (account
  tinydots Inc.), not Vercel. `3dgstour.com` 301-redirects to `pochak.kr`.
  Deploy and secrets: `cloudflare/README.md`.

- User-confirmed on 2026-10-06: submit changes as a pull request to
  `https://github.com/kevintheeco/splattour` (`upstream`). Its current default
  branch is `master`; query the repository if the default branch changes.
- A request to reflect this project's changes on the remote site authorizes
  preparing a focused branch and submitting that upstream PR. Do not ask for
  hosting account access or team invitations as the normal delivery workflow.
- Preserve unrelated local/staged work. Prepare the PR in an isolated checkout
  when this working tree contains other changes.
- `origin` (`https://github.com/Jimin0430/splattour`) is a separate personal
  repository, NOT a GitHub fork (verified 2026-10-06). Cross-repository PRs from
  it fail. The user has WRITE access to `upstream`: push a new feature branch
  there and open a PR against its default branch. Never push directly to the
  default branch.
- Report the PR URL. Opening a PR is not evidence that it has been merged or
  deployed; only claim the live site changed after verifying the deployment.
- Do not merge the PR or change hosting accounts unless separately instructed.
