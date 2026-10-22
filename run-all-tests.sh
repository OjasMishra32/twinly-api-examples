#!/usr/bin/env bash
# Runs every example's test against the local mock API (no account, no key,
# no network). Exits non-zero if anything fails.
#
#   ./run-all-tests.sh            all of them
#   ./run-all-tests.sh call-agent just one (any folder name below)

set -uo pipefail
cd "$(dirname "$0")" || exit 2

SUITES=(
  "mock-api|node --test test/mock-api.test.js"
  "imessage-bot|node --test test/bot.test.js"
  "call-agent|python3 -m unittest discover -s test -v"
  "voice-postcard|python3 -m unittest discover -s test -v"
  "web-task-cli|node --test test/task.test.js"
  "meme-texter|python3 -m unittest discover -s test -v"
  "group-digest|node --test test/digest.test.js"
)

if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  echo "Needs Node 20 or newer (https://nodejs.org)." >&2
  exit 2
fi
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "Needs Python 3.9 or newer." >&2
  exit 2
fi

# A stuck suite shouldn't hang CI forever (timeout ships with coreutils; stock macOS lacks it).
limit=()
if command -v timeout >/dev/null; then limit=(timeout 300); fi

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT
failed=0
ran=0
summary=()

for suite in "${SUITES[@]}"; do
  name=${suite%%|*}
  cmd=${suite#*|}
  if [[ $# -gt 0 && " $* " != *" $name "* ]]; then continue; fi
  ran=$((ran + 1))
  log="$logs/$name.log"
  start=$(date +%s)
  # shellcheck disable=SC2086 # cmd is a fixed command line from SUITES
  # The tests pass the mock's base URL and fake key to everything they run; a
  # real key in your shell is blanked here so it can never reach a test.
  (cd "$name" && TWINLY_API_KEY="" TWINLY_API_BASE="" ${limit[@]+"${limit[@]}"} $cmd) >"$log" 2>&1
  status=$?
  secs=$(($(date +%s) - start))
  # How many tests ran: node prints "ℹ pass N" / "ℹ fail N", unittest prints "Ran N tests".
  pass=$(sed -n 's/^ℹ pass \([0-9]*\)$/\1/p' "$log")
  fail=$(sed -n 's/^ℹ fail \([0-9]*\)$/\1/p' "$log")
  if [[ -z $pass ]]; then
    total=$(sed -n 's/^Ran \([0-9]*\) tests\{0,1\} in.*/\1/p' "$log")
    total=${total:-0}
    # "FAILED (failures=1, errors=2)": add both up.
    fail=$(grep '^FAILED (' "$log" | grep -oE '(failures|errors)=[0-9]+' | cut -d= -f2 | awk '{ s += $1 } END { print s + 0 }')
    pass=$((total - fail))
  fi
  if [[ $status -eq 0 ]]; then
    summary+=("$(printf '  PASS  %-15s %3s tests  %3ss' "$name" "$pass" "$secs")")
  else
    failed=$((failed + 1))
    summary+=("$(printf '  FAIL  %-15s %3s passed, %s failed  %3ss' "$name" "$pass" "$fail" "$secs")")
    echo "---- $name failed (exit $status), last 40 lines ----"
    tail -n 40 "$log"
    echo
  fi
done

if [[ $ran -eq 0 ]]; then
  echo "No suite called: $*" >&2
  exit 2
fi

echo "Twinly examples against the mock API:"
printf '%s\n' "${summary[@]}"
if [[ $failed -gt 0 ]]; then
  echo "$failed of $ran suites failed."
  exit 1
fi
echo "All $ran suites passed."
