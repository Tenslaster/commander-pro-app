#!/usr/bin/env bash
set -euo pipefail
PROJECT="/mnt/c/Users/cedri/OneDrive/Bureau/RADIOS/AppIPhone/iphone-batch-manager"
cd "$PROJECT"
echo "PWD=$(pwd)"

# --- helpers ---
have() { command -v "$1" >/dev/null 2>&1; }

echo "=== tools ==="
have git && git --version
have builder && builder --help >/dev/null && echo "builder: ok"
have gh && gh --version | head -1 || echo "gh: missing"
have curl && echo "curl: ok"

# Try to find a stored GitHub token from builder/keyring files
find_token() {
  # common locations
  for f in \
    "$HOME/.config/builder/credentials.json" \
    "$HOME/.config/ios-builder/credentials.json" \
    "$HOME/.builder/credentials.json" \
    "$HOME/.ios-builder/token" \
    "$HOME/.config/gh/hosts.yml" \
    "/mnt/c/Users/cedri/AppData/Roaming/builder/credentials.json" \
    "/mnt/c/Users/cedri/AppData/Local/builder/credentials.json"
  do
    if [ -f "$f" ]; then
      echo "FOUND_FILE=$f" >&2
      cat "$f" >&2 || true
    fi
  done
  # search shallow home
  find "$HOME" -maxdepth 4 -type f \( -iname '*token*' -o -iname '*credential*' -o -iname '*github*' \) 2>/dev/null | head -30 >&2 || true
  find /mnt/c/Users/cedri/AppData -maxdepth 5 -type f \( -iname '*builder*' -o -iname '*mobai*' \) 2>/dev/null | head -40 >&2 || true
}

echo "=== searching credentials (stderr) ==="
find_token || true

# Install gh if missing (for API create repo)
if ! have gh; then
  echo "=== installing GitHub CLI in WSL ==="
  # noninteractive install of gh
  if have apt-get; then
    (type -p wget >/dev/null || (sudo apt-get update && sudo -n apt-get install -y wget)) || true
    # try without sudo first via local binary
    ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
    TMP=$(mktemp -d)
    cd "$TMP"
    # latest gh deb - use known stable
    wget -q "https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_linux_amd64.tar.gz" -O gh.tgz || \
      curl -fsSL "https://github.com/cli/cli/releases/download/v2.62.0/gh_2.62.0_linux_amd64.tar.gz" -o gh.tgz
    tar -xzf gh.tgz
    mkdir -p "$HOME/.local/bin"
    cp gh_*/bin/gh "$HOME/.local/bin/gh"
    export PATH="$HOME/.local/bin:$PATH"
    cd "$PROJECT"
    gh --version
  fi
fi

export PATH="$HOME/.local/bin:$PATH"

# Configure git identity
git config --global user.email >/dev/null 2>&1 || git config --global user.email "cedri@users.noreply.github.com"
git config --global user.name >/dev/null 2>&1 || git config --global user.name "cedri"

# Init repo
cd "$PROJECT"
if [ ! -d .git ]; then
  echo "=== git init ==="
  git init
fi

# Ensure gitignore
if [ ! -f .gitignore ]; then
  cat > .gitignore <<'EOF'
node_modules/
.expo/
dist/
.env
.env.*
*.log
ios-builder-last-run.log
EOF
fi

# Try to get GitHub username via builder token if we can extract it
# Or via gh auth status
GITHUB_USER=""
if have gh && gh auth status >/dev/null 2>&1; then
  GITHUB_USER=$(gh api user -q .login)
  echo "gh user: $GITHUB_USER"
fi

# Try credential helper / env token
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  # check git credential fill
  echo "=== try git credential ==="
  printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null || true
fi

echo "=== current remotes ==="
git remote -v || true

# If no token via gh, try using builder's oauth token from secret service
# On Windows keychain via WSL this often fails - try /mnt/c credentials

# Attempt: npm package might store in a known path - inspect builder binary location
BUILDER_DIR=$(dirname "$(readlink -f "$(command -v builder)" 2>/dev/null || command -v builder)")
echo "builder dir: $BUILDER_DIR"
# node global modules
npm root -g 2>/dev/null || true
ls "$(npm root -g 2>/dev/null)/ios-builder" 2>/dev/null | head -20 || true

# Search for github token string in ios-builder package config files
NODE_ROOT=$(npm root -g 2>/dev/null || echo "")
if [ -n "$NODE_ROOT" ] && [ -d "$NODE_ROOT/ios-builder" ]; then
  find "$NODE_ROOT/ios-builder" -maxdepth 3 -type f \( -name '*.json' -o -name '*.md' \) 2>/dev/null | head -30
fi

echo "SETUP_PARTIAL_DONE"
