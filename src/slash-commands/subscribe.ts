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
  // válaszidő biztosítása (ne legyen "The app didn't respond")
  await interaction.deferReply({ ephemeral: true });

  // ✅ Egységesített csatorna ellenőrzés + guard
  const allowedChannelId = process.env.EMAIL_COMMAND_CHANNEL_ID;
  if (!allowedChannelId) {
    return void interaction.editReply({ content: `Admin error: EMAIL_COMMAND_CHANNEL_ID is not set.` });
  }
  if (interaction.channelId !== allowedChannelId) {
    return void interaction.editReply({ content: `This command can only be used in <#${allowedChannelId}>.` });
  }

  const email = interaction.options.getString("email");

  const userCustomer = await Postgres.getRepository(DiscordCustomer).findOne({
    where: { discordUserId: interaction.user.id },
  });

  if (userCustomer && !email) {
    return void interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(process.env.EMBED_COLOR || "#FFD700")
          .setDescription(`Hey **${interaction.user.username}**, you already have an active subscription linked to your account. You can update it by specifying your email again.`),
      ],
    });
  }

  if (!email) {
    return void interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(process.env.EMBED_COLOR || "#FFD700")
          .setDescription(`Hey **${interaction.user.username}**, you can purchase a new subscription at ${process.env.STRIPE_PAYMENT_LINK} or claim your active subscription by using this command with the email parameter.`),
      ],
    });
  }

  const emailRegex = /^[A-Za-z0-9+_.-]+@(.+)$/;
  if (!emailRegex.test(email)) {
    return void interaction.editReply({
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
    return void interaction.editReply({
      embeds: errorEmbed(`This email address is already in use by another user. Please use a different email address or contact us if you think this is an error.`).embeds,
    });
  }

  // Stripe lookup (robosztus: ha nincs találat, kulturált üzenet)
  const customerId = await resolveCustomerIdFromEmail(email);
  if (!customerId) {
    return void interaction.editReply({
      embeds: errorEmbed(`You do not have an active subscription. Please buy one at ${process.env.STRIPE_PAYMENT_LINK} to access the server.`).embeds,
    });
  }

  const subscriptions = await findSubscriptionsFromCustomerId(customerId);
  const activeSubscriptions = findActiveSubscriptions(subscriptions);

  if (activeSubscriptions.length === 0) {
    return void interaction.editReply({
      embeds: errorEmbed(`You do not have an active subscription. Please buy one at ${process.env.STRIPE_PAYMENT_LINK} to access the server.`).embeds,
    });
  }

  // DB mentés / frissítés
  const customer: Partial<DiscordCustomer> = {
    hadActiveSubscription: true,
    // @ts-ignore – ha a típust fixálod DiscordCustomer-ben, ez kivehető
    firstReminderSentDayCount: null,
    email,
    discordUserId: interaction.user.id,
  };

  if (userCustomer) {
    await Postgres.getRepository(DiscordCustomer).update(userCustomer.id, customer);
  } else {
    await Postgres.getRepository(DiscordCustomer).insert(customer);
  }

  // 🔐 Biztonságos role-assign
  const roleId = process.env.PAYING_ROLE_ID; // ha nálad DISCORD_ROLE_ID az env neve, írd át erre
  if (!roleId) {
    await interaction.editReply({ content: 'Admin error: PAYING_ROLE_ID is not set.' });
  } else {
    const role = interaction.guild?.roles.cache.get(roleId);
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

    if (!role) {
      await interaction.followUp({ content: `Admin error: role ${roleId} not found in this guild.`, ephemeral: true });
    } else if (!member) {
      await interaction.followUp({ content: `Could not fetch your guild member.`, ephemeral: true });
    } else {
      try {
        await (member as GuildMember).roles.add(roleId);

        // 👇 „ismeretlen” szerep levétele, ha van
        const unknownRoleId = process.env.UNKNOWN_ROLE_ID; // vedd fel Renderen
        if (unknownRoleId && (member as GuildMember).roles.cache.has(unknownRoleId)) {
          try {
            await (member as GuildMember).roles.remove(unknownRoleId);
          } catch (e) {
            console.error('Unknown role remove failed:', e);
            await interaction.followUp({ content: `Note: could not remove the old "ismeretlen" role.`, ephemeral: true });
          }
        }
      } catch (e) {
        console.error('Role add failed:', e);
        await interaction.followUp({ content: `Failed to assign role. Please contact an admin.`, ephemeral: true });
      }
    }
  }

  // Log csatorna (ha van)
  const logChannel = interaction.guild?.channels.cache.get(process.env.LOGS_CHANNEL_ID!) as TextChannel | undefined;
  if (logChannel?.isTextBased()) {
    logChannel.send(`:arrow_upper_right: **${interaction.user.tag}** (${interaction.user.id}, <@${interaction.user.id}>) has been linked to \`${email}\`.`);
  }

  // végső válasz
  return void interaction.editReply({
    embeds: successEmbed(`Remek, sikeres azonosítás! Most menj a #👉első-lépések csatornára.`).embeds,
  });
};
