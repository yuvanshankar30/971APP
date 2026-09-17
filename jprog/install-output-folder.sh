#!/bin/sh
set -eu

HUB_URL=${JPROG_OUTPUT_HUB_URL:-'__JPROG_OUTPUT_HUB_ORIGIN__'}
OUTPUT_REPOSITORY="https://github.com/yuvanshankar30/output.git"
DESKTOP_OUTPUT_DIR=${JPROG_OUTPUT_DIR:-"$HOME/Desktop/Output"}
LABEL="org.spartanshub.jprog-output-sync"

case "$(uname)" in
  Darwin)
    PLATFORM="macOS"
    SUPPORT_DIR="$HOME/Library/Application Support/SpartansHub/JProgOutput"
    LAUNCH_AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
    ;;
  Linux)
    PLATFORM="Linux"
    SUPPORT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/SpartansHub/JProgOutput"
    SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    ;;
  *)
    echo "This installer supports macOS and Linux. Use the PowerShell installer on Windows." >&2
    exit 1
    ;;
esac
REPO_DIR="$SUPPORT_DIR/repository"
SYNC_SCRIPT="$SUPPORT_DIR/sort_and_push.sh"

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

mkdir -p "$(dirname "$DESKTOP_OUTPUT_DIR")" "$SUPPORT_DIR"
if [ "$PLATFORM" = "macOS" ]; then
  mkdir -p "$(dirname "$LAUNCH_AGENT")"
else
  mkdir -p "$SYSTEMD_USER_DIR"
fi

# Keep the real checkout in Application Support and make the Desktop item a
# symlink. Finder presents that as an alias-style folder while drag-and-drop
# and command-line use still operate on the complete Git checkout.
if [ -L "$DESKTOP_OUTPUT_DIR" ]; then
  if ! REPO_DIR=$(cd "$DESKTOP_OUTPUT_DIR" && pwd -P); then
    echo "$DESKTOP_OUTPUT_DIR is a broken link. Remove it before installing." >&2
    exit 1
  fi
elif [ -e "$DESKTOP_OUTPUT_DIR" ]; then
  if ! git -C "$DESKTOP_OUTPUT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$DESKTOP_OUTPUT_DIR already exists but is not a Git checkout. Move it aside before installing." >&2
    exit 1
  fi
  legacy_origin=$(git -C "$DESKTOP_OUTPUT_DIR" remote get-url origin 2>/dev/null || true)
  case "$legacy_origin" in
    *github.com/yuvanshankar30/output*) ;;
    *)
      echo "$DESKTOP_OUTPUT_DIR is not the shared yuvanshankar30/output checkout. Refusing to move it." >&2
      exit 1
      ;;
  esac
  if [ -e "$REPO_DIR" ]; then
    echo "A shared output checkout already exists at $REPO_DIR. Resolve it before migrating $DESKTOP_OUTPUT_DIR." >&2
    exit 1
  fi
  echo "Moving the existing shared checkout behind the Desktop Output link ..."
  mv "$DESKTOP_OUTPUT_DIR" "$REPO_DIR"
  ln -s "$REPO_DIR" "$DESKTOP_OUTPUT_DIR"
else
  echo "Cloning the shared JProg output folder ..."
  git clone --quiet "$OUTPUT_REPOSITORY" "$REPO_DIR"
  ln -s "$REPO_DIR" "$DESKTOP_OUTPUT_DIR"
fi

if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$REPO_DIR is not a Git checkout. Refusing to install sync services." >&2
  exit 1
fi
origin=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)
case "$origin" in
  *github.com/yuvanshankar30/output*) ;;
  *)
    echo "$REPO_DIR is not the shared yuvanshankar30/output checkout. Refusing to use it." >&2
    exit 1
    ;;
esac
git -C "$REPO_DIR" fetch --quiet origin main
if git -C "$REPO_DIR" diff --quiet && git -C "$REPO_DIR" diff --cached --quiet; then
  git -C "$REPO_DIR" pull --ff-only --quiet origin main || true
else
  echo "Keeping existing local changes in $REPO_DIR; the sync service will retry them safely."
fi

if ! git -C "$REPO_DIR" config user.name >/dev/null; then
  login=$(gh api user --jq .login)
  git -C "$REPO_DIR" config user.name "$login"
  git -C "$REPO_DIR" config user.email "$login@users.noreply.github.com"
fi

# This installer deliberately reuses the shared repository's sync behavior
# rather than maintaining a second implementation. Refuse to install if an
# unexpected upstream script no longer provides the two guarantees operators
# rely on: remote-first syncing and Git rename detection.
for required_sync_behavior in "git pull --rebase --autostash" "git diff --cached --name-status -M"; do
  if ! grep -Fq "$required_sync_behavior" "$REPO_DIR/sort_and_push.sh"; then
    echo "The shared output repository is missing required sync behavior; refusing to install an incomplete local service." >&2
    exit 1
  fi
done

# The canonical repository keeps its sync script unchanged. Make a local,
# user-specific runner with only its checkout location substituted, so every
# workstation can use the same repository without committing machine paths.
awk -v repo_dir="$REPO_DIR" '
  /^REPO_DIR=/ {
    print "REPO_DIR=\"" repo_dir "\""
    next
  }
  { print }
' "$REPO_DIR/sort_and_push.sh" > "$SYNC_SCRIPT"
chmod 700 "$SYNC_SCRIPT"

if [ "$PLATFORM" = "macOS" ]; then
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
    <string>$REPO_DIR</string>
    <string>$REPO_DIR/JustinProgOutput</string>
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
else
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd user services are required on Linux for automatic shared-output sync." >&2
    exit 1
  fi
  cat > "$SYSTEMD_USER_DIR/$LABEL.service" <<EOF
[Unit]
Description=Spartans Hub JProg output synchronization

[Service]
Type=oneshot
ExecStart=$SYNC_SCRIPT
EOF
  cat > "$SYSTEMD_USER_DIR/$LABEL.timer" <<EOF
[Unit]
Description=Run JProg output synchronization every 30 seconds

[Timer]
OnBootSec=15s
OnUnitActiveSec=30s
Unit=$LABEL.service

[Install]
WantedBy=timers.target
EOF
  cat > "$SYSTEMD_USER_DIR/$LABEL.path" <<EOF
[Unit]
Description=Watch local JProg output files

[Path]
PathChanged=$REPO_DIR
PathChanged=$REPO_DIR/JustinProgOutput
Unit=$LABEL.service

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$LABEL.timer" "$LABEL.path"
  systemctl --user start "$LABEL.service"
fi

echo "Shared JProg output folder installed at: $DESKTOP_OUTPUT_DIR"
echo "Drop .ngc or .tap files into $DESKTOP_OUTPUT_DIR or $DESKTOP_OUTPUT_DIR/JustinProgOutput."
echo "The folder will sort, commit, push, and pull Hub changes automatically."
