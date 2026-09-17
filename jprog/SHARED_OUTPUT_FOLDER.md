# Shared Output Folder

Install the team’s shared CNC output folder on a Mac with:

```sh
sh -c "$(curl -fsSL https://spartanshub.spartanrobotics.org/install/jprog-output)"
```

The installer opens GitHub sign-in when needed, clones the separate
[`yuvanshankar30/output`](https://github.com/yuvanshankar30/output) repository
into the user’s Application Support folder, then creates `~/Desktop/Output` as
a symlink to that complete checkout. Finder displays the Desktop link with its
alias-style arrow; that arrow means shortcut, not network sharing. Git and the
installed sync service provide the sharing. To put the Desktop link elsewhere,
set `JPROG_OUTPUT_DIR` before running the command.

## What Gets Installed

- A complete shared output repository checkout, exposed on the Desktop as
  `~/Desktop/Output`. Opening it shows every repository file and folder.
- A private, user-path-aware copy of the repository’s existing
  `sort_and_push.sh`. The shared repository’s code and layout are not changed;
  the installer only substitutes the local checkout path in the installed copy.
- A macOS LaunchAgent named `org.spartanshub.jprog-output-sync`, watching the
  checkout and running every 30 seconds.

The GitHub CLI credential helper authorizes pushes with the signed-in person’s
GitHub account. When necessary, the installer sets the author name and email
only for this local checkout.

## Automatic Local Changes

Drop `.ngc` or `.tap` files into `~/Desktop/Output` or directly into
`~/Desktop/Output/JustinProgOutput`.

The installed script retains the full existing shared-folder behavior:

1. It detects local file drops immediately through macOS `WatchPaths`.
2. It files dropped G-code under `JustinProgOutput/YYYYMMDD/` using the current
   Pacific date.
3. It stages additions and changes under `JustinProgOutput`, then creates and
   pushes a Git commit automatically.
4. It uses Git similarity detection, so manually renaming a `.ngc` or `.tap`
   file becomes a Git rename instead of an unrelated delete and re-add.
5. It publishes deliberate G-code deletions, but restores unexpected
   non-G-code deletions rather than silently losing them.
6. It retains a local commit when the network is unavailable and retries that
   push on later runs.

## Hub-To-Folder Sync

The same script fetches and rebases from `origin/main` before it looks at local
changes. As a result, uploads, renames, deletes, and folders changed through
the Hub Output Repository editor are pulled into every installed local folder
within the next 30-second interval, even when nobody touches that Mac.

The timer is important: `WatchPaths` only notices disk changes, while a Hub
editor commit starts on GitHub. The periodic run supplies the other direction
of the sync. If a local uncommitted change conflicts with a Hub edit, the
script leaves the local files alone, logs the failed rebase, and retries later
instead of discarding either person’s work.

The repository root, including the `JustinProgOutput` handoff folder, cannot
be renamed or removed through the Hub editor. Date folders and their G-code
files remain manageable there.

## Logs And Removal

The sync log is `/tmp/jprog-output-sort.log`. LaunchAgent output is written to
`/tmp/jprog-output-sort.stdout.log` and `/tmp/jprog-output-sort.stderr.log`.

To stop automatic sync while keeping the checkout:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.spartanshub.jprog-output-sync.plist"
rm "$HOME/Library/LaunchAgents/org.spartanshub.jprog-output-sync.plist"
```

Before machining, verify the controller format, stock, workholding, tools,
origin, units, and intended operation. The shared folder is an archive and
delivery path, not a replacement for normal CNC verification.
