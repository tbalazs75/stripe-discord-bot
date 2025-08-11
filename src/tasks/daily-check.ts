import { EmbedBuilder, Guild, GuildMember, TextChannel } from "discord.js";
import { client } from "../client";
import { DiscordCustomer, Postgres } from "../database";
import {
  findActiveSubscriptions,
  findSubscriptionsFromCustomerId,
  getCustomerPayments,
  getLifetimePaymentDate,
  resolveCustomerIdFromEmail,
} from "../integrations/stripe";

// ⬇⬇⬇ ÚJ: egységes role-kezelő
import { applyMembershipState } from "../services/roleManager"; // <-- útvonalat igazítsd

export const crons = ["0 0 1 * * *"]; // minden nap 01:00

// Biztonságos, numerikus embed-szín
const EMBED_COLOR_NUM = (() => {
  const hex = process.env.EMBED_COLOR; // pl. "#FFD700" vagy "FFD700"
  if (hex && /^#?[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex.replace("#", ""), 16);
  return 0xffd700;
})();

const getExpiredEmbed = (daysLeft: 0 | 1 | 2): EmbedBuilder => {
  const title = daysLeft > 0 ? "Your subscription is about to expire" : "Your subscription is expired";
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(EMBED_COLOR_NUM)
    .setDescription(
      `Please visit ${process.env.STRIPE_PAYMENT_LINK} to keep your exclusive access! ${
        daysLeft > 0 ? `Your subscription expires within ${daysLeft * 24} hours.` : ""
      }`
    );
  if (process.env.STRIPE_PAYMENT_LINK) embed.setURL(process.env.STRIPE_PAYMENT_LINK);
  return embed;
};

/**
 * 1) DB-ben inaktivál
 * 2) emlékeztető számlálót nulláz
 * 3) ROLE-OK: egységes roleManager-rel teljes wipe → Unknown vissza
 * 4) logol
 */
const makeMemberExpire = async (customer: DiscordCustomer, member: GuildMember | null, guild: Guild) => {
  await Postgres.getRepository(DiscordCustomer).update(customer.id, {
    hadActiveSubscription: false,
    firstReminderSentDayCount: null,
  });

  // ⬇⬇⬇ EDDIG: kézi role eltávolítás volt. HELYETTE: egységes végállapot beállítás.
  await applyMembershipState(client, customer.discordUserId, "inactive", {
    reason: "daily-check: expire",
  });

  const logChannelId = process.env.LOGS_CHANNEL_ID;
  const logChannel = logChannelId ? (guild.channels.cache.get(logChannelId) as TextChannel | undefined) : undefined;
  if (logChannel?.isTextBased()) {
    logChannel.send(
      `:arrow_lower_right: **${member?.user?.tag || "Unknown#0000"}** (${customer.discordUserId}, <@${
        customer.discordUserId
      }>) lost all roles (except kept ones). Unknown reapplied. Email: \`${customer.email}\`.`
    );
  }
};

export const run = async () => {
  // várd meg, míg a bot belogol
  if (!client.isReady()) {
    await new Promise<void>((resolve) => client.once("ready", () => resolve()));
  }

  // ⬇⬇⬇ kicsi robust mapping
  const guildId = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID!;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error("[Daily Check] Guild not found. Check DISCORD_GUILD_ID/GUILD_ID env.");
    return;
  }
  await guild.members.fetch(); // cache feltöltés

  const customers = await Postgres.getRepository(DiscordCustomer).find({});

  for (const customer of customers) {
    if (!customer.email || customer.adminAccessEnabled) continue;

    console.log(`[Daily Check] Checking ${customer.email}`);
    const customerId = await resolveCustomerIdFromEmail(customer.email);
    if (!customerId) {
      console.log(`[Daily Check] Could not find customer id for ${customer.email}`);
      continue;
    }

    const subscriptions = await findSubscriptionsFromCustomerId(customerId);
    const activeSubscriptions = findActiveSubscriptions(subscriptions) || [];

    const userPayments = await getCustomerPayments(customerId);
    const hasLifetime = !!(await getLifetimePaymentDate(userPayments));

    const member =
      (await guild.members.fetch(customer.discordUserId).catch(() => null)) ||
      guild.members.cache.get(customer.discordUserId) ||
      null;

    // ====== AKTÍV / LIFETIME ======
    if (activeSubscriptions.length > 0 || hasLifetime) {
      console.log(`${customer.email} has active subscriptions${hasLifetime ? " (lifetime)" : ""}.`);

      if (!customer.hadActiveSubscription || customer.firstReminderSentDayCount !== null) {
        await Postgres.getRepository(DiscordCustomer).update(customer.id, {
          hadActiveSubscription: true,
          firstReminderSentDayCount: null,
        });
      }

      // ⬇⬇⬇ EDDIG: kézzel add/remove. HELYETTE: roleManager-rel végállapot.
      await applyMembershipState(client, customer.discordUserId, "active", {
        reason: "daily-check: active",
        assignLifetime: hasLifetime, // ha life-time jogosultsága van, maradjon is rajta
      });

      continue;
    }

    // ====== NEM AKTÍV ======
    // nincs aktív: ha eddig sem volt aktív, nincs teendő (de ha Unknown nincs rajta, roleManager majd beállítja, ha hívnánk)
    if (!customer.hadActiveSubscription) continue;

    // ha NEM 'unpaid' és lejárt → azonnali értesítés + teljes visszavonás
    if (!subscriptions.some((sub: any) => sub.status === "unpaid")) {
      const m =
        (await guild.members.fetch(customer.discordUserId).catch(() => null)) ||
        guild.members.cache.get(customer.discordUserId) ||
        null;

      console.log(`[Daily Check] Unpaid ${customer.email}`);
      if (m) m.send({ embeds: [getExpiredEmbed(0)] }).catch(() => {});
      await makeMemberExpire(customer, m, guild);
      continue;
    }

    if (customer.firstReminderSentDayCount === null) {
      console.log(`[Daily Check] Sending first reminder to ${customer.email}`);
      if (member) member.send({ embeds: [getExpiredEmbed(2)] }).catch(() => {});
      await Postgres.getRepository(DiscordCustomer).update(customer.id, { firstReminderSentDayCount: 2 });
      continue;
    }

    if (customer.firstReminderSentDayCount === 2) {
      console.log(`[Daily Check] Sending second reminder to ${customer.email}`);
      if (member) member.send({ embeds: [getExpiredEmbed(1)] }).catch(() => {});
      await Postgres.getRepository(DiscordCustomer).update(customer.id, { firstReminderSentDayCount: 1 });
      continue;
    }

    if (customer.firstReminderSentDayCount === 1) {
      console.log(`[Daily Check] Sending third reminder to ${customer.email}`);
      const m =
        (await guild.members.fetch(customer.discordUserId).catch(() => null)) ||
        guild.members.cache.get(customer.discordUserId) ||
        null;
      if (m) m.send({ embeds: [getExpiredEmbed(0)] }).catch(() => {});
      await makeMemberExpire(customer, m, guild);
      continue;
    }
  }
};
