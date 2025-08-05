import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";

export const commands = [
    new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Get the bot's latency")
        .toJSON()
];

export const run = async (interaction: ChatInputCommandInteraction) => {
    await interaction.reply(`🏓 Pong! My latency is currently \`${interaction.client.ws.ping}ms\`.`);
};
