import { Router, raw, type Request } from "express";
import Stripe from "stripe";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../lib/auth";

const router = Router();

function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}
const appUrl = () => (process.env.APP_URL ?? "https://aheadoftheturn.com").replace(/\/$/, "");

/** Start a $2.99/mo Checkout session. */
router.post("/billing/checkout", requireAuth, async (req, res) => {
  const stripe = stripeClient();
  const price = process.env.STRIPE_PRICE_ID;
  if (!stripe || !price) { res.status(503).json({ error: "Billing isn't set up yet" }); return; }
  try {
    const user = req.user!;
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const c = await stripe.customers.create({ email: user.email, metadata: { userId: String(user.id) } });
      customerId = c.id;
      await db.update(usersTable).set({ stripeCustomerId: customerId }).where(eq(usersTable.id, user.id));
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${appUrl()}/account?checkout=success`,
      cancel_url: `${appUrl()}/account?checkout=cancelled`,
      allow_promotion_codes: true,
      metadata: { userId: String(user.id) },
    });
    res.json({ url: session.url });
  } catch (err) { req.log.error({ err }, "checkout failed"); res.status(500).json({ error: "Could not start checkout" }); }
});

/** Stripe Customer Portal: update card, cancel, invoices. */
router.post("/billing/portal", requireAuth, async (req, res) => {
  const stripe = stripeClient();
  if (!stripe || !req.user!.stripeCustomerId) { res.status(400).json({ error: "No billing account yet" }); return; }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user!.stripeCustomerId, return_url: `${appUrl()}/account`,
    });
    res.json({ url: session.url });
  } catch (err) { req.log.error({ err }, "portal failed"); res.status(500).json({ error: "Could not open billing portal" }); }
});

async function syncSubscription(stripe: Stripe, sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const item = sub.items.data[0];
  const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;
  // "canceled" with cancel_at_period_end keeps access until periodEnd (see hasActiveSubscription).
  const status = sub.cancel_at_period_end && sub.status === "active" ? "canceled" : sub.status;
  await db.update(usersTable)
    .set({ stripeSubscriptionId: sub.id, subscriptionStatus: status, currentPeriodEnd: periodEnd })
    .where(eq(usersTable.stripeCustomerId, customerId));
  void stripe;
}

/** Webhook. Mounted with a raw body parser; must be registered BEFORE express.json(). */
export const webhookHandler = [
  raw({ type: "application/json" }),
  async (req: Request, res: import("express").Response): Promise<void> => {
    const stripe = stripeClient();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) { res.status(503).end(); return; }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, req.headers["stripe-signature"] as string, secret);
    } catch (err) { req.log.warn({ err }, "bad webhook signature"); res.status(400).end(); return; }
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object;
          if (s.subscription) {
            const sub = await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
            await syncSubscription(stripe, sub);
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          await syncSubscription(stripe, event.data.object);
          break;
        default: break;
      }
      res.json({ received: true });
    } catch (err) { req.log.error({ err, type: event.type }, "webhook handling failed"); res.status(500).end(); }
  },
];

export default router;
