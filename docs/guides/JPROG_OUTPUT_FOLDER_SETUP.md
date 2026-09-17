# Shared JProg Output Folder

Install the team’s shared CNC output folder on a Mac with:

```sh
sh -c "$(curl -fsSL https://spartanshub.spartanrobotics.org/install/jprog-output)"
```

The installer opens GitHub sign-in when needed, then clones the separate
[`yuvanshankar30/output`](https://github.com/yuvanshankar30/output) repository
to `~/Desktop/Output`. Set `JPROG_OUTPUT_DIR` before running the command only
when a different local folder is required.

## What It Installs

- The shared output checkout at `~/Desktop/Output`.
- A local copy of the repository’s existing `sort_and_push.sh`, configured for
  that user’s Desktop path without changing the shared repository’s files or
  layout.
- A macOS LaunchAgent named `org.spartanshub.jprog-output-sync`. It watches the
  output checkout and also runs every 30 seconds.

The installer uses the GitHub CLI’s credential helper, so commits and pushes
use the signed-in person’s GitHub account. Git author details are configured
only in this checkout when they are not already present.

## Automatic Sync

Drop `.ngc` or `.tap` programs into `~/Desktop/Output` or directly into
`~/Desktop/Output/JustinProgOutput`.

On each run, the sync service:

1. Pulls commits made through Spartans Hub’s Output Repository editor.
2. Moves newly dropped G-code into `JustinProgOutput/YYYYMMDD/`, using the
   current Pacific date.
3. Commits and pushes additions, G-code renames, and G-code deletions under
   `JustinProgOutput`.

The service safely retries a push after an offline period. It does not publish
unexpected non-G-code deletions. The repository root, including the
`JustinProgOutput` handoff folder, remains protected from rename and deletion
in the Hub editor.

## Logs And Removal

The sync log is at `/tmp/jprog-output-sort.log`; launchd process output is at
`/tmp/jprog-output-sort.stdout.log` and `/tmp/jprog-output-sort.stderr.log`.

To stop automatic sync while keeping the checkout:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.spartanshub.jprog-output-sync.plist"
rm "$HOME/Library/LaunchAgents/org.spartanshub.jprog-output-sync.plist"
```

Before running any program, verify the controller format, stock, workholding,
tools, origin, units, and intended operation. The shared folder is an archive
and delivery path, not a substitute for normal CNC verification.
