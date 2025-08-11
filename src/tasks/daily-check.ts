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

  // ⬇⬇⬇ kicsi robust map
