#!/usr/bin/env node
/**
 * Parse X.com UserTweets API response and detect new tweets from Elon Musk.
 * Reads JSON from stdin (piped from curl), outputs new tweets to stdout.
 * State stored in ~/.musk_monitor_state.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = join(homedir(), ".musk_monitor_state.json");

function loadState() {
  if (existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch {}
  }
  return { lastTweetId: null, lastTweetTime: 0, seenIds: [] };
}

function saveState(state) {
  state.seenIds = state.seenIds.slice(-500);
  const dir = join(homedir(), ".musk_monitor");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
    process.stderr.write(JSON.stringify({ status: "error", message: "Invalid JSON from API" }) + "\n");
    process.exit(1);
  }

  const state = loadState();
  const seenIds = new Set(state.seenIds || []);

  // Extract tweet entries from instructions
  const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions || [];
  const entries = [];
  for (const instr of instructions) {
    const items = instr.entries || (instr.entry ? [instr.entry] : []);
    for (const item of items) {
      const tweetResult = item.content?.itemContent?.tweet_results?.result;
      if (tweetResult) entries.push(tweetResult);
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
      isReply: /^@\w/.test(text) && !text.startsWith("RT @"),
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
      ...allTweets.map(t => new Date(t.createdAt).getTime()).filter(Boolean),
    );
  }
  state.seenIds = [...seenIds];
  saveState(state);

  // Output
  const result = { status: "ok", newTweets, totalFetched: allTweets.length, checkedAt: new Date().toISOString() };
  console.log(JSON.stringify(result, null, 2));

  if (newTweets.length > 0) {
    for (const t of newTweets.reverse()) {
      process.stderr.write(`[NEW] ${t.text.slice(0, 120)}...\n      ${t.url}\n`);
    }
  }
});
