#!/usr/bin/env bash
# Deletes remote branches that have been merged into main.
# Usage: ./scripts/delete-merged-branches.sh
#
# Requires write access to the repository.

set -euo pipefail

MAIN_BRANCH="${1:-main}"
REMOTE="${2:-origin}"

echo "Fetching latest remote state..."
git fetch --prune "$REMOTE"

echo "Branches already merged into $REMOTE/$MAIN_BRANCH:"
MERGED=$(git branch -r --merged "$REMOTE/$MAIN_BRANCH" \
  | grep -v "HEAD\|$REMOTE/$MAIN_BRANCH\|$REMOTE/master" \
  | sed "s|$REMOTE/||")

if [ -z "$MERGED" ]; then
  echo "No merged branches found."
  exit 0
fi

echo "$MERGED"
echo ""
read -r -p "Delete all of the above from remote '$REMOTE'? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  echo "$MERGED" | xargs -r git push "$REMOTE" --delete
  echo "Done."
else
  echo "Aborted."
fi
