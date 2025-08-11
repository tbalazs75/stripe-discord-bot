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
 * 3) MINDEN role le (@everyone kivétel + opcionális kivételek), „ismeretlen” fel (ha van)
 * 4) logol
 */
const makeMemberExpire = async (customer: DiscordCustomer, member: GuildMember | null, guild: Guild) => {
  await Postgres.getRepository(DiscordCustomer).update(customer.id, {
    hadActiveSubscription: false,
    firstReminderSentDayCount: null,
  });

  if (member) {
    const unknownRoleId = process.env.UNKNOWN_ROLE_ID;

    // ha vannak olyan role-ok, amiket SOHA ne vegyen le (pl. admin/mod), add ide:
    const KEEP_ROLE_IDS = new Set<string>([
      // pl.: process.env.ADMIN_ROLE_ID || "",
      // hagyd üresen, ha nincs kivétel
    ]);

    // @everyone role ID = a guild ID-ja
    const everyoneId = guild.id;

    // mindent leveszünk, kivéve @everyone + KEEP_ROLE_IDS (+ opcionálisan az unknown-t, amit majd visszaadunk)
    const rolesToRemove = member.roles.cache.filter((r) => {
      if (r.id === everyoneId) return false;
      if (KEEP_ROLE_IDS.has(r.id)) return false;
      return true;
    });

    try {
      // bulk remove (promise-okra szétbontva, hogy hibánál ne álljon meg)
      await Promise.all(rolesToRemove.map((r) => member.roles.remove(r.id).catch(() => {})));
      if (unknownRoleId) {
        await member.roles.add(unknownRoleId).catch(() => {});
      }
    } catch (e) {
      console.error("[daily-check] bulk role revoke failed:", e);
    }
  }

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

  const guildId = process.env.GUILD_ID!;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error("[Daily Check] Guild not found. Check GUILD_ID env.");
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

    const payingRoleId = process.env.DISCORD_ROLE_ID || process.env.PAYING_ROLE_ID;
    const lifetimeRoleId = process.env.LIFETIME_PAYING_ROLE_ID;
    const unknownRoleId = process.env.UNKNOWN_ROLE_ID;

    const member =
      (await guild.members.fetch(customer.discordUserId).catch(() => null)) ||
      guild.members.cache.get(customer.discordUserId) ||
      null;

    if (activeSubscriptions.length > 0 || hasLifetime) {
      console.log(`${customer.email} has active subscriptions${hasLifetime ? " (lifetime)" : ""}.`);

      if (!customer.hadActiveSubscription || customer.firstReminderSentDayCount !== null) {
        await Postgres.getRepository(DiscordCustomer).update(customer.id, {
          hadActiveSubscription: true,
          firstReminderSentDayCount: null,
        });
      }

      if (member) {
        try {
          if (payingRoleId) await member.roles.add(payingRoleId).catch(() => {});
          if (hasLifetime && lifetimeRoleId) await member.roles.add(lifetimeRoleId).catch(() => {});
          // ha van „ismeretlen” role és rajta van, vedd le
          if (unknownRoleId && member.roles.cache.has(unknownRoleId)) {
            await member.roles.remove(unknownRoleId).catch(() => {});
          }
        } catch (e) {
          console.error("[Daily Check] role add failed:", e);
        }
      }
      continue;
    }

    // nincs aktív: ha eddig sem volt aktív, nincs teendő
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
