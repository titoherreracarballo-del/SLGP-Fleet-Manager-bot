// SLGP Fleet Manager Bot - full build with QR PDF attachment + detailed validation
// Uses Node ESM. Ensure "type": "module" in package.json.

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
  AttachmentBuilder,
} from "discord.js";
import cron from "node-cron";
import { DateTime } from "luxon";

// -------------------- env loader --------------------
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
  console.log("⚠️ Could not load env.json:", e?.message || e);
}

// Read from Railway/Process env first, then env.json, else fallback
function getEnv(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (ENV && ENV[key] !== undefined) return ENV[key];
  return fallback;
}

// -------------------- config --------------------
const DISCORD_TOKEN = getEnv("DISCORD_TOKEN");
const CLIENT_ID = getEnv("CLIENT_ID");
const GUILD_ID = getEnv("GUILD_ID");
const REMINDER_CHANNEL_ID = getEnv("REMINDER_CHANNEL_ID");

const TZ = getEnv("TZ", "America/New_York");

// Reminder windows (inclusive)
const SCAN_AM_START = getEnv("SCAN_AM_START", "10:00"); // default AM window start 10:00
const SCAN_AM_END   = getEnv("SCAN_AM_END",   "11:00");
const SCAN_PM_START = getEnv("SCAN_PM_START", "18:00");
const SCAN_PM_END   = getEnv("SCAN_PM_END",   "23:00");

// Invalid upload handling
const ENFORCE_DELETE = String(getEnv("ENFORCE_DELETE", "true")) === "true";
const ALERT_DELETE_GRACE_SEC = Number(getEnv("ALERT_DELETE_GRACE_SEC", "5")); // 5s default

console.log("⚙️ Configuration:", {
  CLIENT_ID,
  GUILD_ID,
  REMINDER_CHANNEL_ID,
  TZ,
  SCAN_AM_START,
  SCAN_AM_END,
  SCAN_PM_START,
  SCAN_PM_END,
  ENFORCE_DELETE,
  ALERT_DELETE_GRACE_SEC,
});

// -------------------- discord client --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// -------------------- validation helpers --------------------
function hasVideoAttachment(message) {
  const exts = [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"];
  if (!message.attachments || message.attachments.size === 0) return false;
  return [...message.attachments.values()].some((a) =>
    exts.some((ext) => (a.name || "").toLowerCase().endsWith(ext))
  );
}
function hasKeyword(text) {
  const s = (text || "").toLowerCase();
  return s.includes("precheck") || s.includes("postcheck");
}
function hasVanOrVIN(text) {
  const s = (text || "").toLowerCase();
  const vanPattern = /(van\s*#?\s*\d{1,3})\b/; // e.g., "Van 18"
  const vinDigits = /\b\d{4,6}\b/;            // last 4–6 digits
  return vanPattern.test(s) || vinDigits.test(s);
}
function hasNameLike(text) {
  return /\b[a-z]{2,}\s+[a-z]{1,}\b/i.test(text || "");
}

// -------------------- detailed validation reply --------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (String(message.channelId) !== String(REMINDER_CHANNEL_ID)) return;

    const content = (message.content || "").trim();

    // Construct display name
    const display =
      message.member?.displayName ||
      message.author?.globalName ||
      message.author?.tag ||
      message.author?.username ||
      `User ${message.author?.id}`;

    const missingPretty = [];

    if (!hasKeyword(content)) {
      missingPretty.push("**keyword** (“Precheck” or “Postcheck”)");
    }
    if (!hasVideoAttachment(message)) {
      missingPretty.push("**video attachment** (≤ 35s, HD only — not UHD/FHD)");
    }
    if (!hasVanOrVIN(content)) {
      missingPretty.push("**van #** or **last 4 of VIN**");
    }
    if (!hasNameLike(content)) {
      missingPretty.push("**your name** (e.g., `First Last`)");
    }

    if (missingPretty.length === 0) return; // all good

    const detailsList = missingPretty.map((p) => `• ${p}`).join("\n");
    const warn = `👋 Hi **${display}** (<@${message.author.id}>),

Your Discord Fleet Check upload was removed because it’s missing the following required item(s):
${detailsList}

Please re-upload **in this channel** with:
• Your Name  
• Van # (or last 4 of VIN)  
• The word “Precheck” or “Postcheck”  
• A video (≤ 35s, HD only — not UHD/FHD)

**Uploader:** ${display}  
**User ID:** \`${message.author.id}\`

_(This notice auto-removes after ${ALERT_DELETE_GRACE_SEC}s.)_`;

    const reply = await message.reply(warn);

    if (ENFORCE_DELETE) {
      setTimeout(async () => {
        try { await message.delete(); } catch {}
        try { await reply.delete(); } catch {}
      }, Math.max(1000, ALERT_DELETE_GRACE_SEC * 1000));
    }
  } catch (e) {
    console.error("Validation error:", e);
  }
});

// -------------------- reminder message content --------------------
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

⚠️ **Equipment & Vehicle Reminder:**  
Please make sure to **report any damages or non-functioning equipment** using the attached QR code or designated reporting form.  
All issues must be logged before leaving the lot.

🔁 **Verify you have these items before leaving the station:**  
• Van bag  
• Flashlight  
• Dog deterrent  
• Van keys  
• Charging cable  
• Power bank  
• Gas card  

⚠️ If you have any issues, please see **Sutton or a Lead** for assistance.  
🚐 Vehicle issues must be reported by scanning the **QR Code (attached below)** or using the form link if provided.

📸 Note: Both text and video must be uploaded together.
Let’s start the day strong 💪🚐`
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

⚠️ **End-of-Day Reminders:**  
Please make sure to **report any damages or non-functioning equipment** using the attached QR code or designated reporting form.  
All issues must be logged before ending your shift.

🔁 **Return these items to Dispatch before leaving:**  
• Van bag  
• Flashlight  
• Dog deterrent  
• Van keys  
• Charging cable  
• Power bank  
• Gas card  

📸 Note: Both text and video must be uploaded together.  
🚐 Vehicle issues must be reported by scanning the **QR Code (attached below)**.

Let’s finish the day strong 💪🚐`
);

// -------------------- send reminder (attaches QR PDF) --------------------
async function sendReminder(kind) {
  try {
    const ch = await client.channels.fetch(REMINDER_CHANNEL_ID);
    if (!ch) return;

    const text = kind === "am" ? MORNING_TEXT() : EVENING_TEXT();

    // PDF located in project root (one level above src/)
    const pdfPath = path.join(__dirname, "..", "Vehicle_Issue_Label 4 x 6.pdf");
    const files = [];

    if (fs.existsSync(pdfPath)) {
      files.push(new AttachmentBuilder(pdfPath, { name: "Vehicle_Issue_Label_4x6.pdf" }));
    }

    await ch.send({ content: text, files });
    console.log(`📢 Sent ${kind.toUpperCase()} reminder`);
  } catch (e) {
    console.error("sendReminder error:", e);
  }
}

// -------------------- scheduler --------------------
function withinWindow(startHHmm, endHHmm) {
  const now = DateTime.now().setZone(TZ);
  const [sh, sm] = startHHmm.split(":").map(Number);
  const [eh, em] = endHHmm.split(":").map(Number);
  const start = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = now.set({ hour: eh, minute: em, second: 59, millisecond: 999 });
  return now >= start && now <= end;
}

// Every 30 minutes, post within windows
cron.schedule(
  "*/30 * * * *",
  async () => {
    const nowStr = DateTime.now().setZone(TZ).toFormat("HH:mm");
    console.log(`⏰ Tick ${nowStr}`);
    if (withinWindow(SCAN_AM_START, SCAN_AM_END)) {
      await sendReminder("am");
    } else if (withinWindow(SCAN_PM_START, SCAN_PM_END)) {
      await sendReminder("pm");
    }
  },
  { timezone: TZ }
);

// -------------------- slash commands --------------------
const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Bot health check"),
  new SlashCommandBuilder()
    .setName("sendreminder")
    .setDescription("Send a reminder manually (am or pm)")
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("am or pm")
        .setRequired(true)
        .addChoices({ name: "am", value: "am" }, { name: "pm", value: "pm" })
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered");
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === "ping") {
      await i.reply({ content: "pong", ephemeral: true });
    }
    if (i.commandName === "sendreminder") {
      const kind = i.options.getString("type");
      await sendReminder(kind);
      await i.reply({ content: `Sent ${kind.toUpperCase()} reminder.`, ephemeral: true });
    }
  } catch (e) {
    console.error("Interaction error:", e);
  }
});

// -------------------- startup --------------------
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("Command registration error:", e);
  }
});

client.login(DISCORD_TOKEN);
