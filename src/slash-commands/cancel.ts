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
      embeds: errorEmbed(`You don't have an active subscription!`).embeds,
    });
  }

  const confirmEmbed = new EmbedBuilder()
    .setAuthor({ name: `${user.tag} cancellation`, iconURL: user.displayAvatarURL() })
    .setDescription(`Are you sure you want to cancel your subscription?`)
    .setColor(process.env.EMBED_COLOR);

  const randomId = Math.floor(Math.random() * 900) + 100;
  const customId = `cancel-confirm-${user.id}-${randomId}`;

  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Danger)
    ),
  ];

  await interaction.reply({ ephemeral: true, embeds: [confirmEmbed], components });

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) return;

  const collector = channel.createMessageComponentCollector({
    filter: (i) => i.customId === customId,
    time: 1000 * 60 * 5,
  });

  collector.on("collect", async (_i) => {
    const i = _i as ButtonInteraction;

    if (!i.isButton()) return;
    if (i.customId !== customId) return;

    await cancelSubscription(active.id);

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${user.tag} cancellation`, iconURL: user.displayAvatarURL() })
      .setDescription(`We're sorry to see you go! Your subscription has been cancelled.`)
      .setColor(process.env.EMBED_COLOR);

    await i.reply({ ephemeral: true, embeds: [embed], components: [] });
  });

  collector.on("end", async () => {
    await interaction.editReply({ embeds: [confirmEmbed], components: [] });
  });
};
