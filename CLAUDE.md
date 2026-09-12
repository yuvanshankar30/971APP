# Spartans Hub — instructions for Claude Code

Full contributing conventions (branching, PRs, migrations, secrets, code
style, design system, docs) live in `docs/CONTRIBUTING.md` — read it before
making changes here, and follow it the same way you'd follow a direct
instruction from the user.

One rule called out specifically because it's easy to skip: **before
starting work on an existing branch, check whether it has an open PR and
read that PR's description *and comments* first**
(`gh pr list --repo frc971/spartanshub --state open`, then
`gh pr view <number> --repo frc971/spartanshub --json title,body,comments,reviews`).
A branch's commit history doesn't tell you about review feedback, scope
changes, or "don't merge this yet" warnings — those live in the PR. Do this
before reading code or planning any change, including when you're the one
returning to your own earlier branch.
