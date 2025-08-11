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
    description: "Előfizetés vásárlása vagy meglévő előfizetés összekötése.",
    options: [
      {
        name: "email",
        description: "Az e-mail címed",
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
    return void interaction.editReply({ content: `Admin hiba: nincs beállítva az EMAIL_COMMAND_CHANNEL_ID.` });
  }
  if (interaction.channelId !== allowedChannelId) {
    return void interaction.editReply({ content: `Ezt a parancsot csak itt használhatod: <#${allowedChannelId}>.` });
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
          .setDescription(`Szia **${interaction.user.username}**! Már van aktív előfizetésed a fiókodhoz társítva. Ha frissíteni szeretnéd, add meg újra az e-mail címedet.`),
      ],
    });
  }

  if (!email) {
    return void interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(process.env.EMBED_COLOR || "#FFD700")
          .setDescription(`Szia **${interaction.user.username}**! Új előfizetést itt tudsz vásárolni: ${process.env.STRIPE_PAYMENT_LINK}. Ha már van aktív előfizetésed, add meg az e-mail címedet ezzel a paranccsal a hozzárendeléshez.`),
      ],
    });
  }

  const emailRegex = /^[A-Za-z0-9+_.-]+@(.+)$/;
  if (!emailRegex.test(email)) {
    return void interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(process.env.EMBED_COLOR || "#FFD700")
          .setDescription(`A megadott e-mail cím formátuma érvénytelen.`),
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
      embeds: errorEmbed(`Ezt az e-mail címet már egy másik felhasználó használja. Ha szerinted ez hiba, kérlek jelezd nekünk!`).embeds,
    });
  }

  // Stripe lookup (robosztus: ha nincs találat, kulturált üzenet)
  const customerId = await resolveCustomerIdFromEmail(email);
  if (!customerId) {
    return void interaction.editReply({
      embeds: errorEmbed(`Nincs aktív előfizetésed. A szerverhez való hozzáféréshez itt tudsz vásárolni: ${process.env.STRIPE_PAYMENT_LINK}`).embeds,
    });
  }

  const subscriptions = await findSubscriptionsFromCustomerId(customerId);
  const activeSubscriptions = findActiveSubscriptions(subscriptions);

  if (activeSubscriptions.length === 0) {
    return void interaction.editReply({
      embeds: errorEmbed(`Nincs aktív előfizetésed. A szerverhez való hozzáféréshez itt tudsz vásárolni: ${process.env.STRIPE_PAYMENT_LINK}`).embeds,
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
    await interaction.editReply({ content: "Admin hiba: nincs beállítva a PAYING_ROLE_ID." });
  } else {
    const role = interaction.guild?.roles.cache.get(roleId);
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);

    if (!role) {
      await interaction.followUp({ content: `Admin hiba: a(z) ${roleId} szerepkör nem található ezen a szerveren.`, ephemeral: true });
    } else if (!member) {
      await interaction.followUp({ content: `Nem sikerült lekérni a felhasználói adataidat a szerverről.`, ephemeral: true });
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
            await interaction.followUp({ content: `Megjegyzés: az „Ismeretlen” szerep eltávolítása nem sikerült.`, ephemeral: true });
          }
        }
      } catch (e) {
        console.error('Role add failed:', e);
        await interaction.followUp({ content: `Nem sikerült hozzárendelni a szerepkört. Kérlek, vedd fel a kapcsolatot egy adminnal.`, ephemeral: true });
      }
    }
  }

  // Log csatorna (ha van) – marad angolul
  const logChannel = interaction.guild?.channels.cache.get(process.env.LOGS_CHANNEL_ID!) as TextChannel | undefined;
  if (logChannel?.isTextBased()) {
    logChannel.send(`:arrow_upper_right: **${interaction.user.tag}** (${interaction.user.id}, <@${interaction.user.id}>) has been linked to \`${email}\`.`);
  }

  // végső válasz
  return void interaction.editReply({
    embeds: successEmbed(`Remek, sikeres azonosítás! Menj a <#1401520437502021632> csatornára.`).embeds,
  });
};
