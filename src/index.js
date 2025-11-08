// src/index.js
// SLGP Fleet Manager Bot – full build with QR PDF attachment
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  PermissionFlagsBits,
  AttachmentBuilder
} from "discord.js";
import cron from "node-cron";
import { DateTime } from "luxon";

// ---------- env loader ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let ENV = {};
try {
  const p = path.join(__dirname, "env.json");
  if (fs.existsSync(p)) ENV = JSON.parse(fs.readFileSync(p, "utf8"));
} catch {}
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

const SCAN_AM_START = getEnv("SCAN_AM_START", "07:30");
const SCAN_AM_END   = getEnv("SCAN_AM_END",   "08:30");
const SCAN_PM_START = getEnv("SCAN_PM_START", "18:00");
const SCAN_PM_END   = getEnv("SCAN_PM_END",   "23:00");

const ALERT_DELETE_GRACE_SEC = Number(getEnv("ALERT_DELETE_GRACE_SEC", "5"));
const ENFORCE_DELETE = String(getEnv("ENFORCE_DELETE", "true")) === "true";

console.log("⚙️ Loaded config:", { CLIENT_ID, GUILD_ID, REMINDER_CHANNEL_ID, TZ });

// ---------- client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- helper ----------
function hasVideoAttachment(msg) {
  const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"];
  return (msg.attachments?.size || 0) > 0 &&
    [...msg.attachments.values()].some(a => VIDEO_EXTS.some(ext => (a.name || "").toLowerCase().endsWith(ext)));
}
function hasKeyword(text) {
  const s = text.toLowerCase();
  return s.includes("precheck") || s.includes("postcheck");
}
function hasVanOrVIN(text) {
  const s = text.toLowerCase();
  return /(van\s*#?\s*\d{1,3})\b/.test(s) || /\b\d{4,6}\b/.test(s);
}
function hasNameLike(text) {
  return /\b[a-z]{2,}\s+[a-z]{2,}\b/i.test(text);
}

// ---------- message validation ----------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (String(message.channelId) !== String(REMINDER_CHANNEL_ID)) return;
    const content = (message.content || "").trim();
    const problems = [];
    if (!hasKeyword(content)) problems.push("keyword 'Precheck' or 'Postcheck'");
    if (!hasVideoAttachment(message)) problems.push("video");
    if (!hasVanOrVIN(content)) problems.push("van # or last 4 of VIN");
    if (!hasNameLike(content)) problems.push("your name");

    if (problems.length > 0) {
      const warn = `⚠️ <@${message.author.id}>, your upload was removed for missing: **${problems.join(", ")}**.
Please include:
• Your Name
• Van # (or last 4 of VIN)
• The word “Precheck” or “Postcheck”
• A video (≤ 35s, HD only – not UHD/FHD)
_(Message auto-removed after ${ALERT_DELETE_GRACE_SEC}s.)_`;

      const reply = await message.reply(warn);
      if (ENFORCE_DELETE) {
        setTimeout(async () => {
          try { await message.delete(); } catch {}
        }, Math.max(1000, ALERT_DELETE_GRACE_SEC * 1000));
      }
    }
  } catch (e) {
    console.error("Validation error:", e);
  }
});

// ---------- messages ----------
const MORNING_TEXT = () => {
  const day = DateTime.now().setZone(TZ).toFormat("cccc");
  return (
`☀️ **Good Morning Team & Happy ${day}!**

Please make sure to complete your Discord Fleet Check Video **before leaving the station**.

🎥 **Video Tips**
• Keep it under 35 seconds  
• Record in HD only for clear visibility  

📝 **Include in your upload:**
• Your Name  
• Van # (or last 4 of VIN)  
• The word “Precheck”  

⚙️ **Morning Checklist Before Leaving:**  
✅ Gas card in hand  
✅ Charger cable works  
✅ Power bank charged  
✅ Phone mount secured  

⚠️ If you have any issues, please see **Sutton or a Lead** for assistance.  
🚐 Vehicle issues must be reported by scanning the **QR Code (attached)** or using the online form.

📸 Note: Both text and video must be uploaded together.
Let's start the day strong 💪🚐`
  );
};

const EVENING_TEXT = () => (
`🌙 **Good Evening Team!**  
Hope you had a great day.

Please complete your Discord Fleet Check Video **before clocking out**.

🎥 **Video Tips**
• Keep it under 35 seconds  
• Record in HD only for clear visibility  

📝 **Include in your upload:**
• Your Name  
• Van # (or last 4 of VIN)  
• The word “Postcheck”  

📸 Note: Both text and video must be uploaded together.  
🚐 Vehicle issues must be reported by scanning the **QR Code (attached)**.

Let’s finish the day strong 💪🚐`
);

// ---------- reminder sender ----------
async function sendReminder(kind) {
  try {
    const ch = await client.channels.fetch(REMINDER_CHANNEL_ID);
    if (!ch) return;

    const text = (kind === "am") ? MORNING_TEXT() : EVENING_TEXT();
    const pdfPath = path.join(__dirname, "..", "Vehicle_Issue_Label 4 x 6.pdf");
    const files = [];

    if (fs.existsSync(pdfPath)) {
      const file = new AttachmentBuilder(pdfPath, { name: "Vehicle_Issue_Label_4x6.pdf" });
      files.push(file);
    }

    await ch.send({ content: text, files });
    console.log(`📢 Sent ${kind.toUpperCase()} reminder`);
  } catch (e) {
    console.error("sendReminder error:", e);
  }
}

// ---------- schedule ----------
function withinWindow(startHHmm, endHHmm) {
  const now = DateTime.now().setZone(TZ);
  const [sh, sm] = startHHmm.split(":").map(Number);
  const [eh, em] = endHHmm.split(":").map(Number);
  const start = now.set({ hour: sh, minute: sm });
  const end = now.set({ hour: eh, minute: em });
  return now >= start && now <= end;
}

cron.schedule("*/30 * * * *", async () => {
  const now = DateTime.now().setZone(TZ).toFormat("HH:mm");
  console.log(`⏰ Tick ${now}`);
  if (withinWindow(SCAN_AM_START, SCAN_AM_END)) {
    await sendReminder("am");
  } else if (withinWindow(SCAN_PM_START, SCAN_PM_END)) {
    await sendReminder("pm");
  }
}, { timezone: TZ });

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Bot health check"),
  new SlashCommandBuilder().setName("sendreminder").setDescription("Send a reminder manually")
    .addStringOption(o => o.setName("type")
      .setDescription("am or pm")
      .setRequired(true)
      .addChoices({ name: "am", value: "am" }, { name: "pm", value: "pm" }))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Commands registered");
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === "ping") {
    await i.reply({ content: "pong", ephemeral: true });
  } else if (i.commandName === "sendreminder") {
    const kind = i.options.getString("type");
    await sendReminder(kind);
    await i.reply({ content: `Sent ${kind.toUpperCase()} reminder`, ephemeral: true });
  }
});

// ---------- startup ----------
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(DISCORD_TOKEN);
