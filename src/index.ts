// Környezeti változók betöltése
import { config } from 'dotenv';
config();

import './sentry';

import { initialize as initializeDatabase } from './database';
import { loadContextMenus, loadMessageCommands, loadSlashCommands, synchronizeSlashCommands } from './handlers/commands';
import { syncSheets } from './integrations/sheets';

import { Client, IntentsBitField, PermissionsBitField } from 'discord.js';
import { errorEmbed } from './util';
import { loadTasks } from './handlers/tasks';

export const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMembers
    ]
});

const { slashCommands, slashCommandsData } = loadSlashCommands(client);
const { contextMenus, contextMenusData } = loadContextMenus(client);
const messageCommands = loadMessageCommands(client);
const tasks = loadTasks(client);

synchronizeSlashCommands(client, [...slashCommandsData, ...contextMenusData], {
    debug: true,
    guildId: process.env.GUILD_ID
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isCommand()) {
        const isContext = interaction.isContextMenuCommand();
        if (isContext) {
            const run = contextMenus.get(interaction.commandName);
            if (!run) return;
            run(interaction, interaction.commandName);
        } else {
            const run = slashCommands.get(interaction.commandName);
            if (!run) return;
            run(interaction, interaction.commandName);
        }
    }
});

client.on('messageCreate', (message) => {
    if (message.author.bot) return;

    if (!process.env.COMMAND_PREFIX) return;

    if ((message.channelId === process.env.STATUS_CHANNEL_ID || message.channelId === process.env.SUBSCRIBE_CHANNEL_ID || message.channelId === process.env.CANCEL_CHANNEL_ID) && !message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        message.delete();
    }

    const args = message.content.slice(process.env.COMMAND_PREFIX.length).split(/ +/);
    const commandName = args.shift();
    if (!commandName) return;

    const run = messageCommands.get(commandName);
    if (!run) return;

    run(message, commandName);
});

client.on('ready', () => {
    console.log(`✅ Logged in as ${client.user!.tag}. Ready to serve ${client.users.cache.size} users in ${client.guilds.cache.size} servers`);

    if (process.env.DB_NAME) {
        initializeDatabase().then(() => {
            console.log('📦 Database initialized');

            if (process.argv.includes('--sync')) {
                tasks.tasks.first()?.run();
            }
        });
    } else {
        console.log('⚠️ Database not initialized, as no keys were specified');
    }

    if (process.env.SPREADSHEET_ID) {
        syncSheets();
    }
});

client.login(process.env.DISCORD_CLIENT_TOKEN);

// -----------------------------
// Stripe webhook endpoint
// -----------------------------

import express from "express";
import webhookRouter from "./webhook";

const app = express();

// Stripe webhook (raw body parser)
app.use("/api/webhook", express.raw({ type: "application/json" }), webhookRouter);

// KÖSZÖNŐOLDAL – Discord invite link megjelenítése
app.get("/thanks", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Az átjáró megnyílt! 🎉</title>
  <style>
    body {
      font-family: sans-serif;
      text-align: center;
      padding: 10vh 5vw;
      background: #f9f9f9;
    }
    h1 {
      font-size: 6vw;
    }
    p {
      font-size: 4.5vw;
      margin-top: 20px;
    }
    a.button {
      font-size: 5vw;
      padding: 14px 28px;
      background-color: #5865F2;
      color: white;
      border-radius: 8px;
      text-decoration: none;
      display: inline-block;
      margin-top: 30px;
    }
    @media (min-width: 768px) {
      h1 { font-size: 32px; }
      p { font-size: 20px; }
      a.button { font-size: 20px; }
    }
  </style>
</head>
<body>
  <h1>Az átjáró megnyílt! 🎉</h1>
  <p>Most már beléphetsz a Tányéros Coaching közösségbe:</p>
  <a href="https://discord.gg/SEdAQcja" class="button" target="_blank">
    👉 Csatlakozom a Tanítványokhoz!
  </a>
</body>
</html>`);
});


// (opcionális) További route-ok JSON body parserrel:
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
