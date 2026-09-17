#!/bin/sh
set -eu

HUB_URL=${JPROG_OUTPUT_HUB_URL:-'__JPROG_OUTPUT_HUB_ORIGIN__'}
OUTPUT_REPOSITORY="https://github.com/yuvanshankar30/output.git"
OUTPUT_DIR=${JPROG_OUTPUT_DIR:-"$HOME/Desktop/Output"}
SUPPORT_DIR="$HOME/Library/Application Support/SpartansHub/JProgOutput"
SYNC_SCRIPT="$SUPPORT_DIR/sort_and_push.sh"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/org.spartanshub.jprog-output-sync.plist"
LABEL="org.spartanshub.jprog-output-sync"

if [ "$(uname)" != "Darwin" ]; then
  echo "The shared JProg output-folder installer currently supports macOS." >&2
  exit 1
fi

echo "Installing shared JProg output from $HUB_URL ..."

if ! command -v git >/dev/null 2>&1; then
  echo "Git is required. Install Xcode Command Line Tools, then run this command again:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing GitHub CLI..."
    brew install gh
  else
    echo "GitHub CLI is required for automatic commits and pushes. Install it from https://cli.github.com/, then run this command again." >&2
    exit 1
  fi
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Sign in to GitHub so this folder can commit and push your changes."
  gh auth login --web --git-protocol https
fi
gh auth setup-git

mkdir -p "$(dirname "$OUTPUT_DIR")" "$SUPPORT_DIR" "$(dirname "$LAUNCH_AGENT")"

if [ -e "$OUTPUT_DIR" ]; then
  if ! git -C "$OUTPUT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$OUTPUT_DIR already exists but is not a Git checkout. Move it aside before installing." >&2
    exit 1
  fi
  origin=$(git -C "$OUTPUT_DIR" remote get-url origin 2>/dev/null || true)
  case "$origin" in
    *github.com/yuvanshankar30/output*) ;;
    *)
      echo "$OUTPUT_DIR is not the shared yuvanshankar30/output checkout. Refusing to replace it." >&2
      exit 1
      ;;
  esac
  git -C "$OUTPUT_DIR" fetch --quiet origin main
  if git -C "$OUTPUT_DIR" diff --quiet && git -C "$OUTPUT_DIR" diff --cached --quiet; then
    git -C "$OUTPUT_DIR" pull --ff-only --quiet origin main || true
  else
    echo "Keeping existing local changes in $OUTPUT_DIR; the sync service will retry them safely."
  fi
else
  echo "Cloning the shared JProg output folder into $OUTPUT_DIR ..."
  git clone --quiet "$OUTPUT_REPOSITORY" "$OUTPUT_DIR"
fi

if ! git -C "$OUTPUT_DIR" config user.name >/dev/null; then
  login=$(gh api user --jq .login)
  git -C "$OUTPUT_DIR" config user.name "$login"
  git -C "$OUTPUT_DIR" config user.email "$login@users.noreply.github.com"
fi

# The canonical repository keeps its sync script unchanged. Make a local,
# user-specific runner with only its checkout location substituted, so every
# workstation can use the same repository without committing machine paths.
awk -v repo_dir="$OUTPUT_DIR" '
  /^REPO_DIR="\/Users\/yuvan\/Output"$/ {
    print "REPO_DIR=\"" repo_dir "\""
    next
  }
  { print }
' "$OUTPUT_DIR/sort_and_push.sh" > "$SYNC_SCRIPT"
chmod 700 "$SYNC_SCRIPT"

cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$SYNC_SCRIPT</string></array>
  <key>WatchPaths</key>
  <array>
    <string>$OUTPUT_DIR</string>
    <string>$OUTPUT_DIR/JustinProgOutput</string>
  </array>
  <key>StartInterval</key>
  <integer>30</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/jprog-output-sort.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/jprog-output-sort.stderr.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Shared JProg output folder installed at: $OUTPUT_DIR"
echo "Drop .ngc or .tap files into $OUTPUT_DIR or $OUTPUT_DIR/JustinProgOutput."
echo "The folder will sort, commit, push, and pull Hub changes automatically."
