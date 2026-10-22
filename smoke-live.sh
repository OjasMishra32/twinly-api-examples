#!/usr/bin/env bash
# Live smoke test: runs the six examples against the REAL Twinly API with a
# real key. It costs real usage, and it really texts and (optionally) calls.
#
# EVERYTHING IT SENDS GOES TO YOU, the key's owner: OWN_NUMBER is your own
# phone number (or iMessage email). It never texts, calls or posts to anyone
# else, and it reads only your chat with yourself (or OWN_CHAT, if you name
# one). Calls are skipped unless ALLOW_CALL=1, and then it calls OWN_NUMBER.
#
#   OWN_NUMBER="+13525550100" ./smoke-live.sh
#   OWN_NUMBER=... TWINLY_WEBHOOK_SECRET=... ./smoke-live.sh
#         also runs the bot (webhook URL http://127.0.0.1:$BOT_PORT/twinly/webhook + "weather" command set in the app,
#         and Settings > Messages > "@twinly in Messages" on, with Full Disk Access);
#         you text the command yourself, since texts the API sends never trigger @twinly
#   OWN_NUMBER=... ALLOW_CALL=1 ./smoke-live.sh
#         also places one short call to your own phone
#
# The key comes from TWINLY_API_KEY, or you're asked for it (typing is hidden).
# Your Twinly must be running on your Mac, signed in, with the Terms accepted and
# Settings > Developer API > "Let keys text, call and run tasks as you" on.
#
# Rough cost: a task (2 + model), a chat read (0.2) and a summary, a voice
# note (1), a picture (0.5), 2 texts (0.5 each), and 3 per call minute.

set -uo pipefail
cd "$(dirname "$0")" || exit 2

BASE=${TWINLY_API_BASE:-https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1}
BOT_PORT=${BOT_PORT:-8787}
TAG="Twinly API smoke test $(date +%H:%M)"

die() { echo "smoke-live: $*" >&2; exit 2; }

[[ -n ${OWN_NUMBER:-} ]] || die "set OWN_NUMBER to YOUR OWN phone number or iMessage email (everything is sent there)."
phone_re='^[+(]?[0-9][0-9 ().-]{6,}$'
email_re='^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
[[ $OWN_NUMBER =~ $phone_re || $OWN_NUMBER =~ $email_re ]] ||
  die "OWN_NUMBER should be a phone number like +13525550100 or an email, not a name."
command -v node >/dev/null || die "needs Node 20+."
command -v python3 >/dev/null || die "needs Python 3.9+."
command -v curl >/dev/null || die "needs curl."

if [[ -z ${TWINLY_API_KEY:-} ]]; then
  read -rsp "Twinly API key (twk_live_..., hidden): " TWINLY_API_KEY
  echo
fi
[[ $TWINLY_API_KEY =~ ^twk_live_[0-9A-Za-z]{43}$ ]] || die "that doesn't look like a twk_live_ key."
export TWINLY_API_KEY TWINLY_API_BASE="$BASE"

# The key goes to curl through a config on a pipe, never on the command line (where `ps` shows it).
api() {
  curl -sS --max-time 30 --config <(printf 'header = "Authorization: Bearer %s"\n' "$TWINLY_API_KEY") "$BASE$1"
}
balance() {
  api /usage | python3 -c 'import json,sys
try:
    u = json.load(sys.stdin)
    print("$%.2f extra usage, this key used $%.2f this month" % (u["plan"].get("extra_usage_usd", 0), u["key"]["usage_usd"]))
except Exception:
    print("unknown")'
}

echo "Live API: $BASE"
echo "Everything goes to: $OWN_NUMBER (yourself)"
usage_json=$(api /usage) || die "couldn't reach the API."
if ! python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("object") == "usage" else 1)' "$usage_json" 2>/dev/null; then
  echo "$usage_json" >&2
  die "the key was refused (see the error above)."
fi
echo "Before: $(balance)"
echo
echo "This will, on your own Mac and to your own number:"
echo "  - run a tiny task (web-task-cli)"
echo "  - read your last 10 messages ${OWN_CHAT:+in \"$OWN_CHAT\" }and summarize them (group-digest)"
echo "  - text you a voice note and a picture (voice-postcard, meme-texter)"
[[ -n ${TWINLY_WEBHOOK_SECRET:-} ]] && echo "  - run the bot and wait for YOU to text \"@twinly weather Gainesville\" (imessage-bot)"
[[ ${ALLOW_CALL:-0} == 1 ]] && echo "  - CALL $OWN_NUMBER once, for about a minute (call-agent)"
if [[ ${SMOKE_YES:-0} != 1 ]]; then
  read -rp "Type yes to go: " answer
  [[ $answer == yes ]] || die "stopped, nothing was run."
fi

work=$(mktemp -d)
bot_pid=""
cleanup() {
  [[ -n $bot_pid ]] && kill "$bot_pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

limit=()
command -v timeout >/dev/null && limit=(timeout)
results=()
failed=0

# step <name> <seconds> <folder> <command...>
step() {
  local name=$1 secs=$2 dir=$3
  shift 3
  echo
  echo "== $name"
  local t=()
  [[ ${#limit[@]} -gt 0 ]] && t=("${limit[@]}" "$secs")
  if (cd "$dir" && ${t[@]+"${t[@]}"} "$@") 2>&1 | tee "$work/$name.log"; then
    results+=("  PASS  $name")
  else
    results+=("  FAIL  $name")
    failed=$((failed + 1))
  fi
}
skip() {
  echo
  echo "== $1: skipped ($2)"
  results+=("  SKIP  $1 ($2)")
}

step web-task-cli 900 web-task-cli \
  node task.js "Reply with just the word ready. Don't open any apps, don't change anything and don't send anything." --out "$work/task"

if [[ -n ${OWN_CHAT:-} ]]; then
  step group-digest 120 group-digest node digest.js --chat "$OWN_CHAT" --limit 10
else
  step group-digest 120 group-digest node digest.js --with "$OWN_NUMBER" --limit 10
fi

step voice-postcard 120 voice-postcard \
  python3 postcard.py --to "$OWN_NUMBER" --say "This is a Twinly API smoke test. If you can hear me, the voice works." \
  --caption "$TAG (voice)" --out "$work"
step meme-texter 120 meme-texter \
  python3 meme.py --to "$OWN_NUMBER" "a friendly robot giving a thumbs up, flat illustration" \
  --caption "$TAG (picture)" --out "$work"

if [[ -n ${TWINLY_WEBHOOK_SECRET:-} ]]; then
  echo
  echo "== imessage-bot"
  (cd imessage-bot && PORT=$BOT_PORT WEATHER_SOURCE=sample node bot.js) >"$work/bot.log" 2>&1 &
  bot_pid=$!
  sleep 1
  # Texts the API sends never trigger @twinly, so this one has to come from you.
  echo "The bot is up on port $BOT_PORT. From your phone, text \"@twinly weather Gainesville\" to yourself now."
  echo "(Waiting up to 2 minutes for it to arrive.)"
  got=""
  for _ in $(seq 1 120); do
    grep -q "@twinly weather" "$work/bot.log" && { got=1; break; }
    sleep 1
  done
  cat "$work/bot.log"
  if [[ -n $got ]]; then
    results+=("  PASS  imessage-bot (check your phone for the reply)")
  else
    results+=("  FAIL  imessage-bot (no bot.command arrived: is the webhook URL http://127.0.0.1:$BOT_PORT/twinly/webhook, and \"weather\" a bot command?)")
    failed=$((failed + 1))
  fi
else
  skip imessage-bot "set TWINLY_WEBHOOK_SECRET to run it"
fi

if [[ ${ALLOW_CALL:-0} == 1 ]]; then
  step call-agent 2100 call-agent \
    python3 call_agent.py --to "$OWN_NUMBER" --say "Hi, this is a quick Twinly API test call." \
    --goal "Tell me this is a Twinly API smoke test, ask me to say anything, then say goodbye and hang up."
else
  skip call-agent "set ALLOW_CALL=1 to place one call to $OWN_NUMBER"
fi

echo
echo "After: $(balance)"
echo "Live smoke results:"
printf '%s\n' "${results[@]}"
if [[ $failed -gt 0 ]]; then
  echo "$failed failed."
  exit 1
fi
echo "No failures."
