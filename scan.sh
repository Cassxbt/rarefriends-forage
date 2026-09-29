#!/bin/sh
# Pre-commit guard: gitleaks plus generic leak checks on everything git would track.
# Personal patterns (names, handles, private file names) live in the untracked .scan-private file,
# one "label|regex" per line, so the guard never has to contain what it protects.
cd "$(dirname "$0")"
fail=0
if ! gitleaks dir . --no-banner --redact --exit-code 1 -l warn --max-target-megabytes 5; then echo "BLOCK [gitleaks]"; fail=1; fi
files=$(git ls-files --cached --others --exclude-standard | grep -vE '^vendor/.*\.tgz$')
check() { hits=$(echo "$files" | xargs grep -nIiE "$2" 2>/dev/null | grep -vE '^(scan.sh|.gitignore):' || true); if [ -n "$hits" ]; then echo "BLOCK [$1]"; echo "$hits" | cut -d: -f1,2 | head -5; fail=1; fi; }
check "rpc api key"      '(alchemy\.com|infura\.io|quiknode\.pro)/v[0-9]/[A-Za-z0-9_-]{8,}'
check "private key"      'BEGIN [A-Z ]*PRIVATE KEY|mnemonic|seed phrase'
check "local paths"      '/Users/[a-z]+/|/private/tmp/|/home/[a-z]+/'
if [ -f .scan-private ]; then
  while IFS='|' read -r label pattern; do [ -n "$pattern" ] && check "$label" "$pattern"; done < .scan-private
else
  echo "note: no .scan-private file; personal checks skipped"
fi
bad=$(echo "$files" | grep -iE '(^|/)\.env|\.pem$|\.key$|^research/|^artifacts/|\.DS_Store|\.scan-private' || true)
[ -n "$bad" ] && { echo "BLOCK [forbidden files]"; echo "$bad"; fail=1; }
[ $fail -eq 0 ] && echo "scan: clean ($(echo "$files" | wc -l | tr -d ' ') files)"
exit $fail
