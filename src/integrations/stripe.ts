import pQueue from 'p-queue';

const queue = new pQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });

/**
 * Gets the Stripe customer ID for a given user email
 */
export const resolveCustomerIdFromEmail = async (email: string) => {
  try {
    console.log('[Stripe lookup] Searching for email:', email);
    console.log('[Stripe lookup] Mode:', process.env.STRIPE_API_KEY?.startsWith('sk_live_') ? 'LIVE' : 'TEST');

    let res: any;

    if (email.includes('+')) {
      const endPart = email.split('+')[1];
      console.log('[Stripe lookup] Email contains "+", using endPart:', endPart);
      res = await queue.add(async () =>
        (await fetch(
          `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`email~'${endPart}'`)}`,
          { headers: { Authorization: `Bearer ${process.env.STRIPE_API_KEY}` } }
        )).json()
      );
    } else {
      console.log('[Stripe lookup] Using exact email search query');
      res = await queue.add(async () =>
        (await fetch(
          `https://api.stripe.com/v1/customers/search?query=${encodeURIComponent(`email:'${email}'`)}`,
          { headers: { Authorization: `Bearer ${process.env.STRIPE_API_KEY}` } }
        )).json()
      );
    }

    const data = Array.isArray(res?.data) ? res.data : [];
    console.log('[Stripe lookup] Raw API response count:', data.length);

    if (data.length === 0) {
      console.warn('[Stripe lookup] No customer found for this email.');
      return null;
    }

    const customer = data[0];
    console.log('[Stripe lookup] First customer ID:', customer.id);
    console.log('[Stripe lookup] First customer email:', customer.email);
    console.log('[Stripe lookup] Created at (unix):', customer.created);

    return customer.id;
  } catch (err) {
    console.error('[Stripe lookup] Error while searching customer:', err);
    return null; // soha ne dobjuk el a folyamatot
  }
};

/**
 * Gets all the Stripe subscriptions from a given customer ID
 */
export const findSubscriptionsFromCustomerId = async (oldCustomerId: string) => {
  const res = await queue.add(async () =>
    (await fetch(`https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(oldCustomerId)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_API_KEY}` },
    })).json()
  );
  return Array.isArray(res?.data) ? res.data : [];
};

/**
 * Filter the active subscriptions from a list of subscriptions
 */
export const findActiveSubscriptions = (subscriptions: any[]) => {
  return subscriptions.filter(
    (sub) =>
      sub.status === 'active' ||
      sub.status === 'trialing' ||
      (sub.cancel_at && sub.current_period_end > Date.now() / 1000)
  );
};

/**
 * Cancels a subscription
 */
export const cancelSubscription = async (subscriptionId: string) => {
  await queue.add(async () =>
    (await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.STRIPE_API_KEY}` },
    })).json()
  );
};

/**
 * Gets all the Stripe payments from a given customer ID
 */
export const getCustomerPayments = async (customerId: string) => {
  const res = await queue.add(async () =>
    (await fetch(`https://api.stripe.com/v1/payment_intents?customer=${encodeURIComponent(customerId)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_API_KEY}` },
    })).json()
  );
  return Array.isArray(res?.data) ? res.data : [];
};

/**
 * Gets the lifetime payment date from a list of payments
 */
export const getLifetimePaymentDate = (payments: any[]): null | number => {
  let lifetimeStartDate: number | null = null;
  for (const payment of payments || []) {
    for (const charge of payment.charges?.data || []) {
      if (process.env.LIFETIME_INVOICE_LABEL_KEYWORD && charge.description?.includes(process.env.LIFETIME_INVOICE_LABEL_KEYWORD)) {
        lifetimeStartDate = charge.created * 1000;
      }
    }
  }
  return lifetimeStartDate;
};
