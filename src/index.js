import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { DateTime } from "luxon";
import { Client, GatewayIntentBits, Partials, Events, AttachmentBuilder } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeReadJSON(p) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  return {};
}
const ENV = safeReadJSON(path.join(__dirname, "env.json")) || safeReadJSON(path.join(__dirname, "..", "env.json"));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

function MORNING_TEXT() {
  return `**Good Morning Team!** ☀️\n\nPlease complete your **Morning Precheck Video** using the app link below.\n\n📲 **App Link:** ${ENV.PORTAL_URL}\n*(Pro Tip: Tap 'Share' then 'Add to Home Screen' to install as an app)*`;
}

function EVENING_TEXT() {
  return `**Good Evening Team!** 🌙\n\nPlease complete your **Evening Postcheck Video** before clocking out.\n\n📲 **App Link:** ${ENV.PORTAL_URL}`;
}

async function sendReminder(kind) {
  try {
    const ch = await client.channels.fetch(ENV.REMINDER_CHANNEL_ID);
    if (!ch) return;
    const text = kind === "am" ? MORNING_TEXT() : EVENING_TEXT();
    await ch.send({ content: text });
  } catch (e) { console.error("Reminder error:", e); }
}

client.once(Events.ClientReady, () => {
  console.log("✅ Bot is online");
  cron.schedule("*/30 * * * *", async () => {
    const now = DateTime.now().setZone(ENV.TZ);
    if (now.hour === 10 && now.minute === 0) await sendReminder("am");
    if (now.hour === 18 && now.minute === 0) await sendReminder("pm");
  });
});

client.on(Events.MessageCreate, async (message) => {
  // IGNORE Portal uploads (webhook) so they stay in the channel
  if (message.author.bot || message.webhookId) return;
});

client.login(ENV.DISCORD_TOKEN);
