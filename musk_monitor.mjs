#!/usr/bin/env node
/**
 * Monitor Elon Musk's X/Twitter account for new tweets.
 * Uses X.com GraphQL API with guest token (no API key needed).
 *
 * Proxy support via env vars:
 *   HTTP_PROXY / http_proxy  or  ALL_PROXY / all_proxy
 *   e.g. HTTP_PROXY=http://127.0.0.1:7890 node musk_monitor.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = join(homedir(), ".musk_monitor_state.json");
const ELON_USER_ID = "44196397"; // Elon Musk's Twitter user ID

const BASE = "https://api.x.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// GraphQL query ID for UserTweets
const USER_TWEETS_QUERY_ID = "VVvlKpKYipNqHQBK4co5qg";

const REQUEST_TIMEOUT = 15000;

let guestToken = null;

// Resolve proxy from env
function getProxy() {
  return (
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    null
  );
}

// Fetch with timeout and optional proxy support
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const proxy = getProxy();
  // Node 18+ native fetch doesn't support proxy directly.
  // When proxy is set, use undici dispatcher if available, or warn.
  const fetchOpts = { ...options, signal: controller.signal };

  if (proxy) {
    try {
      const { ProxyAgent } = await import("undici");
      fetchOpts.dispatcher = new ProxyAgent(proxy);
    } catch {
      // undici not available, proxy won't work — proceed without
    }
  }

  try {
    const resp = await fetch(url, fetchOpts);
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function activateGuestToken() {
  const resp = await fetchWithTimeout(`${BASE}/1.1/guest/activate.json`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Authorization:
        "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
    },
  });
  if (!resp.ok) throw new Error(`Guest activate failed: ${resp.status}`);
  const data = await resp.json();
  guestToken = data.guest_token;
  return guestToken;
}

async function apiRequest(path, params = {}) {
  if (!guestToken) await activateGuestToken();

  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const resp = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Authorization:
        "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
      "X-Guest-Token": guestToken,
    },
  });

  if (resp.status === 403 || resp.status === 429) {
    guestToken = null;
    await activateGuestToken();
    return apiRequest(path, params);
  }

  if (!resp.ok) {
    throw new Error(`API ${path} returned ${resp.status}`);
  }

  return resp.json();
}

async function getUserTweets(userId, count = 10) {
  const variables = {
    userId,
    count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: false,
    withV2Timeline: true,
  };
  const features = {
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_media_download_video_enabled: false,
    responsive_web_enhance_cards_enabled: false,
  };

  return apiRequest(`/graphql/${USER_TWEETS_QUERY_ID}/UserTweets`, {
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
    fieldToggles: JSON.stringify({ withArticlePlainText: false }),
  });
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      // fall through
    }
  }
  return { lastTweetId: null, lastTweetTime: 0, seenIds: [] };
}

function saveState(state) {
  state.seenIds = state.seenIds.slice(-500);
  const dir = join(homedir(), ".musk_monitor");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isReplyOrRetweet(text) {
  return /^@\w+/.test(text) || /^RT @/.test(text);
}

async function main() {
  const state = loadState();
  const seenIds = new Set(state.seenIds || []);

  let data;
  try {
    data = await getUserTweets(ELON_USER_ID, 10);
  } catch (err) {
    console.error(JSON.stringify({ status: "error", message: err.message }));
    process.exit(1);
  }

  // Parse timeline entries
  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];
  const entries = [];

  for (const instr of instructions) {
    if (instr.type === "TimelineAddEntries") {
      for (const entry of instr.entries || []) {
        if (entry.content?.itemContent?.tweet_results?.result) {
          entries.push(entry.content.itemContent.tweet_results.result);
        }
      }
    }
  }

  // Build tweet list
  const allTweets = [];
  for (const result of entries) {
    const legacy = result.legacy || {};
    const restId = result.rest_id || legacy.id_str;
    if (!restId) continue;

    const text = legacy.full_text || "";
    allTweets.push({
      id: restId,
      text,
      createdAt: legacy.created_at || "",
      retweetCount: legacy.retweet_count || 0,
      likeCount: legacy.favorite_count || 0,
      replyCount: legacy.reply_count || 0,
      isRetweet: text.startsWith("RT @"),
      isReply: /^@\w+/.test(text) && !text.startsWith("RT @"),
      url: `https://x.com/elonmusk/status/${restId}`,
    });
  }

  // Find new tweets
  const newTweets = [];
  for (const t of allTweets) {
    if (!seenIds.has(t.id) && !t.isReply) {
      const tweetTime = new Date(t.createdAt).getTime();
      if (state.lastTweetTime && tweetTime <= state.lastTweetTime) continue;
      newTweets.push(t);
      seenIds.add(t.id);
    }
  }

  // Update state
  if (allTweets.length > 0) {
    state.lastTweetId = allTweets[0].id;
    state.lastTweetTime = Math.max(
      state.lastTweetTime || 0,
      ...allTweets.map((t) => new Date(t.createdAt).getTime()).filter(Boolean),
    );
  }
  state.seenIds = [...seenIds];
  saveState(state);

  // Output
  const result = JSON.stringify(
    {
      status: "ok",
      newTweets,
      totalFetched: allTweets.length,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  console.log(result);

  if (newTweets.length > 0) {
    for (const t of newTweets.reverse()) {
      process.stderr.write(`[NEW] ${t.text.slice(0, 120)}...\n`);
      process.stderr.write(`      ${t.url}\n`);
    }
  }
}

main();
