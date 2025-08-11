import express, { Request, Response } from "express";
import Stripe from "stripe";
import { Postgres, DiscordCustomer } from "./database";
import { client } from "./client";
import { TextChannel } from "discord.js";

const router = express.Router();

// Only raw body for Stripe webhookimport express, { Request, Response } from "express";
import Stripe from "stripe";
import { Postgres, DiscordCustomer } from "./database";
import { client } from "./client";
import { TextChannel } from "discord.js";

const router = express.Router();

// Only raw body for Stripe webhook
router.use(express.raw({ type: "application/json" }));

const stripe = new Stripe(
  (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY)!,
  { apiVersion: "2022-11-15" }
);

router.post("/", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string | undefined;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
  let event: Stripe.Event;

  try {
    if (!sig) return res.status(400).send("Missing stripe-signature header");
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const payingRoleId = process.env.DISCORD_ROLE_ID || process.env.PAYING_ROLE_ID;
  const lifetimeRoleId = process.env.LIFETIME_PAYING_ROLE_ID;
  const unknownRoleId = process.env.UNKNOWN_ROLE_ID;
  const guildId = process.env.GUILD_ID!;
  const logChannelId = process.env.LOGS_CHANNEL_ID;

  // -------------------------
  // Role szinkronizálás
  // -------------------------
  async function syncRoles(discordUserId: string, active: boolean) {
    if (!client.isReady()) await new Promise<void>((r) => client.once("ready", () => r()));
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) return;

    try {
      if (active) {
        // Aktív: fizetős (és opcionálisan lifetime) fel, Ismeretlen le
        if (payingRoleId) await member.roles.add(payingRoleId).catch(() => {});
        if (lifetimeRoleId) await member.roles.add(lifetimeRoleId).catch(() => {});
        if (unknownRoleId && member.roles.cache.has(unknownRoleId)) {
          await member.roles.remove(unknownRoleId).catch(() => {});
        }
      } else {
        // INAKTÍV: MINDEN szerep le (kivéve @everyone + KEEP), majd Ismeretlen vissza
        // ha vannak kivételek (pl. admin/mod), add ide az ID-kat:
        const KEEP_ROLE_IDS = new Set<string>([
          // pl.: process.env.ADMIN_ROLE_ID || ""
        ]);
        const everyoneId = guild.id;

        const rolesToRemove = member.roles.cache.filter((r) => {
          if (r.id === everyoneId) return false;
          if (KEEP_ROLE_IDS.has(r.id)) return false;
          return true;
        });

        await Promise.all(rolesToRemove.map((r) => member.roles.remove(r.id).catch(() => {})));

        if (unknownRoleId) {
          await member.roles.add(unknownRoleId).catch(() => {});
        }
      }
    } catch (e) {
      console.error("[webhook] role sync failed:", e);
    }

    if (logChannelId) {
      const ch = guild.channels.cache.get(logChannelId) as TextChannel | undefined;
      if (ch?.isTextBased()) {
        ch.send(
          active
            ? `:arrow_upper_right: Access restored for <@${discordUserId}>.`
            : `:arrow_lower_right: Access revoked for <@${discordUserId}> (all roles removed, unknown reapplied).`
        );
      }
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = (session.customer as string) || "";
        console.log("✅ Subscription completed!", customerId);

        if (customerId) {
          const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
          const email = customer.email || (session.customer_details?.email ?? undefined);
          if (email) {
            const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
            if (user) {
              await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
              await syncRoles(user.discordUserId, true);
            }
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const status = sub.status;
        const customerId = (sub.customer as string) || "";
        console.log("ℹ️ Subscription updated:", status, customerId);

        if (!customerId) break;

        const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        const email = customer.email;
        if (!email) break;

        const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
        if (!user) break;

        if (status === "active" || status === "trialing") {
          await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
          await syncRoles(user.discordUserId, true);
        } else if (
          status === "canceled" ||
          status === "unpaid" ||
          status === "incomplete_expired" ||
          status === "past_due"
        ) {
          await Postgres.getRepository(DiscordCustomer).update(user.id, {
            hadActiveSubscription: false,
            firstReminderSentDayCount: null,
          });
          await syncRoles(user.discordUserId, false);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = (sub.customer as string) || "";
        console.log("❌ Subscription cancelled via Stripe.", customerId);

        if (!customerId) break;

        const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        const email = customer.email || sub.metadata?.email;
        if (!email) break;

        const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
        if (!user) break;

        await Postgres.getRepository(DiscordCustomer).update(user.id, {
          hadActiveSubscription: false,
          firstReminderSentDayCount: null,
        });
        await syncRoles(user.discordUserId, false);
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = (inv.customer as string) || "";
        console.log("💰 Invoice payment succeeded.", customerId);

        if (!customerId) break;
        const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        const email = customer.email;
        if (!email) break;

        const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
        if (!user) break;

        await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
        await syncRoles(user.discordUserId, true);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }
  } catch (e) {
    console.error("[webhook] handler error:", e);
  }

  res.status(200).send("ok");
});

export default router;

router.use(express.raw({ type: "application/json" }));

const stripe = new Stripe(
  (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY)!,
  { apiVersion: "2022-11-15" }
);

router.post("/", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string | undefined;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
  let event: Stripe.Event;

  try {
    if (!sig) return res.status(400).send("Missing stripe-signature header");
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const payingRoleId = process.env.DISCORD_ROLE_ID || process.env.PAYING_ROLE_ID;
  const lifetimeRoleId = process.env.LIFETIME_PAYING_ROLE_ID;
  const unknownRoleId = process.env.UNKNOWN_ROLE_ID;
  const guildId = process.env.GUILD_ID!;
  const logChannelId = process.env.LOGS_CHANNEL_ID;

  async function syncRoles(discordUserId: string, active: boolean) {
    if (!client.isReady()) await new Promise<void>((r) => client.once("ready", () => r()));
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) return;

    try {
      if (active) {
        if (payingRoleId) await member.roles.add(payingRoleId).catch(() => {});
        if (unknownRoleId && member.roles.cache.has(unknownRoleId)) {
          await member.roles.remove(unknownRoleId).catch(() => {});
        }
      } else {
        if (payingRoleId && member.roles.cache.has(payingRoleId)) {
          await member.roles.remove(payingRoleId).catch(() => {});
        }
        if (lifetimeRoleId && member.roles.cache.has(lifetimeRoleId)) {
          await member.roles.remove(lifetimeRoleId).catch(() => {});
        }
        if (unknownRoleId) await member.roles.add(unknownRoleId).catch(() => {});
      }
    } catch (e) {
      console.error("[webhook] role sync failed:", e);
    }

    if (logChannelId) {
      const ch = guild.channels.cache.get(logChannelId) as TextChannel | undefined;
      if (ch?.isTextBased()) {
        ch.send(
          active
            ? `:arrow_upper_right: Access restored for <@${discordUserId}>.`
            : `:arrow_lower_right: Access revoked for <@${discordUserId}>.`
        );
      }
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = (session.customer as string) || "";
        console.log("✅ Subscription completed!", customerId);

        if (customerId) {
          // próbálunk e-mail alapján DB usert találni
          const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
          const email = customer.email || (session.customer_details?.email ?? undefined);
          if (email) {
            const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
            if (user) {
              await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
              await syncRoles(user.discordUserId, true);
            }
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const status = sub.status;
        const customerId = (sub.customer as string) || "";
        console.log("ℹ️ Subscription updated:", status, customerId);

        if (!customerId) break;

        const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        const email = customer.email;
        if (!email) break;

        const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
        if (!user) break;

        if (status === "active" || status === "trialing") {
          await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
          await syncRoles(user.discordUserId, true);
        } else if (
          status === "canceled" ||
          status === "unpaid" ||
          status === "incomplete_expired" ||
          status === "past_due"
        ) {
          await Postgres.getRepository(DiscordCustomer).update(user.id, {
            hadActiveSubscription: false,
            firstReminderSentDayCount: null,
          });
          await syncRoles(user.discordUserId, false);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = (sub.customer as string) || "";
        console.log("❌ Subscription cancelled via Stripe.", customerId);

        if (!customerId) break;

        const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        const email = customer.email || sub.metadata?.email;
        if (!email) break;

        const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
        if (!user) break;

        await Postgres.getRepository(DiscordCustomer).update(user.id, {
          hadActiveSubscription: false,
          firstReminderSentDayCount: null,
        });
        await syncRoles(user.discordUserId, false);
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = (inv.customer as string) || "";
        console.log("💰 Invoice payment succeeded.", customerId);

        if (!customerId) break;
        const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
        const email = customer.email;
        if (!email) break;

        const user = await Postgres.getRepository(DiscordCustomer).findOne({ where: { email } });
        if (!user) break;

        await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
        await syncRoles(user.discordUserId, true);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }
  } catch (e) {
    console.error("[webhook] handler error:", e);
  }

  res.status(200).send("ok");
});

export default router;
