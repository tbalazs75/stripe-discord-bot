import express, { Request, Response } from "express";
import Stripe from "stripe";

const router = express.Router();

// 1. A Stripe webhookokhoz a nyers body kell!
router.use(express.raw({ type: "application/json" }));

// 2. Stripe inicializálása
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2022-11-15",
});

router.post("/", async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: Stripe.Event;

  try {
    // 3. A nyers body miatt kell a `express.raw()` middleware fent
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 4. Különféle Stripe események kezelése
  switch (event.type) {
    case "checkout.session.completed":
      console.log("✅ Subscription completed!");
      // TODO: mentés adatbázisba
      break;

    case "customer.subscription.deleted":
      console.log("❌ Subscription cancelled.");
      // TODO: inaktiválás
      break;

    default:
      console.log(`ℹ️ Unhandled event type: ${event.type}`);
  }

  res.status(200).send(); // Stripe-nek visszajelezzük, hogy sikeres volt a feldolgozás
});

export default router;
