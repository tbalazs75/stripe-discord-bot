import express, { Request, Response } from "express";
import Stripe from "stripe";
import { Postgres, DiscordCustomer } from "./database";
import { client } from "."; // ugyanaz a Client példány, amit a bot használ
import { TextChannel } from "discord.js";

const router = express.Router();

// Only raw body for Stripe webhook
router.use(express.raw({ type: "application/json" }));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2022-11-15",
});

router.post("/", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed":
      console.log("✅ Subscription completed!");
      break;

    case "customer.subscription.deleted":
      console.log("❌ Subscription cancelled via Stripe.");

      try {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        // Keressük meg a Discord user-t az adatbázisban
        const discordCustomer = await Postgres.getRepository(DiscordCustomer).findOne({
          where: { email: subscription.metadata?.email },
        });

        if (discordCustomer) {
          const guild = client.guilds.cache.get(process.env.GUILD_ID!);
          if (guild) {
            const member = await guild.members.fetch(discordCustomer.discordUserId).catch(() => null);
            if (member) {
              await member.roles.remove(process.env.PAYING_ROLE_ID!).catch(() => {});
              if (process.env.LIFETIME_PAYING_ROLE_ID) {
                await member.roles.remove(process.env.LIFETIME_PAYING_ROLE_ID).catch(() => {});
              }
            }
          }

          await Postgres.getRepository(DiscordCustomer).update(discordCustomer.id, {
            hadActiveSubscription: false,
            firstReminderSentDayCount: null
          });

          const logChannel = guild?.channels.cache.get(process.env.LOGS_CHANNEL_ID!) as TextChannel;
          if (logChannel?.isTextBased()) {
            logChannel.send(`:arrow_lower_right: **${discordCustomer.discordUserId}** lost access (Stripe cancellation).`);
          }
        }
      } catch (err) {
        console.error("Error handling subscription cancellation:", err);
      }
      break;

    case "invoice.payment_succeeded":
      console.log("💰 Invoice payment succeeded.");
      break;

    default:
      console.log(`ℹ️ Unhandled event type: ${event.type}`);
  }

  res.status(200).send();
});

export default router;
