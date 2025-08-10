import express, { Request, Response } from "express";
import Stripe from "stripe";
import { Postgres, DiscordCustomer } from "../database";
import { Client, GuildMember } from "discord.js";
import { client } from "../client"; // <-- ugyanaz a Client példány, amit a bot használ

const router = express.Router();

// Csak ennél a route-nál kell raw body a Stripe-hoz
router.use(express.raw({ type: "application/json" }));

const STRIPE_KEY =
  process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || "";

const stripe = new Stripe(STRIPE_KEY, { apiVersion: "2022-11-15" });

const GUILD_ID = process.env.GUILD_ID!;
const PAYING_ROLE_ID = process.env.DISCORD_ROLE_ID || process.env.PAYING_ROLE_ID || "";
const UNKNOWN_ROLE_ID = process.env.UNKNOWN_ROLE_ID || "";

// helper: várj, míg a Discord kliens ready lesz
function waitClientReady(c: Client<true> | Client<boolean>) {
  if (c.isReady()) return Promise.resolve();
  return new Promise<void>((resolve) => c.once("ready", () => resolve()));
}

async function syncRoles(discordUserId: string, active: boolean) {
  await waitClientReady(client);

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) {
    console.warn("[webhook] Member not found in guild:", discordUserId);
    return;
  }

  try {
    if (active) {
      if (PAYING_ROLE_ID) await (member as GuildMember).roles.add(PAYING_ROLE_ID).catch(() => {});
      if (UNKNOWN_ROLE_ID && member.roles.cache.has(UNKNOWN_ROLE_ID)) {
        await (member as GuildMember).roles.remove(UNKNOWN_ROLE_ID).catch(() => {});
      }
    } else {
      if (PAYING_ROLE_ID && member.roles.cache.has(PAYING_ROLE_ID)) {
        await (member as GuildMember).roles.remove(PAYING_ROLE_ID).catch(() => {});
      }
      if (UNKNOWN_ROLE_ID) {
        await (member as GuildMember).roles.add(UNKNOWN_ROLE_ID).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[webhook] Role sync failed:", e);
  }
}

async function findDiscordUserByCustomerId(customerId: string) {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    const email = (customer as any)?.email as string | undefined;
    if (!email) return null;

    const repo = Postgres.getRepository(DiscordCustomer);
    const user = await repo.findOne({ where: { email } });
    return user; // { id, discordUserId, email, hadActiveSubscription, ... }
  } catch (e) {
    console.error("[webhook] findDiscordUserByCustomerId error:", e);
    return null;
  }
}

router.post("/", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string | undefined;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;
  let event: Stripe.Event;

  try {
    if (!sig) {
      return res.status(400).send("Missing stripe-signature header");
    }
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Mindig válaszoljunk gyorsan; a nehéz munka await-tel itt lefut,
  // de bármi hiba try/catch-ben marad – ne dőljön el a process.
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = (session.customer as string) || "";
        console.log("✅ Subscription completed!", customerId);

        if (customerId) {
          const user = await findDiscordUserByCustomerId(customerId);
          if (user) {
            // DB flag ON + rang vissza
            await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
            await syncRoles(user.discordUserId, true);
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
        const user = await findDiscordUserByCustomerId(customerId);
        if (!user) break;

        if (status === "active" || status === "trialing") {
          await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
          await syncRoles(user.discordUserId, true);
        } else if (status === "canceled" || status === "unpaid" || status === "incomplete_expired" || status === "past_due") {
          await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: false });
          await syncRoles(user.discordUserId, false);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = (sub.customer as string) || "";
        console.log("❌ Subscription cancelled.", customerId);

        if (customerId) {
          const user = await findDiscordUserByCustomerId(customerId);
          if (user) {
            await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: false });
            await syncRoles(user.discordUserId, false);
          }
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = (inv.customer as string) || "";
        console.log("💰 Invoice payment succeeded.", customerId);
        if (customerId) {
          const user = await findDiscordUserByCustomerId(customerId);
          if (user) {
            await Postgres.getRepository(DiscordCustomer).update(user.id, { hadActiveSubscription: true });
            await syncRoles(user.discordUserId, true);
          }
        }
        break;
      }

      default: {
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
      }
    }
  } catch (e) {
    console.error("[webhook] handler error:", e);
    // nem küldünk 5xx-et, ne retriggeljen végtelenül
  }

  // Mindig 200-zal zárjuk (Stripe különben újrapróbálja)
  res.status(200).send("ok");
});

export default router;
