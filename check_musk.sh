#!/bin/bash
# check_tweets.sh - Monitor multiple X accounts for new tweets, notify via WeChat
# Filters: Beijing time 9:00-15:00, A-stock codes in tweet content
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

# ---- Time window check: BJT 9:00-11:00, 13:00-15:00 ----
BJ_HOUR=$(TZ='Asia/Shanghai' date '+%k' | tr -d ' ')
if [ "$BJ_HOUR" -ge 11 ] && [ "$BJ_HOUR" -lt 13 ]; then
  exit 0
fi
if [ "$BJ_HOUR" -lt 9 ] || [ "$BJ_HOUR" -ge 15 ]; then
  exit 0
fi

# ---- Get guest token ----
GT=$(curl -sL --max-time 15 -x "$PROXY" "https://api.x.com/1.1/guest/activate.json" -X POST -H "$BEARER" -H "$UA" | python3 -c 'import json,sys; print(json.load(sys.stdin)["guest_token"])' 2>/dev/null)
if [ -z "$GT" ]; then
  log "Failed to get guest token"
  exit 0
fi

for ACCT in "${ACCOUNTS[@]}"; do
  USER_ID="${ACCT%%|*}"
  NAME="${ACCT##*|}"

  # Build encoded URL
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

  # Parse tweets
  PARSED=$(echo "$RESP" | node "$SCRIPT_DIR/parse_tweets.mjs" "$USER_ID" "$NAME" 2>/dev/null || true)
  if [ -z "$PARSED" ]; then
    log "$NAME: Parse failed"
    continue
  fi

  # Filter: A-stock 6-digit codes only, within trading hours (already checked above)
  NOTIFY_MSG=$(echo "$PARSED" | python3 -c "
import json, sys, re
d = json.load(sys.stdin)
tweets = d.get('newTweets', [])
name = d.get('displayName', 'Unknown')

# A-stock 6-digit code pattern:
# 600xxx-605xxx (Shanghai), 000xxx-003xxx (Shenzhen),
# 300xxx-301xxx (ChiNext), 688xxx-689xxx (STAR)
stock_re = re.compile(r'(?<!\d)((?:60[0-5]|00[0-3]|30[0-1]|688|689)\d{3})(?!\d)')

filtered = []
for t in tweets:
    text = t.get('text', '')
    codes = list(set(stock_re.findall(text)))
    if codes:
        t['stock_codes'] = codes
        filtered.append(t)

if not filtered:
    sys.exit(0)

lines = [f'🚀 {name} 发新推了！']
for t in filtered[:3]:
    text = t.get('text', '')[:200]
    codes = ', '.join(t.get('stock_codes', []))
    lines.append('')
    lines.append('📝 ' + text + ('...' if len(t.get('text', '')) > 200 else ''))
    lines.append('📈 A股代码: ' + codes)
    lines.append('🔗 ' + t.get('url', ''))
    if t.get('createdAt'):
        lines.append('🕐 ' + t['createdAt'])
print('\n'.join(lines))
" 2>/dev/null || true)

  if [ -n "$NOTIFY_MSG" ]; then
    echo "$NOTIFY_MSG" | node "$SCRIPT_DIR/wechat_notify.mjs" 2>> "$LOG_FILE" || true
    log "$NAME: Notified (stock codes found)"
  fi
done
