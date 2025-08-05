import { ChatInputCommandInteraction, PermissionsBitField, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ButtonInteraction } from "discord.js";
import { cancelSubscription, findActiveSubscriptions, findSubscriptionsFromCustomerId, resolveCustomerIdFromEmail } from "../integrations/stripe";
import { Postgres, DiscordCustomer } from "../database";
import { errorEmbed } from "../util";

export const commands = [
  {
    name: "cancel",
    description: "Cancel your current subscription",
    options: [
      {
        name: "user",
        description: "The user you want to cancel the subscription for",
        type: 6, // ApplicationCommandOptionType.User
        required: false,
      },
    ],
  },
];

export const run = async (interaction: ChatInputCommandInteraction) => {
  if (interaction.channelId !== process.env.CANCEL_CHANNEL_ID) {
    return void interaction.reply({
      content: `This command can only be used in <#${process.env.CANCEL_CHANNEL_ID}>.`,
      ephemeral: true,
    });
  }

  const user = interaction.options.getUser("user") || interaction.user;

  if (interaction.options.getUser("user") && !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    return void interaction.reply({
      content: `You don't have the permission to cancel someone else's subscription.`,
      ephemeral: true,
    });
  }

  const discordCustomer = await Postgres.getRepository(DiscordCustomer).findOne({
    where: {
      discordUserId: user.id,
    },
  });

  if (!discordCustomer) {
    return void interaction.reply({
      ephemeral: true,
      embeds: errorEmbed(`There is no email linked to your account!`).embeds,
    });
  }

  const customerId = await resolveCustomerIdFromEmail(discordCustomer.email);
  const subscriptions = await findSubscriptionsFromCustomerId(customerId);
  const active = findActiveSubscriptions(subscriptions)[0];

  if (!active) {
    return void interaction.reply({
      ephemeral: true,
