const express = require('express');
const router  = express.Router();

// ── Stripe payment route
// Requires env vars: STRIPE_SECRET_KEY, APP_URL
// POST /api/create-checkout-session
router.post('/create-checkout-session', async (req, res) => {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return res.status(500).json({ error: 'Stripe is not configured (missing STRIPE_SECRET_KEY).' });
    }

    const stripe = require('stripe')(stripeKey);
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Search Unlock – 2 keyword sessions',
              description: 'Unlimited searches until dropshipping stores are found for 2 keywords.',
            },
            unit_amount: 2000, // $20.00
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: appUrl + '/?payment=success',
      cancel_url:  appUrl + '/?payment=cancel',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] Error creating checkout session:', err.message);
    res.status(500).json({ error: err.message || 'Stripe error' });
  }
});

module.exports = router;

