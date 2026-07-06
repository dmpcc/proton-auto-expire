#!/usr/bin/env bash
# Check whether Proton changed the filters API client code we based this
# extension on. A diff here is the first thing to inspect when API calls fail.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT="$REPO_ROOT/upstream/filters.ts"
URL="https://raw.githubusercontent.com/ProtonMail/WebClients/main/packages/shared/lib/api/filters.ts"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo "Fetching current upstream: $URL"
curl -sSf "$URL" -o "$TMP"

if diff -u "$SNAPSHOT" "$TMP"; then
    echo "OK: upstream filters API unchanged since our snapshot."
else
    echo
    echo "DRIFT DETECTED: Proton changed their filters API client code."
    echo "Review the diff above, update extension/content.js if needed,"
    echo "then refresh the snapshot with:"
    echo "  cp \"$TMP\" \"$SNAPSHOT\"   # (or re-run curl to $SNAPSHOT)"
    exit 1
fi
