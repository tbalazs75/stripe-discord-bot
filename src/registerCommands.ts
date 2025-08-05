import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';

// Tölti be a .env fájlt
config();

const commands: any[] = [];

// Végigmegy a slash-commands mappán, és összegyűjti az exportált parancsokat
const commandFiles = fs.readdirSync('./dist/slash-commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(__dirname, 'slash-commands', file);
    const commandModule = require(filePath);
    if (commandModule.commands && Array.isArray(commandModule.commands)) {
        commands.push(...commandModule.commands);
    }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

(async () => {
    try {
        console.log('🔁 Registering slash commands...');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID!),
            { body: commands },
        );

        console.log('✅ Successfully registered all commands globally!');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
})();
