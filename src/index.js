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
  return {};
}

const ENV = safeReadJSON(path.join(__dirname, "env.json")) || safeReadJSON(path.join(__dirname, "..", "env.json"));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

function MORNING_TEXT() {
  return (
`**Good Morning Team!** ☀️

Please complete your **Morning Precheck Video** using the app link below.

📲 **App Link:** ${ENV.PORTAL_URL}
*(Pro Tip: Tap 'Share' then 'Add to Home Screen' to save it as an app)*

Let’s start the day strong 💪🚐`
  );
}

function EVENING_TEXT() {
  return (
`**Good Evening Team!** 🌙

Please complete your **Evening Postcheck Video** using the app link below before clocking out.

📲 **App Link:** ${ENV.PORTAL_URL}

Let’s finish the day strong 💪🚐`
  );
}

async function sendReminder(kind) {
  try {
    const ch = await client.channels.fetch(ENV.REMINDER_CHANNEL_ID);
    if (!ch) return;
    const text = kind === "am" ? MORNING_TEXT() : EVENING_TEXT();
    await ch.send({ content: text });
    console.log(`📢 Sent ${kind.toUpperCase()} reminder`);
  } catch (e) {
    console.error("Reminder error:", e);
  }
}

client.once(Events.ClientReady, () => {
  console.log("✅ Inspection Bot is online");

  cron.schedule("*/30 * * * *", async () => {
    const now = DateTime.now().setZone(ENV.TZ);
    const key = now.toFormat(`yyyy-LL-dd HH:'${now.minute < 30 ? "00" : "30"}'`);

    // Morning Window
    if (now.hour === 10 && now.minute < 30) {
        await sendReminder("am");
    }
    // Evening Window
    if (now.hour >= 18 && now.hour <= 23 && now.minute < 30) {
        await sendReminder("pm");
    }
  }, { timezone: ENV.TZ });
});

client.on(Events.MessageCreate, async (message) => {
  // IGNORE messages from the Web App (Webhooks) so they stay in the channel
  if (message.author.bot || message.webhookId) return;
});

client.login(ENV.DISCORD_TOKEN);
