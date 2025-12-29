// src/register-commands.js — registers /ping and /scanstatus to your GUILD_ID

import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = JSON.parse(fs.readFileSync(path.join(__dirname, 'env.json'), 'utf8'));

const TOKEN = env.DISCORD_TOKEN;
const CLIENT_ID = env.CLIENT_ID;   // Application (bot) ID
const GUILD_ID  = env.GUILD_ID;    // Server ID

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID in src/env.json');
  process.exit(1);
}

const commands = [
  { name: 'ping', description: 'Health check (pong)' },
  { name: 'scanstatus', description: 'Show today’s fleet-check compliance summary (AM/PM).' }
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

try {
  console.log('Registering application commands…');
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Commands registered to guild:', GUILD_ID);
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}
