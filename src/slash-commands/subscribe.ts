import { ChatInputCommandInteraction, ApplicationCommandOptionType, EmbedBuilder, GuildMember, TextChannel } from "discord.js";
import { errorEmbed, successEmbed } from "../util";
import { DiscordCustomer, Postgres } from "../database";
import {
  findActiveSubscriptions,
  findSubscriptionsFromCustomerId,
  getCustomerPayments,
  getLifetimePaymentDate,
  resolveCustomerIdFromEmail,
} from "../integrations/stripe";
import { Not } from "typeorm";

export const commands = [
  {
    name: "subscribe",
    description: "Subscribe or claim your active subscription!",
    options: [
      {
        name: "email",
        description: "Your email address",
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
];

export const run = async (interaction: ChatInputCommandInteraction) => {
  if (interaction.channelId !== process.env.SUBSCRIBE_CHANNEL_ID) {
    return void interaction.reply({
      content: `This command can only be used in <#${process.env.SUBSCRIBE_CHANNEL_ID}>.`,
      ephemeral: true,
    });
  }

  const email = interaction.options.getString("email");

  const userCustomer = await Postgres.getRepository(DiscordCustomer).findOne({
    where: { discordUserId: interaction.user.id },
  });

  if (userCustomer && !email) {
    return void interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(process.env.EMBED_COLOR || "#FFD700")
          .setDescription(`Hey **${interaction.user.username}**, you already have an active subscription linked to your account. You can update it by specifying your email again.`),
      ],
    });
  }

  if (!email) {
    return void interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(process.env.EMBED_COLOR || "#FFD700")
          .setDescription(`Hey **${interaction.user.username}**, you can purchase a new subscription at ${process.env.STRIPE_PAYMENT_LINK} or claim your active subscription by using this command with the email parameter.`),
      ],
    });
  }

  const emailRegex = /^[A-Za-z0-9+_.-]+@(.+)$/;
  if (!emailRegex.test(email)) {
    return void interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setColor(process.env.EMBED_COLOR || "#FFD700")
          .setDescription(`The email address you provided is not valid.`),
      ],
    });
  }

  const existingEmailCustomer = await Postgres.getRepository(DiscordCustomer).findOne({
    where: {
      email,
      discordUserId: Not(interaction.user.id),
    },
  });

  if (existingEmailCustomer) {
    return void interaction.reply({
      ephemeral: true,
      embeds: errorEmbed(`This email address is already in use by another user. Please use a different email address or contact us if you think this is an error.`).embeds,
    });
  }

  const customerId = await resolveCustomerIdFromEmail(email);
  if (!customerId) {
    return void interaction.reply({
      ephemeral: true,
      embeds: errorEmbed(`You do not have an active subscription. Please buy one at ${process.env.STRIPE_PAYMENT_LINK} to access the server.`).embeds,
    });
  }

  const subscriptions = await findSubscriptionsFromCustomerId(customerId);
  const activeSubscriptions = findActiveSubscriptions(subscriptions);

  if (activeSubscriptions.length === 0) {
    return void interaction.reply({
      ephemeral: true,
      embeds: errorEmbed(`You do not have an active subscription. Please buy one at ${process.env.STRIPE_PAYMENT_LINK} to access the server.`).embeds,
    });
  }

  const customer: Partial<DiscordCustomer> = {
    hadActiveSubscription: true,
    // @ts-ignore - ha a típust fixálod DiscordCustomer-ben, ez kivehető
    firstReminderSentDayCount: null,
    email,
    discordUserId: interaction.user.id,
  };

  if (userCustomer) {
    await Postgres.getRepository(DiscordCustomer).update(userCustomer.id, customer);
  } else {
    await Postgres.getRepository(DiscordCustomer).insert(customer);
  }

  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (member) {
    await (member as GuildMember).roles.add(process.env.PAYING_ROLE_ID!);
  }

  const logChannel = interaction.guild?.channels.cache.get(process.env.LOGS_CHANNEL_ID!) as TextChannel | undefined;
  if (logChannel?.isTextBased()) {
    logChannel.send(
      `:arrow_upper_right: **${interaction.user.tag}** (${interaction.user.id}, <@${interaction.user.id}>) has been linked to \`${email}\`.`
    );
  }

  return void interaction.reply({
    ephemeral: true,
    embeds: successEmbed(`Welcome, you are eligible to the exclusive Discord access!`).embeds,
  });
};
