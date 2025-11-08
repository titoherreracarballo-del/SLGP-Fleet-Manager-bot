// src/index.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { DateTime } from "luxon";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  AttachmentBuilder,
} from "discord.js";

// ----------------------------------------
// __dirname in ESM
// ----------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------------------------------
// Load env.json (supports root or src/) + process.env
// ----------------------------------------
function safeReadJSON(p) {
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch {}
  return null;
}
const ENV_FROM_FILE =
  safeReadJSON(path.join(__dirname, "env.json")) ||
  safeReadJSON(path.join(__dirname, "..", "env.json")) ||
  {};

function getEnv(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (ENV_FROM_FILE && ENV_FROM_FILE[key] !== undefined) return ENV_FROM_FILE[key];
  return fallback;
}

// ----------------------------------------
// Config
// ----------------------------------------
const DISCORD_TOKEN = getEnv("DISCORD_TOKEN", "");
const CLIENT_ID = getEnv("CLIENT_ID", "");
const GUILD_ID = getEnv("GUILD_ID", "");
const REMINDER_CHANNEL_ID = getEnv("REMINDER_CHANNEL_ID", "");

const TZ = getEnv("TZ", "America/New_York");

const SCAN_AM_START = getEnv("SCAN_AM_START", "10:00"); // HH:mm
const SCAN_AM_END = getEnv("SCAN_AM_END", "11:00");
const SCAN_PM_START = getEnv("SCAN_PM_START", "18:00");
const SCAN_PM_END = getEnv("SCAN_PM_END", "23:00");

const ENFORCE_DELETE = String(getEnv("ENFORCE_DELETE", "true")).toLowerCase() === "true";
const ALERT_DELETE_GRACE_SEC = Number(getEnv("ALERT_DELETE_GRACE_SEC", "5"));

// Local file attachments
const EXAMPLE_VIDEO_PATH = getEnv("EXAMPLE_VIDEO_PATH", "./prepostcheck example.mp4");
const QR_CODE_PATH = getEnv("QR_CODE_PATH", "./Vehicle_Issue_Label 4 x 6.pdf");

// ----------------------------------------
// Discord client
// ----------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ----------------------------------------
// Helpers: time & windows
// ----------------------------------------
function parseClock(t) {
  const [h, m] = (t || "00:00").split(":").map(Number);
  return { h: h || 0, m: m || 0 };
}
function withinWindow(start, end, nowDT = DateTime.now().setZone(TZ)) {
  const { h: sh, m: sm } = parseClock(start);
  const { h: eh, m: em } = parseClock(end);
  const startDT = nowDT.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const endDT = nowDT.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  return nowDT >= startDT && nowDT <= endDT;
}

// ----------------------------------------
// Helpers: validation
// ----------------------------------------
function detectKeywordKind(text) {
  const s = (text || "").toLowerCase();
  const pre = /\bpre\s*-?\s*check\b/i;
  const post = /\bpost\s*-?\s*check\b/i;
  if (pre.test(s)) return "Precheck";
  if (post.test(s)) return "Postcheck";
  return null;
}
function hasKeyword(text) {
  return detectKeywordKind(text) !== null;
}
function hasVideoAttachment(message) {
  for (const [, att] of message.attachments || []) {
    const name = (att.name || "").toLowerCase();
    const ctype = (att.contentType || "").toLowerCase();
    if (ctype.startsWith("video/")) return true;
    if (/\.(mp4|mov|m4v|webm|mkv)$/i.test(name)) return true;
  }
  return false;
}
function hasVanOrVIN(text) {
  const s = (text || "").toLowerCase();
  // Either "van 18", "van #18", "van#18" or any standalone 4-digit sequence
  if (/\bvan\s*#?\s*\d{1,4}\b/i.test(s)) return true;
  if (/\b\d{4}\b/.test(s)) return true;
  return false;
}
function hasNameLike(text) {
  // Simple check: 2+ alpha words looks like a name
  const words = (text || "").trim().split(/\s+/).filter(w => /^[A-Za-z'-]{2,}$/.test(w));
  return words.length >= 2;
}

// Build morning/evening text (with return-items list & QR mention)
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
• The word **"Precheck"** (formats accepted: \`precheck\`, \`pre check\`, \`pre-check\`)  
• Attach your **video**

**Before leaving the lot, make sure you have:**
• **Van bag**  
• **Flashlight**  
• **Dog deterrent**  
• **Van keys**  
• **Charge cable** & **power bank (charged)**  
• **Gas card**

🚐 Vehicle issues must be reported by scanning the **QR Code (attached below)**.

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
• The word **"Postcheck"** (formats accepted: \`postcheck\`, \`post check\`, \`post-check\`)  
• Attach your **video**

**Return these items before clocking out:**
• **Van bag**  
• **Flashlight**  
• **Dog deterrent**  
• **Van keys**  
• **Charge cable** & **power bank**  
• **Gas card**

⚠️ Please report **any damages or non-functioning equipment** using the **QR Code (attached below)**.

Let’s finish the day strong 💪🚐`
  );
}

// Example media resolver (video & QR)
function resolveExampleVideoAttachment() {
  try {
    const abs = path.isAbsolute(EXAMPLE_VIDEO_PATH)
      ? EXAMPLE_VIDEO_PATH
      : path.join(__dirname, "..", EXAMPLE_VIDEO_PATH);
    if (fs.existsSync(abs)) {
      return new AttachmentBuilder(abs, { name: "prepostcheck_example.mp4" });
    }
  } catch {}
  return null;
}
function resolveQrAttachment() {
  try {
    const abs = path.isAbsolute(QR_CODE_PATH)
      ? QR_CODE_PATH
      : path.join(__dirname, "..", QR_CODE_PATH);
    if (fs.existsSync(abs)) {
      // Preserve extension for correct preview
      const base = path.basename(abs).replace(/\s+/g, "_");
      return new AttachmentBuilder(abs, { name: base });
    }
  } catch {}
  return null;
}

// ----------------------------------------
// Reminders (every 30 minutes, only once per slot)
// ----------------------------------------
const sentSlots = { am: "", pm: "" }; // remember the last 30-min "slot" we sent

function slotKey30(now = DateTime.now().setZone(TZ)) {
  const mm = now.minute < 30 ? "00" : "30";
  return now.toFormat(`yyyy-LL-dd HH:'${mm}'`);
}

async function sendReminder(kind) {
  try {
    const ch = await client.channels.fetch(REMINDER_CHANNEL_ID);
    if (!ch) return;

    const text = kind === "am" ? MORNING_TEXT() : EVENING_TEXT();
    const files = [];
    const qr = resolveQrAttachment();
    if (qr) files.push(qr);

    // (Optional) also include the example video in the reminder
    const vid = resolveExampleVideoAttachment();
    if (vid) files.push(vid);

    await ch.send({ content: text, files });
    console.log(`📢 Sent ${kind.toUpperCase()} reminder`);
  } catch (e) {
    console.error("sendReminder error:", e);
  }
}

function setupReminders() {
  // run every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    const now = DateTime.now().setZone(TZ);
    const key = slotKey30(now);

    if (withinWindow(SCAN_AM_START, SCAN_AM_END, now)) {
      if (sentSlots.am !== key) {
        sentSlots.am = key;
        await sendReminder("am");
      }
    }
    if (withinWindow(SCAN_PM_START, SCAN_PM_END, now)) {
      if (sentSlots.pm !== key) {
        sentSlots.pm = key;
        await sendReminder("pm");
      }
    }
  }, { timezone: TZ });
}

// ----------------------------------------
// Validation of uploads in the reminders channel
// ----------------------------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (String(message.channelId) !== String(REMINDER_CHANNEL_ID)) return;

    const content = (message.content || "").trim();

    const display =
      message.member?.displayName ||
      message.author?.globalName ||
      message.author?.tag ||
      message.author?.username ||
      `User ${message.author?.id}`;

    const detectedKind = detectKeywordKind(content);

    const missingList = [];
    if (!detectedKind) {
      missingList.push("**keyword** (“Precheck” or “Postcheck”, e.g., `precheck`, `pre check`, `pre-check`)");
    }
    if (!hasVideoAttachment(message)) {
      missingList.push("**video attachment** (≤ 35s, HD only — not UHD/FHD)");
    }
    if (!hasVanOrVIN(content)) {
      missingList.push("**van #** or **last 4 of VIN**");
    }
    if (!hasNameLike(content)) {
      missingList.push("**your name** (e.g., `First Last`)");
    }

    if (missingList.length === 0) return; // valid

    const exampleKind =
      detectedKind ||
      (withinWindow(SCAN_AM_START, SCAN_AM_END) ? "Precheck" : "Postcheck");

    const details = missingList.map((m) => `• ${m}`).join("\n");

    const sampleVid = resolveExampleVideoAttachment();
    const qr = resolveQrAttachment();
    const files = [];
    if (qr) files.push(qr);
    if (sampleVid) files.push(sampleVid);

    const warn =
`👋 Hi **${display}** (<@${message.author.id}>),

Your Discord Fleet Check upload was removed because it’s missing the following required item(s):
${details}

Please re-upload **in this channel** with:
• Your Name  
• Van # (or last 4 of VIN)  
• The word “Precheck” or “Postcheck” (formats accepted: \`precheck\`, \`pre check\`, \`pre-check\`)  
• A video (≤ 35s, HD only — not UHD/FHD)

✅ **Example of correct upload:**
\`John Doe — Van #22 — ${exampleKind}\`
*(Attach your 30s HD video here)*

(📎 A QR code for vehicle issues and an example video are attached.)

**Uploader:** ${display}  
**User ID:** \`${message.author.id}\`

_(This notice auto-removes after ${ALERT_DELETE_GRACE_SEC}s.)_`;

    const reply = await message.reply(
      files.length ? { content: warn, files } : { content: warn }
    );

    if (ENFORCE_DELETE) {
      setTimeout(async () => {
        try { await message.delete(); } catch {}
        try { await reply.delete(); } catch {}
      }, Math.max(1000, ALERT_DELETE_GRACE_SEC * 1000));
    }
  } catch (err) {
    console.error("Validation error:", err);
  }
});

// ----------------------------------------
// Basic ready + start
// ----------------------------------------
client.once(Events.ClientReady, () => {
  console.log("✅ Logged in as", client.user?.tag);
  setupReminders();
});

if (!DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN in env.");
  process.exit(1);
}

client.login(DISCORD_TOKEN);
