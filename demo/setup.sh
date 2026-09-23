# Sourced (hidden) by demo.tape. Builds a throwaway world that can show nothing
# real: its own empty global git config, no system config, its own account
# registry, no gh on PATH, and a "GitHub" origin that is really a local bare repo.
# Placeholder identities only (octocat, *.example.invalid).

REPO_ROOT=$(pwd)
case "$OSTYPE" in
  msys*|cygwin*) DEMO_ROOT=/c/repown-demo ;;   # not under the user profile, whose path names the user
  *)             DEMO_ROOT=/tmp/repown-demo ;;
esac
rm -rf "$DEMO_ROOT" && mkdir -p "$DEMO_ROOT"

export GIT_CONFIG_GLOBAL="$DEMO_ROOT/gitconfig" GIT_CONFIG_NOSYSTEM=1
export REPOWN_CONFIG_DIR="$DEMO_ROOT/registry"
: > "$GIT_CONFIG_GLOBAL"
export PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v git)"):/usr/bin:/bin"

git init -q --bare "$DEMO_ROOT/remote.git"
git config --global url."$DEMO_ROOT/remote.git".insteadOf https://github.com/octocat/demo.git
git init -q -b main "$DEMO_ROOT/demo"

repown() { node "$REPO_ROOT/src/cli.ts" "$@"; }
repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com >/dev/null

cd "$DEMO_ROOT/demo"
git remote add origin https://github.com/octocat/demo.git
PS1='$ '
clear
