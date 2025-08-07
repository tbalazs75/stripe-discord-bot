import express, { Request, Response } from "express";
import Stripe from "stripe";

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
      // TODO: save to database
      break;

    case "customer.subscription.deleted":
      console.log("❌ Subscription cancelled.");
      // TODO: deactivate user/subscription
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
