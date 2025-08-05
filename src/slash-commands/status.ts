import { ChatInputCommandInteraction, ApplicationCommandOptionType, EmbedBuilder } from "discord.js";
import { Postgres, DiscordCustomer } from "../database";
import { errorEmbed } from "../util";
import {
  findActiveSubscriptions,
  findSubscriptionsFromCustomerId,
  getCustomerPayments,
  getLifetimePaymentDate,
  resolveCustomerIdFromEmail,
} from "../integrations/stripe";

export const commands = [
  {
    name: "status",
    description: "Get your exclusive access status!",
    options: [
      {
        name: "user",
        description: "The user you want to get the status of",
        type: ApplicationCommandOptionType.User,
        required: false,
      },
    ],
  },
];

export const run = async (interaction: ChatInputCommandInteraction) => {
  if (interaction.channelId !== process.env.STATUS_CHANNEL_ID) {
    return void interaction.reply({
      content: `This command can only be used in <#${process.env.STATUS_CHANNEL_ID}>.`,
      ephemeral: true,
    });
  }

  const user = interaction.options.getUser("user") || interaction.user;

  const discordCustomer = await Postgres.getRepository(DiscordCustomer).findOne({
    where: { discordUserId: user.id },
  });

  if (!discordCustomer) {
    return void interaction.reply({
      ephemeral: true,
      embeds: errorEmbed(`There is no email linked to your account!`).embeds,
    });
  }

  const customerId = await resolveCustomerIdFromEmail(discordCustomer.email);
  const subscriptions = await findSubscriptionsFromCustomerId(customerId);
  const payments = await getCustomerPayments(customerId);
  const lifetimePaymentDate = await getLifetimePaymentDate(payments);

  const subscriptionLines =
    subscriptions.length > 0
      ? subscriptions
          .map((subscription: any) => {
            let name = subscription.items.data[0]?.plan?.id || "Unnamed Plan";
            name = name
              .replace(/_/g, " ")
              .replace(/^\w|\s\w/g, (l: string) => l.toUpperCase());

            if (name.includes("Membership")) {
              name = name.slice(0, name.indexOf("Membership") + "Membership".length);
            }

            const statusText =
              subscription.status === "active"
                ? "✅ Active"
                : subscription.cancel_at && subscription.current_period_end > Date.now() / 1000
                ? "❌ Cancelled (not expired yet)"
                : "❌ Cancelled";

            return `${name} (${statusText})`;
          })
          .join("\n")
      : "There is no subscription for this account.";

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${user.tag}'s access`, iconURL: user.displayAvatarURL() })
    .setDescription(`Here are all the ${process.env.SUBSCRIPTION_NAME} subscriptions 👑`)
    .setColor(process.env.EMBED_COLOR || "#FFD700")
    .addFields([{ name: "Subscriptions", value: subscriptionLines }]);

  return void interaction.reply({
    ephemeral: true,
    embeds: [embed],
  });
};
