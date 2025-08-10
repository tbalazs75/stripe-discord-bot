import pQueue from 'p-queue';

const queue = new pQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });

/**
 * Gets the Stripe customer ID for a given user email
 */
export const resolveCustomerIdFromEmail = async (email: string) => {
    console.log('[Stripe lookup] Searching for email:', email);
    console.log('[Stripe lookup] Mode:', process.env.STRIPE_API_KEY?.startsWith('sk_live_') ? 'LIVE' : 'TEST');

    let customerData;

    if (email.includes('+')) {
        const endPart = email.split('+')[1];
        console.log('[Stripe lookup] Email contains "+", using search query with endPart:', endPart);

        const customers = await queue.add(async () => await (await fetch(`https://api.stripe.com/v1/customers/search?query=email~'${endPart}'`, {
            headers: {
                Authorization: `Bearer ${process.env.STRIPE_API_KEY}`
            }
        })).json());

        console.log('[Stripe lookup] Raw API response count:', customers.data?.length || 0);
        const matchingCustomers = customers.data.filter((c: any) => c.email === email);
        console.log('[Stripe lookup] Exact match count:', matchingCustomers.length);

        customerData = matchingCustomers[0];
    } else {
        console.log('[Stripe lookup] Using exact email search query');
        const customers = await queue.add(async () => await (await fetch(`https://api.stripe.com/v1/customers/search?query=email:'${email}'`, {
            headers: {
                Authorization: `Bearer ${process.env.STRIPE_API_KEY}`
            }
        })).json());

        console.log('[Stripe lookup] Raw API response count:', customers.data?.length || 0);
        customerData = customers.data[0];
    }

    if (!customerData) {
        console.warn('[Stripe lookup] No customer found for this email.');
        return null;
    }

    console.log('[Stripe lookup] First customer ID:', customerData.id);
    console.log('[Stripe lookup] First customer email:', customerData.email);
    console.log('[Stripe lookup] Created at (unix):', customerData.created);

    return customerData.id;
}

/**
 * Gets all the Stripe subscriptions from a given customer ID
 */
export const findSubscriptionsFromCustomerId = async (oldCustomerId: string) => {
    const subscriptions = await queue.add(async () => await (await fetch(`https://api.stripe.com/v1/subscriptions?customer=${oldCustomerId}`, {
        headers: {
            Authorization: `Bearer ${process.env.STRIPE_API_KEY}`
        }
    })).json());
    return subscriptions.data || [];
}

/**
 * Filter the active subscriptions from a list of subscriptions
 */
export const findActiveSubscriptions = (subscriptions: any[]) => {
    return subscriptions.filter(sub => sub.status === 'active' || sub.status === 'trialing' || (sub.cancel_at && sub.current_period_end > Date.now() / 1000));
}

/**
 * Cancels a subscription
 */
export const cancelSubscription = async (subscriptionId: string) => {
    await queue.add(async () => await (await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: {
            Authorization: `Bearer ${process.env.STRIPE_API_KEY}`
        }
    })).json());
}

/**
 * Gets all the Stripe payments from a given customer ID
 */
export const getCustomerPayments = async (customerId: string) => {
    const invoices = await queue.add(async () => await (await fetch(`https://api.stripe.com/v1/payment_intents?customer=${customerId}`, {
        headers: {
            Authorization: `Bearer ${process.env.STRIPE_API_KEY}`
        }
    })).json());
    return invoices?.data || [];
}

/**
 * Gets the lifetime payment date from a list of payments
 */
export const getLifetimePaymentDate = (payments: any[]): null | number => {
    let lifetimeStartDate = null;
    for (const payment of (payments || [])) {
        for (const charge of (payment.charges?.data || [])) {
            if (charge.description.includes(process.env.LIFETIME_INVOICE_LABEL_KEYWORD)) {
                lifetimeStartDate = charge.created * 1000;
            }
        }
    }
    return lifetimeStartDate;
}
