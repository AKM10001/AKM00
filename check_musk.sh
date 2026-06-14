#!/bin/bash
# check_musk.sh - Check for new Elon Musk tweets and notify via WeChat
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${HOME}/.musk_monitor/log.txt"
mkdir -p "$(dirname "$LOG_FILE")"

PROXY="${HTTP_PROXY:-http://127.0.0.1:7890}"
BEARER="Authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
UA="User-Agent: Mozilla/5.0"
QUERY_ID="RyDU3I9VJtPF-Pnl6vrRlw"

# 1. Get guest token
GT=$(curl -sL --max-time 15 -x "$PROXY" "https://api.x.com/1.1/guest/activate.json" -X POST -H "$BEARER" -H "$UA" | python3 -c 'import json,sys; print(json.load(sys.stdin)["guest_token"])')

if [ -z "$GT" ]; then
  echo "[$(date "+%H:%M:%S")] Failed to get guest token" >> "$LOG_FILE"
  exit 0
fi

# 2. Fetch tweets - use simple hardcoded encoded strings for reliability
VARS='%7B%22userId%22%3A%2244196397%22%2C%22count%22%3A10%2C%22includePromotedContent%22%3Afalse%2C%22withQuickPromoteEligibilityTweetFields%22%3Afalse%2C%22withVoice%22%3Afalse%2C%22withV2Timeline%22%3Atrue%7D'
FEATS='%7B%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%7D'

RESP=$(curl -sL --max-time 20 -x "$PROXY" -H "$BEARER" -H "$UA" -H "X-Guest-Token: $GT" \
  "https://api.x.com/graphql/$QUERY_ID/UserTweets?variables=$VARS&features=$FEATS")

if [ -z "$RESP" ]; then
  echo "[$(date "+%H:%M:%S")] Empty API response" >> "$LOG_FILE"
  exit 0
fi

# 3. Parse and detect new tweets
PARSED=$(echo "$RESP" | node "$SCRIPT_DIR/musk_monitor.mjs" 2>/dev/null)
NEW_COUNT=$(echo "$PARSED" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("newTweets",[])))' 2>/dev/null || echo "0")

if [ "$NEW_COUNT" = "0" ] || [ -z "$NEW_COUNT" ]; then
  # echo "[$(date "+%H:%M:%S")] No new tweets" >> "$LOG_FILE"
  exit 0
fi

# 4. Build and send notification
NOTIFY_MSG=$(echo "$PARSED" | python3 -c '
import json,sys
d=json.load(sys.stdin)
tweets=d.get("newTweets",[])
lines=["🚀 马斯克发新推了！"]
for t in tweets[:3]:
    text=t.get("text","")[:200]
    lines.append("")
    lines.append("📝 "+text+("..." if len(t.get("text",""))>200 else ""))
    lines.append("🔗 "+t.get("url",""))
    if t.get("createdAt"):
        lines.append("🕐 "+t["createdAt"])
print("\n".join(lines))
' 2>/dev/null)

if [ -n "$NOTIFY_MSG" ]; then
  echo "$NOTIFY_MSG" | node "$SCRIPT_DIR/wechat_notify.mjs" 2>> "$LOG_FILE" || true
  echo "[$(date "+%H:%M:%S")] Notified: $NEW_COUNT new tweets" >> "$LOG_FILE"
fi
