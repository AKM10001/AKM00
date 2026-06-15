#!/bin/bash
# check_tweets.sh - Monitor multiple X accounts for new tweets, notify via WeChat
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${HOME}/.musk_monitor/log.txt"
mkdir -p "$(dirname "$LOG_FILE")"

PROXY="${HTTP_PROXY:-http://127.0.0.1:7890}"
BEARER="Authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
UA="User-Agent: Mozilla/5.0"
TWEET_QUERY="RyDU3I9VJtPF-Pnl6vrRlw"

# Config: "USER_ID|DISPLAY_NAME"
ACCOUNTS=(
  "44196397|elonmusk"
  "1940360837547565056|aleabitoreddit"
)

log() { echo "[$(date "+%H:%M:%S")] $*" >> "$LOG_FILE"; }

# Get guest token
GT=$(curl -sL --max-time 15 -x "$PROXY" "https://api.x.com/1.1/guest/activate.json" -X POST -H "$BEARER" -H "$UA" | python3 -c 'import json,sys; print(json.load(sys.stdin)["guest_token"])' 2>/dev/null)
if [ -z "$GT" ]; then
  log "Failed to get guest token"
  exit 0
fi

for ACCT in "${ACCOUNTS[@]}"; do
  USER_ID="${ACCT%%|*}"
  NAME="${ACCT##*|}"

  log "Checking $NAME ($USER_ID)..."

  # Build encoded URL - use python for proper encoding
  URL=$(python3 -c "
import urllib.parse, json
vars = json.dumps({'userId': '$USER_ID', 'count': 3, 'includePromotedContent': False, 'withQuickPromoteEligibilityTweetFields': False, 'withVoice': False, 'withV2Timeline': True})
feats = json.dumps({'responsive_web_graphql_exclude_directive_enabled': True})
print('https://api.x.com/graphql/$TWEET_QUERY/UserTweets?variables=' + urllib.parse.quote(vars) + '&features=' + urllib.parse.quote(feats))
")

  RESP=$(curl -sL --max-time 45 -x "$PROXY" -H "$BEARER" -H "$UA" -H "X-Guest-Token: $GT" "$URL" 2>/dev/null)

  if [ -z "$RESP" ]; then
    log "$NAME: Empty API response"
    continue
  fi

  # Parse tweets with standalone parser
  PARSED=$(echo "$RESP" | node "$SCRIPT_DIR/parse_tweets.mjs" "$USER_ID" "$NAME" 2>/dev/null || true)
  if [ -z "$PARSED" ]; then
    log "$NAME: Parse failed"
    continue
  fi

  NEW_COUNT=$(echo "$PARSED" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("newTweets",[])))' 2>/dev/null || echo "0")

  if [ "$NEW_COUNT" = "0" ]; then
    continue
  fi

  # Build notification
  NOTIFY_MSG=$(echo "$PARSED" | python3 -c "
import json,sys
d=json.load(sys.stdin)
tweets=d.get('newTweets',[])
name=d.get('displayName','Unknown')
lines=[f'🚀 {name} 发新推了！']
for t in tweets[:3]:
    text=t.get('text','')[:200]
    lines.append('')
    lines.append('📝 '+text+('...' if len(t.get('text',''))>200 else ''))
    lines.append('🔗 '+t.get('url',''))
    if t.get('createdAt'):
        lines.append('🕐 '+t['createdAt'])
print('\n'.join(lines))
" 2>/dev/null || true)

  if [ -n "$NOTIFY_MSG" ]; then
    echo "$NOTIFY_MSG" | node "$SCRIPT_DIR/wechat_notify.mjs" 2>> "$LOG_FILE" || true
    log "$NAME: Notified $NEW_COUNT new tweets"
  fi
done
