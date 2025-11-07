// ========================================================
// SLGP Discord Bot - Core File
// Handles env loading, slash commands, and reminders
// Compatible with local and Railway hosting
// ========================================================

import fs from "fs";
import path from "path";
import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from "discord.js";
import cron from "node-cron";
import { DateTime } from "luxon";

// === 1️⃣ Load env.json (for local dev) ===
const ENV_PATH = path.join(process.cwd(), "src", "env.json");
let ENV = {};
try {
  ENV = JSON.parse(fs.readFileSync(ENV_PATH, "utf8"));
  console.log("✅ Loaded env.json");
} catch (err) {
  console.warn("⚠️ No env.json found or invalid JSON:", err.message);
  ENV = {};
}

// === 2️⃣ Helper to read from Railway env or env.json ===
function getEnv(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (ENV && ENV[key] !== undefined) return ENV[key];
  return fallback;
}

// === 3️⃣ Load config values ===
const DISCORD_TOKEN         = getEnv("DISCORD_TOKEN");
const CLIENT_ID             = getEnv("CLIENT_ID");
const GUILD_ID              = getEnv("GUILD_ID");
const REMINDER_CHANNEL_ID   = getEnv("REMINDER_CHANNEL_ID");
const TZ                    = getEnv("TZ", "America/New_York");

const SCAN_AM_START         = getEnv("SCAN_AM_START", "10:20");
const SCAN_AM_END           = getEnv("SCAN_AM_END", "11:00");
const SCAN_PM_START         = getEnv("SCAN_PM_START", "18:00");
const SCAN_PM_END           = getEnv("SCAN_PM_END", "23:00");

const ENFORCE_DELETE        = getEnv("ENFORCE_DELETE", "true") === "true";
const ALERT_DELETE_GRACE_SEC = Number(getEnv("ALERT_DELETE_GRACE_SEC", "15"));

const AUTO_REGISTER         = getEnv("AUTO_REGISTER", "true") === "true";
const REGISTER_SCOPE        = getEnv("REGISTER_SCOPE", "guild");

const GSHEETS_ENABLED       = getEnv("GSHEETS_ENABLED", "false") === "true";
const SPREADSHEET_ID        = getEnv("SPREADSHEET_ID", "");
const SHEET_NAME            = getEnv("SHEET_NAME", "Uploads");
const GOOGLE_CLIENT_EMAIL   = getEnv("GOOGLE_CLIENT_EMAIL", "");
const GOOGLE_PRIVATE_KEY    = getEnv("GOOGLE_PRIVATE_KEY", "");

// === 4️⃣ Debug summary (non-sensitive) ===
console.log("🧩 Configuration:");
console.log({
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
  AUTO_REGISTER,
  REGISTER_SCOPE,
  GSHEETS_ENABLED
});

// === 5️⃣ Initialize Discord client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// === 6️⃣ Slash Commands ===
const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Replies with pong!"),
  new SlashCommandBuilder()
    .setName("sendreminder")
    .setDescription("Send a manual reminder")
    .addStringOption(o =>
      o.setName("type")
        .setDescription("am | pm | custom")
        .setRequired(true)
        .addChoices(
          { name: "am", value: "am" },
          { name: "pm", value: "pm" },
          { name: "custom", value: "custom" }
        )
    )
    .addStringOption(o =>
      o.setName("text")
        .setDescription("Custom text if type=custom")
        .setRequired(false)
    )
].map(c => c.toJSON());

// === 7️⃣ Auto register commands (on startup) ===
async function autoRegisterCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    if (REGISTER_SCOPE === "guild" && GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("✅ Registered guild commands");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Registered global commands");
    }
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
}

// === 8️⃣ Helper: build AM/PM reminder text ===
function buildMorningMessage() {
  const day = DateTime.now().setZone(TZ).toFormat("cccc");
  return `Good Morning Team & Happy ${day}! ☀️

Please make sure to complete your Discord Fleet Check Video before the morning meeting.

When uploading, be sure to include:
• Your Name  
• Van # (or last 4 of VIN if no van number is visible on the hood)  
• The word “Precheck”

Tip: 🎥 Keep video clear and under 35 seconds (HD only).  
📸 Note: Both text and video must be uploaded together.

Let’s start the day strong 💪🚐`;
}

function buildEveningMessage() {
  return `Good Evening Team, hope you had a great day! 🌙

Please make sure to complete your Discord Fleet Check Video before clocking out.

When uploading, be sure to include:
• Your Name  
• Van # (or last 4 of VIN if no van number is visible on the hood)  
• The word “Postcheck”

Tip: 🎥 Keep video clear and under 35 seconds (HD only).  
📸 Note: Both text and video must be uploaded together.

Let’s finish the day strong! 💪🚐`;
}

// === 9️⃣ Reminder sender ===
async function sendReminderNow(kind, customText) {
  try {
    const channel = await client.channels.fetch(REMINDER_CHANNEL_ID);
    if (!channel) throw new Error("Reminder channel not found.");

    let text;
    if (kind === "am") text = buildMorningMessage();
    else if (kind === "pm") text = buildEveningMessage();
    else text = customText || "Test reminder message.";

    await channel.send(text);
    console.log(`📣 Sent ${kind.toUpperCase()} reminder`);
  } catch (err) {
    console.error("❌ sendReminderNow error:", err);
  }
}

// === 🔟 Cron jobs for AM & PM reminders ===
cron.schedule("*/30 10-11 * * *", () => {
  const now = DateTime.now().setZone(TZ);
  console.log(`[CRON AM] now=${now.toISO()}`);
  sendReminderNow("am");
}, { timezone: TZ });

cron.schedule("*/30 18-23 * * *", () => {
  const now = DateTime.now().setZone(TZ);
  console.log(`[CRON PM] now=${now.toISO()}`);
  sendReminderNow("pm");
}, { timezone: TZ });

// === 11️⃣ Event handlers ===
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`🤖 Logged in as ${readyClient.user.tag}`);
  if (AUTO_REGISTER) await autoRegisterCommands();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("pong");
    return;
  }

  if (interaction.commandName === "sendreminder") {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const type = interaction.options.getString("type", true);
    const text = interaction.options.getString("text") || undefined;
    try {
      await sendReminderNow(type, text);
      await interaction.editReply(`Reminder sent (${type}).`).catch(() => {});
    } catch (err) {
      await interaction.editReply(`Failed: ${err.message}`).catch(() => {});
    }
  }
});

// === 12️⃣ Login ===
client.login(DISCORD_TOKEN);
