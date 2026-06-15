#!/usr/bin/env node
/**
 * Parse X.com UserTweets API response from stdin and detect new tweets.
 * Usage: echo '{"data":...}' | node parse_tweets.mjs <user_id> <display_name>
 * State stored per-user in ~/.musk_monitor/<user_id>.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const userId = process.argv[2];
const displayName = process.argv[3] || userId;

if (!userId) {
  console.error("Usage: parse_tweets.mjs <user_id> [display_name]");
  process.exit(1);
}

const STATE_DIR = join(homedir(), ".musk_monitor");
const STATE_FILE = join(STATE_DIR, `${userId}.json`);

function loadState() {
  if (existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch {}
  }
  return { lastTweetId: null, lastTweetTime: 0, seenIds: [] };
}

function saveState(state) {
  state.seenIds = state.seenIds.slice(-500);
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let rawData = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", c => rawData += c);
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(rawData);
  } catch {
    console.error(JSON.stringify({ status: "error", message: "Invalid JSON" }));
    process.exit(1);
  }

  const state = loadState();
  const seenIds = new Set(state.seenIds || []);

  // Extract tweets from instructions
  const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions || [];
  const entries = [];
  for (const instr of instructions) {
    const items = instr.entries || (instr.entry ? [instr.entry] : []);
    for (const item of items) {
      const tweetResult = item.content?.itemContent?.tweet_results?.result;
      if (tweetResult) entries.push(tweetResult);
    }
  }

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
      isReply: /^@\w/.test(text) && !text.startsWith("RT @"),
      url: `https://x.com/${displayName}/status/${restId}`,
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

  // Update and save state
  if (allTweets.length > 0) {
    state.lastTweetId = allTweets[0].id;
    state.lastTweetTime = Math.max(
      state.lastTweetTime || 0,
      ...allTweets.map(t => new Date(t.createdAt).getTime()).filter(Boolean),
    );
  }
  state.seenIds = [...seenIds];
  saveState(state);

  // Output
  console.log(JSON.stringify({
    status: "ok",
    displayName,
    newTweets,
    totalFetched: allTweets.length,
    checkedAt: new Date().toISOString(),
  }));
});
