import { MessageCommandRunFunction } from "../handlers/commands";
import { isTextBasedChannel } from "../utils/discord"; // csak ha van ilyen függvényed
import { TextChannel } from "discord.js";

export const commands = [
    'ping'
];

export const run: MessageCommandRunFunction = async (message) => {
    if (message.channel && message.channel.isTextBased && message.channel.isTextBased()) {
        message.channel.send(`🏓 Pong! My latency is currently \`${message.client.ws.ping}ms\`.`);
    }
}
