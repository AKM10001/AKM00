#!/bin/bash
# check_musk.sh - Check for new Elon Musk tweets and notify via WeChat
#
# Data source: GitHub-hosted elon_tweets.json (updated by GitHub Action every 5min)
# Set GITHUB_RAW_URL to your repo's raw URL, e.g.:
#   GITHUB_RAW_URL="https://raw.githubusercontent.com/YOU/musk-monitor/main/elon_tweets.json"
#
# Or set ELON_FEED_URL to any other JSON endpoint.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NOTIFY_SCRIPT="$SCRIPT_DIR/wechat_notify.mjs"
STATE_FILE="${HOME}/.musk_monitor_state.json"
LOG_FILE="${HOME}/.musk_monitor/log.txt"
FEED_URL="${GITHUB_RAW_URL:-${ELON_FEED_URL:-}}"

mkdir -p "$(dirname "$LOG_FILE")"

# --- Fetch tweets JSON ---
TWEETS_JSON=""

if [ -n "$FEED_URL" ]; then
    # Fetch from remote (GitHub raw or other endpoint)
    TWEETS_JSON=$(curl -sL --max-time 15 "$FEED_URL" 2>/dev/null) || {
        echo "[$(date '+%H:%M:%S')] Remote fetch failed" >> "$LOG_FILE"
        exit 0
    }
else
    # No remote URL configured, try local X.com API (needs proxy/VPN)
    echo "[$(date '+%H:%M:%S')] No FEED_URL set, trying local X.com API" >> "$LOG_FILE"
    TWEETS_JSON=$(node "$SCRIPT_DIR/musk_monitor.mjs" 2>/dev/null) || {
        echo "[$(date '+%H:%M:%S')] Local monitor failed" >> "$LOG_FILE"
        exit 0
    }
fi

# --- Parse and compare ---
RESULT=$(echo "$TWEETS_JSON" | node -e "
    const { readFileSync, writeFileSync, existsSync } = require('node:fs');
    const STATE_FILE = '$STATE_FILE';

    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => {
        try {
            const tweets = JSON.parse(data);
            if (!tweets.status || tweets.status !== 'ok') {
                console.log('SKIP');
                process.exit(0);
            }

            // Load local state
            let state = { lastTweetId: null, lastTweetTime: 0, seenIds: [] };
            if (existsSync(STATE_FILE)) {
                try { state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch {}
            }
            const seenIds = new Set(state.seenIds || []);

            // Find new tweets
            const allTweets = tweets.newTweets || [];
            const fresh = [];
            for (const t of allTweets) {
                if (!seenIds.has(t.id) && !t.isReply) {
                    fresh.push(t);
                    seenIds.add(t.id);
                }
            }

            // Update state
            if (allTweets.length > 0) {
                state.lastTweetId = allTweets[0].id;
                state.lastTweetTime = Date.now();
            }
            state.seenIds = [...seenIds].slice(-500);
            writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

            if (fresh.length === 0) {
                console.log('NO_NEW');
                process.exit(0);
            }

            // Build notification
            const lines = ['🚀 马斯克发新推了！'];
            for (const t of fresh.slice(-3)) {
                const text = (t.text || t.title || '').slice(0, 200);
                lines.push('');
                lines.push('📝 ' + text + (t.text && t.text.length > 200 ? '...' : ''));
                lines.push('🔗 ' + (t.url || t.link || ''));
                if (t.createdAt) lines.push('🕐 ' + t.createdAt);
            }
            console.log(lines.join('\n'));
        } catch(e) {
            console.log('ERROR:' + e.message);
        }
    });
")

# --- Notify ---
case "$RESULT" in
    SKIP|NO_NEW|"")
        exit 0
        ;;
    ERROR:*)
        echo "[$(date '+%H:%M:%S')] Parse error: $RESULT" >> "$LOG_FILE"
        exit 0
        ;;
    *)
        echo "$RESULT" | node "$NOTIFY_SCRIPT" 2>> "$LOG_FILE" && \
        echo "[$(date '+%H:%M:%S')] Notified ${NEW_COUNT:-?} new tweets" >> "$LOG_FILE"
        ;;
esac
