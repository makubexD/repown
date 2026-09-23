# Sourced (hidden) by demo.tape. Builds a throwaway world that can show nothing
# real: its own empty global git config, no system config, its own account
# registry, its own HOME (so no gh login or other dotfile is reachable), no gh on
# PATH, and a "GitHub" origin that is really a local bare repo. Placeholder
# identities only (octocat, *.example.invalid).
#
# The insteadOf rewrite hands the hook a local path rather than the GitHub URL, so
# the destination-owner check has nothing to compare; the demo's refusal comes
# from the commit-author check, which is the point being shown.

REPO_ROOT=$(pwd)
ORIGINAL_PATH=$PATH
case "$OSTYPE" in
  msys*|cygwin*) DEMO_ROOT=/c/repown-demo ;;   # not under the user profile, whose path names the user
  *)             DEMO_ROOT=/tmp/repown-demo ;;
esac
rm -rf "$DEMO_ROOT" && mkdir -p "$DEMO_ROOT/home" "$DEMO_ROOT/bin"

# PATH gets node and git and nothing that could be gh. On Linux gh lives in
# /usr/bin next to git, so the two are linked into a directory of their own. Git
# for Windows needs its own /usr/bin (the msys runtime; without it `git push`
# segfaults), and gh is never installed there.
case "$OSTYPE" in
  msys*|cygwin*) DEMO_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v git)"):/usr/bin:/bin" ;;
  *)             ln -s "$(command -v node)" "$DEMO_ROOT/bin/node"
                 ln -s "$(command -v git)" "$DEMO_ROOT/bin/git"
                 DEMO_PATH="$DEMO_ROOT/bin" ;;
esac

unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GH_HOST GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL
export HOME="$DEMO_ROOT/home" XDG_CONFIG_HOME="$DEMO_ROOT/home/.config" GH_CONFIG_DIR="$DEMO_ROOT/gh"
export GIT_CONFIG_GLOBAL="$DEMO_ROOT/gitconfig" GIT_CONFIG_NOSYSTEM=1
export REPOWN_CONFIG_DIR="$DEMO_ROOT/registry"
: > "$GIT_CONFIG_GLOBAL"

git init -q --bare "$DEMO_ROOT/remote.git"
git config --global url."$DEMO_ROOT/remote.git".insteadOf https://github.com/octocat/demo.git
git init -q -b main "$DEMO_ROOT/demo"

repown() { node "$REPO_ROOT/src/cli.ts" "$@"; }
repown accounts add octocat --name "Octo Cat" --email octocat@users.noreply.github.com >/dev/null

cd "$DEMO_ROOT/demo"
git remote add origin https://github.com/octocat/demo.git
PS1='$ '
clear
export PATH="$DEMO_PATH"
