import express from "express";
import Stripe from "stripe";

const router = express.Router();
router.use(express.raw({ type: "application/json" }));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2022-11-15",
});

router.post("/", async (req: express.Request, res: express.Response) => {
  const sig = req.headers["stripe-signature"]!;
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
      // TODO: mentés adatbázisba
      break;
    case "customer.subscription.deleted":
      console.log("❌ Subscription cancelled.");
      // TODO: inaktiválás
      break;
    default:
      console.log(`ℹ️ Unhandled event type: ${event.type}`);
  }

  res.status(200).send();
});

export default router;
