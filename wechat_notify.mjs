#!/usr/bin/env node
/**
 * Send a WeChat notification via the WeChat Claude Code bridge API.
 * Usage: echo "message text" | node wechat_notify.mjs
 *    or: node wechat_notify.mjs "message text"
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = join(homedir(), ".wechat-claude-code");
const ACCOUNTS_DIR = join(DATA_DIR, "accounts");
const BASE_URL = "https://ilinkai.weixin.qq.com";
const MIN_SEND_INTERVAL = 2500;

function loadAccount() {
    let files;
    try {
        files = readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith(".json"));
    } catch {
        console.error("No accounts directory found. Please run setup first.");
        process.exit(1);
    }
    if (files.length === 0) {
        console.error("No WeChat account found. Please run setup first.");
        process.exit(1);
    }
    const filePath = join(ACCOUNTS_DIR, files[0]);
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
        console.error("Failed to read account file:", filePath);
        process.exit(1);
    }
}

function generateUin() {
    const buf = Buffer.alloc(4);
    // Use simple random values since we don't have web crypto in Node
    for (let i = 0; i < 4; i++) buf[i] = Math.floor(Math.random() * 256);
    return buf.toString("base64");
}

function generateClientId() {
    return `notify-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

const account = loadAccount();
const uin = generateUin();

function makeHeaders() {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.botToken}`,
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": uin,
    };
}

let lastSendTime = 0;

async function sendMessage(toUserId, text) {
    const now = Date.now();
    const wait = MIN_SEND_INTERVAL - (now - lastSendTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastSendTime = Date.now();

    const body = JSON.stringify({
        msg: {
            from_user_id: account.accountId,
            to_user_id: toUserId,
            client_id: generateClientId(),
            message_type: 2, // BOT
            message_state: 2, // FINISH
            context_token: "",
            item_list: [
                {
                    type: 1, // TEXT
                    text_item: { text },
                },
            ],
        },
    });

    const resp = await fetch(`${BASE_URL}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: makeHeaders(),
        body,
    });

    const data = await resp.json();
    return data;
}

async function main() {
    const userId = account.userId;
    if (!userId) {
        console.error("No userId in account data. Please run setup first.");
        process.exit(1);
    }

    // Get message from argv or stdin
    let text = process.argv.slice(2).join(" ");
    if (!text) {
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        text = Buffer.concat(chunks).toString("utf-8").trim();
    }

    if (!text) {
        console.error("No message text provided.");
        process.exit(1);
    }

    try {
        const result = await sendMessage(userId, text);
        if (result.ret !== undefined && result.ret !== 0) {
            console.error("Send failed:", JSON.stringify(result));
            process.exit(1);
        }
        console.log("Sent OK:", text.slice(0, 60) + (text.length > 60 ? "..." : ""));
    } catch (err) {
        console.error("Error sending message:", err.message);
        process.exit(1);
    }
}

main();
