import express from "express";
import Stripe from "stripe";

const app = express();
app.use(express.raw({ type: "application/json" }));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16",
});

app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"]!;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Eseménytípusok kezelése itt
  switch (event.type) {
    case "checkout.session.completed":
      console.log("✅ Subscription completed!");
      // TODO: ide jön a felhasználó mentése/adatbázis frissítése
      break;
    case "customer.subscription.deleted":
      console.log("❌ Subscription cancelled.");
      // TODO: ide jön az eltávolítás/frissítés
      break;
    default:
      console.log(`ℹ️ Unhandled event type: ${event.type}`);
  }

  res.status(200).send();
});

export default app;
