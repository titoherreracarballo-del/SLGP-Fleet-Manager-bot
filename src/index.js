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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeReadJSON(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return null;
}
const ENV_FROM_FILE = safeReadJSON(path.join(__dirname, "env.json")) || safeReadJSON(path.join(__dirname, "..", "env.json")) || {};

function getEnv(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (ENV_FROM_FILE && ENV_FROM_FILE[key] !== undefined) return ENV_FROM_FILE[key];
  return fallback;
}

const DISCORD_TOKEN = getEnv("DISCORD_TOKEN", "");
const REMINDER_CHANNEL_ID = getEnv("REMINDER_CHANNEL_ID", "");
const TZ = getEnv("TZ", "America/New_York");
const PORTAL_URL = getEnv("PORTAL_URL", "https://yourusername.github.io/your-repo/");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

function MORNING_TEXT() {
  return (
`**Good Morning Team!** ☀️

Please complete your **Morning Precheck Video** using the app link below.

📲 **App Link:** ${PORTAL_URL}
*(Note: Tap 'Share' then 'Add to Home Screen' to install this as a permanent app)*

Let’s start the day strong 💪🚐`
  );
}

function EVENING_TEXT() {
  return (
`**Good Evening Team!** 🌙

Please complete your **Evening Postcheck Video** using the app link below.

📲 **App Link:** ${PORTAL_URL}

Let’s finish the day strong 💪🚐`
  );
}

const sentSlots = { am: "", pm: "" };

async function sendReminder(kind) {
  try {
    const ch = await client.channels.fetch(REMINDER_CHANNEL_ID);
    if (!ch) return;
    const text = kind === "am" ? MORNING_TEXT() : EVENING_TEXT();
    await ch.send({ content: text });
    console.log(`📢 Sent ${kind.toUpperCase()} reminder`);
  } catch (e) {
    console.error("Reminder error:", e);
  }
}

client.once(Events.ClientReady, () => {
  console.log("✅ Logged in as", client.user.tag);
  
  cron.schedule("*/30 * * * *", async () => {
    const now = DateTime.now().setZone(TZ);
    const key = now.toFormat(`yyyy-LL-dd HH:'${now.minute < 30 ? "00" : "30"}'`);
    
    // Check morning window (example: 10:00 - 11:00)
    if (now.hour === 10 && sentSlots.am !== key) {
      sentSlots.am = key;
      await sendReminder("am");
    }
    // Check evening window (example: 18:00 - 23:00)
    if (now.hour >= 18 && now.hour <= 23 && sentSlots.pm !== key) {
      sentSlots.pm = key;
      await sendReminder("pm");
    }
  }, { timezone: TZ });
});

// Important: This allows Webhook uploads to stay in the channel
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return; // Ignore messages from our new Web App/Webhook
});

client.login(DISCORD_TOKEN);
