// src/index.js
// SLGP Fleet Manager Bot – full build with ops alerts + optional Sheets logging
// Node 20+, discord.js v14

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, Events, PermissionFlagsBits } from "discord.js";
import cron from "node-cron";
import { DateTime } from "luxon";
import { google } from "googleapis";

// ---------- utils: env loader (Railway env first, then local src/env.json) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ENV = {};
try {
  const p = path.join(__dirname, "env.json");
  if (fs.existsSync(p)) {
    ENV = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log("✅ Loaded env.json");
  }
} catch (e) {
  console.warn("⚠️ Could not read env.json:", e.message);
}
function getEnv(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (ENV && ENV[key] !== undefined) return ENV[key];
  return fallback;
}

// ---------- config ----------
const DISCORD_TOKEN = getEnv("DISCORD_TOKEN");
const CLIENT_ID = getEnv("CLIENT_ID");
const GUILD_ID = getEnv("GUILD_ID");
const REMINDER_CHANNEL_ID = getEnv("REMINDER_CHANNEL_ID");

const TZ = getEnv("TZ", "America/New_York");
const SCAN_AM_START = getEnv("SCAN_AM_START", "10:20");
const SCAN_AM_END   = getEnv("SCAN_AM_END",   "11:00");
const SCAN_PM_START = getEnv("SCAN_PM_START", "18:00");
const SCAN_PM_END   = getEnv("SCAN_PM_END",   "23:00");

const ENFORCE_DELETE = String(getEnv("ENFORCE_DELETE", "true")) === "true";
const ALERT_DELETE_GRACE_SEC = Number(getEnv("ALERT_DELETE_GRACE_SEC", "15"));

const AUTO_REGISTER = String(getEnv("AUTO_REGISTER", "true")) === "true";
const REGISTER_SCOPE = getEnv("REGISTER_SCOPE", "guild"); // "guild" fast, or "global"

// Ops alert settings
const ALERT_CHANNEL_ID = getEnv("ALERT_CHANNEL_ID", REMINDER_CHANNEL_ID);
const ALERT_ON_RESTART = String(getEnv("ALERT_ON_RESTART", "true")) === "true";
const ALERT_ON_CRASH   = String(getEnv("ALERT_ON_CRASH", "true")) === "true";

// Optional Sheets settings
const GSHEETS_ENABLED     = String(getEnv("GSHEETS_ENABLED", "false")) === "true";
const SPREADSHEET_ID      = getEnv("SPREADSHEET_ID");
const GOOGLE_CLIENT_EMAIL = getEnv("GOOGLE_CLIENT_EMAIL");
const GOOGLE_PRIVATE_KEY  = getEnv("GOOGLE_PRIVATE_KEY");
const SHEET_NAME          = getEnv("SHEET_NAME", "OpsLog");

// Quick display for local dev
console.log("⚙️  Configuration:");
console.log({
  CLIENT_ID, GUILD_ID, REMINDER_CHANNEL_ID, TZ,
  SCAN_AM_START, SCAN_AM_END, SCAN_PM_START, SCAN_PM_END,
  ENFORCE_DELETE, ALERT_DELETE_GRACE_SEC, AUTO_REGISTER, REGISTER_SCOPE,
  GSHEETS_ENABLED
});

// ---------- discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- Google Sheets (optional) ----------
let sheets = null;
async function initSheets() {
  if (!GSHEETS_ENABLED) return;
  try {
    const jwt = new google.auth.JWT(
      GOOGLE_CLIENT_EMAIL,
      undefined,
      GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/spreadsheets"]
    );
    sheets = google.sheets({ version: "v4", auth: jwt });
    console.log("✅ Google Sheets ready");
  } catch (e) {
    console.warn("⚠️ Sheets init failed:", e.message);
  }
}
async function logRow(type, detail) {
  if (!GSHEETS_ENABLED || !sheets) return;
  try {
    const now = DateTime.now().setZone(TZ).toISO();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[now, type, detail]] }
    });
  } catch (e) {
    console.warn("⚠️ logRow error:", e.message);
  }
}

// ---------- OPS alert helper ----------
async function sendOpsAlert(text) {
  try {
    if (!ALERT_CHANNEL_ID) return;
    const ch = await client.channels.fetch(ALERT_CHANNEL_ID);
    if (!ch) return;
    const now = DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd HH:mm:ss");
    await ch.send(`🛠️ **Ops** — ${now}\n${text}`);
  } catch (e) {
    console.error("sendOpsAlert error:", e);
  }
}

// ---------- content validation ----------
const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"];
function hasVideoAttachment(msg) {
  return (msg.attachments?.size || 0) > 0 && [...msg.attachments.values()].some(a => {
    const name = (a.name || "").toLowerCase();
    return VIDEO_EXTS.some(ext => name.endsWith(ext));
  });
}
function hasKeyword(text) {
  const s = text.toLowerCase();
  return s.includes("precheck") || s.includes("postcheck") || s.includes("pre-check") || s.includes("post-check");
}
function hasVanOrVIN(text) {
  const s = text.toLowerCase();
  // simple patterns: "van 18" or "van #18" or 4+ consecutive digits (VIN last 4)
  return /(van\s*#?\s*\d{1,3})\b/.test(s) || /\b\d{4,6}\b/.test(s);
}
function hasNameLike(text) {
  // super-light heuristic: at least two words with letters
  return /\b[a-z]{2,}\s+[a-z]{2,}\b/i.test(text);
}

function buildRemovalWarning(kindMissing) {
  return (
`⚠️ Your ${kindMissing.includes("Precheck") ? "Precheck" : "upload"} was removed because it's missing: **${kindMissing.join(", ")}**.

Please include:
• Your Name
• Van # (or last 4 of VIN)
• The word “Precheck” or “Postcheck”
• A video attachment (≤ 35 seconds, **HD only** — not UHD/FHD)

Thanks!`
  );
}

// ---------- message monitor ----------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (String(message.channelId) !== String(REMINDER_CHANNEL_ID)) return;

    const content = (message.content || "").trim();
    const problems = [];

    if (!hasKeyword(content)) problems.push("keyword “Precheck” or “Postcheck”");
    if (!hasVideoAttachment(message)) problems.push("video");
    if (!hasVanOrVIN(content)) problems.push("van # or last 4 of VIN");
    if (!hasNameLike(content)) problems.push("your name");

    if (problems.length > 0) {
      // warn first
      const warn = await message.reply(buildRemovalWarning(problems));
      await logRow("WARN", `Warned ${message.author?.tag} for missing: ${problems.join(", ")}`);

      if (ENFORCE_DELETE) {
        // delete after grace
        setTimeout(async () => {
          try {
            await message.delete();
            await logRow("DELETE", `Deleted bad upload from ${message.author?.tag}`);
          } catch (e) {
            console.warn("Delete failed:", e.message);
          }
          try {
            await warn.edit(warn.content + `\n\n(_Original message auto-removed after ${ALERT_DELETE_GRACE_SEC}s_)`);
          } catch {}
        }, Math.max(1000, ALERT_DELETE_GRACE_SEC * 1000));
      }
    } else {
      await logRow("OK", `Accepted upload from ${message.author?.tag}`);
    }
  } catch (e) {
    console.error("MessageCreate error:", e);
  }
});

// ---------- reminders ----------
const MORNING_TEXT = () => {
  const day = DateTime.now().setZone(TZ).toFormat("cccc");
  return (
`☀️ **Good Morning Team & Happy ${day}!**

Please make sure to complete your Discord **Fleet Check Video** *before the morning meeting*.

Include:
• Your Name  
• Van # (or last 4 of VIN)  
• The word “Precheck”  

🎥 Keep it **under 35 seconds** and record in **HD only** (not UHD/FHD).  
📸 Note: Text + Video must be uploaded **together**.

Let’s start the day strong 💪🚐`
  );
};

const EVENING_TEXT = () => (
`🌙 **Good Evening Team — hope you had a great day!**

Please complete your Discord **Fleet Check Video** *before clocking out*.

Include:
• Your Name  
• Van # (or last 4 of VIN)  
• The word “Postcheck”  

🎥 Keep it **under 35 seconds** and record in **HD only** (not UHD/FHD).  
📸 Note: Text + Video must be uploaded **together**.

Let’s finish the day strong 💪🚐`
);

async function sendReminder(kind) {
  const ch = await client.channels.fetch(REMINDER_CHANNEL_ID);
  if (!ch) return;
  const text = (kind === "am") ? MORNING_TEXT() : EVENING_TEXT();
  await ch.send(text);
  await logRow("REMINDER", kind.toUpperCase());
}

function withinWindow(startHHmm, endHHmm) {
  const now = DateTime.now().setZone(TZ);
  const [sh, sm] = startHHmm.split(":").map(Number);
  const [eh, em] = endHHmm.split(":").map(Number);
  const start = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = now.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  return now >= start && now <= end;
}

// every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  try {
    const now = DateTime.now().setZone(TZ).toFormat("HH:mm");
    console.log(`⏰ Cron tick @ ${now} ${TZ}`);

    if (withinWindow(SCAN_AM_START, SCAN_AM_END)) {
      await sendReminder("am");
    } else if (withinWindow(SCAN_PM_START, SCAN_PM_END)) {
      await sendReminder("pm");
    }
  } catch (e) {
    console.error("cron error:", e);
  }
}, { timezone: TZ });

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Bot health check"),
  new SlashCommandBuilder().setName("scanstatus").setDescription("Report current scan window & settings"),
  new SlashCommandBuilder()
    .setName("sendreminder")
    .setDescription("Send a reminder now")
    .addStringOption(o => o.setName("type")
      .setDescription("am or pm")
      .setRequired(true)
      .addChoices({ name: "am", value: "am" }, { name: "pm", value: "pm" }))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(c => c.toJSON());

async function registerCommands() {
  if (!AUTO_REGISTER) return;
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    if (REGISTER_SCOPE === "guild" && GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("✅ Registered guild commands");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Registered global commands (may take up to 1 hour)");
    }
  } catch (e) {
    console.error("Register commands failed:", e);
    await sendOpsAlert(`❗ Command registration failed: \`${e.message}\``);
  }
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === "ping") {
      await i.reply({ content: "pong", ephemeral: true });
    } else if (i.commandName === "scanstatus") {
      const txt =
`**Timezone:** ${TZ}
**AM Window:** ${SCAN_AM_START} – ${SCAN_AM_END}
**PM Window:** ${SCAN_PM_START} – ${SCAN_PM_END}
**Enforce Delete:** ${ENFORCE_DELETE} (grace ${ALERT_DELETE_GRACE_SEC}s)
**Channel:** <#${REMINDER_CHANNEL_ID}>`;
      await i.reply({ content: txt, ephemeral: true });
    } else if (i.commandName === "sendreminder") {
      const kind = i.options.getString("type");
      await sendReminder(kind === "am" ? "am" : "pm");
      await i.reply({ content: `Sent ${kind.toUpperCase()} reminder.`, ephemeral: true });
    }
  } catch (e) {
    console.error("Interaction error:", e);
    try { await i.reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
});

// ---------- lifecycle hooks ----------
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await initSheets();
  if (ALERT_ON_RESTART) await sendOpsAlert("✅ Bot started/restarted and is online.");
  await logRow("START", "Bot online");
  await registerCommands();
});

// graceful stops (Railway deploy/stop)
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    try { await sendOpsAlert(`🛑 Bot shutting down (${sig})`); } catch {}
    await logRow("STOP", `Signal ${sig}`);
    setTimeout(() => process.exit(0), 300);
  });
}

// unexpected errors
process.on("unhandledRejection", async (err) => {
  console.error("unhandledRejection:", err);
  if (ALERT_ON_CRASH) {
    const msg = (err && err.stack) ? String(err.stack) : String(err);
    await sendOpsAlert("❗ **Unhandled Rejection**\n```" + msg.slice(0, 1800) + "```");
  }
  await logRow("ERROR", "UnhandledRejection");
});
process.on("uncaughtException", async (err) => {
  console.error("uncaughtException:", err);
  if (ALERT_ON_CRASH) {
    const msg = (err && err.stack) ? String(err.stack) : String(err);
    await sendOpsAlert("❗ **Uncaught Exception**\n```" + msg.slice(0, 1800) + "```");
  }
  await logRow("ERROR", "UncaughtException");
  setTimeout(() => process.exit(1), 500);
});

// ---------- start ----------
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}
client.login(DISCORD_TOKEN);
