// src/test-send.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  Events,
} from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- load env from src/env.json or ../env.json + process.env ----
function safeReadJSON(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {};
}
const ENV =
  safeReadJSON(path.join(__dirname, "env.json")) ||
  safeReadJSON(path.join(__dirname, "..", "env.json")) ||
  {};

function getEnv(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (ENV[key] !== undefined) return ENV[key];
  return fallback;
}

const DISCORD_TOKEN = getEnv("DISCORD_TOKEN", "");
const REMINDER_CHANNEL_ID = getEnv("REMINDER_CHANNEL_ID", "");
const EXAMPLE_VIDEO_PATH = getEnv("EXAMPLE_VIDEO_PATH", "./prepostcheck example.mp4");
const QR_CODE_PATH = getEnv("QR_CODE_PATH", "./Vehicle_Issue_Label 4 x 6.pdf");

// ---- messages ----
function MORNING_TEXT() {
  return (
`**Good Morning Team!** ☀️

Please complete your **Discord Fleet Precheck Video** before the morning meeting.

**Tip: When recording your video**
• Keep it under **35 seconds**
• Record in **HD only** for clear visibility (not UHD/FHD)

**When uploading, include:**
• **Your Name**
• **Van #** (or **last 4 of the VIN** if no van # is visible on the hood)
• The word **"Precheck"** (accepted: \`precheck\`, \`pre check\`, \`pre-check\`)
• Attach your **video**

**Before leaving the lot, make sure you have:**
• **Van bag**, **Flashlight**, **Dog deterrent**, **Van keys**
• **Charge cable** & **Power bank (charged)**
• **Gas card**

🚐 Vehicle issues must be reported by scanning the **QR Code (attached)**.

Let’s start the day strong 💪🚐`
  );
}

function EVENING_TEXT() {
  return (
`**Good Evening Team, hope you had a great day!** 🌙

Please complete your **Discord Fleet Postcheck Video** before clocking out.

**Tip: When recording your video**
• Keep it under **35 seconds**
• Record in **HD only** for clear visibility (not UHD/FHD)

**When uploading, include:**
• **Your Name**
• **Van #** (or **last 4 of the VIN** if no van # is visible on the hood)
• The word **"Postcheck"** (accepted: \`postcheck\`, \`post check\`, \`post-check\`)
• Attach your **video**

**Return these items before clocking out:**
• **Van bag**, **Flashlight**, **Dog deterrent**, **Van keys**
• **Charge cable** & **Power bank**, **Gas card**

⚠️ Report **any damages or non-functioning equipment** using the **QR Code (attached)**.

Let’s finish the day strong 💪🚐`
  );
}

function resolveAttachment(relOrAbs, defaultName) {
  try {
    const abs = path.isAbsolute(relOrAbs)
      ? relOrAbs
      : path.join(__dirname, "..", relOrAbs);
    if (fs.existsSync(abs)) {
      const safeName = path.basename(abs).replace(/\s+/g, "_") || defaultName;
      return new AttachmentBuilder(abs, { name: safeName });
    } else if (relOrAbs) {
      console.warn("⚠️ File not found:", abs);
    }
  } catch (e) {
    console.warn("⚠️ Could not load file:", relOrAbs, e.message);
  }
  return null;
}

async function run() {
  if (!DISCORD_TOKEN || !REMINDER_CHANNEL_ID) {
    console.error("❌ Missing DISCORD_TOKEN or REMINDER_CHANNEL_ID");
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    // Increase REST timeout to 2 minutes to handle slower uploads
    rest: { timeout: 120000 },
  });

  client.once(Events.ClientReady, async () => {
    console.log("✅ Logged in, sending test messages…");

    try {
      const ch = await client.channels.fetch(REMINDER_CHANNEL_ID);

      // first send text + QR (fast)
      const qr = resolveAttachment(QR_CODE_PATH, "QR.pdf");
      const textFiles = [];
      if (qr) textFiles.push(qr);

      await ch.send({ content: MORNING_TEXT(), files: textFiles });
      console.log("☀️ Morning message sent.");

      // if you want the example video, send it as a separate message
      const vid = resolveAttachment(EXAMPLE_VIDEO_PATH, "example.mp4");
      if (vid) {
        await ch.send({ content: "📹 Example video:", files: [vid] });
        console.log("🎞️ Morning example video sent.");
      }

      await ch.send({ content: EVENING_TEXT(), files: textFiles });
      console.log("🌙 Evening message sent.");

      if (vid) {
        await ch.send({ content: "📹 Example video:", files: [vid] });
        console.log("🎞️ Evening example video sent.");
      }
    } catch (e) {
      console.error("❌ Failed to send test messages:", e);
    } finally {
      setTimeout(() => process.exit(0), 1500);
    }
  });

  client.login(DISCORD_TOKEN);
}

run();
