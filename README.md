# GemStocks TCG shop

Storefront, Stripe checkout and an admin panel, running on Cloudflare Workers (free tier).

- `public/index.html`: the shop buyers see
- `public/admin/index.html`: the admin panel at `/admin` (add cards, orders, postage)
- `src/worker.js`: the API (products, postage, Stripe checkout, orders, photo uploads)
- `schema.sql`, `seed.sql`: database tables and the starting 21 cards

## Run it locally

```bash
npm install
```

```bash
npm run db:local
```

```bash
npm run dev
```

Shop: http://localhost:8787 · Admin: http://localhost:8787/admin

The admin password is `ADMIN_PASSWORD` in `.dev.vars` (copy `.dev.vars.example` if it is missing).
With `DEV_FAKE_PAY=1` and no Stripe key, checkout pretends the buyer paid so the flow can be tested.

## Go live

Needs a Cloudflare account and a Stripe account, both in the shop owner's name.

1. Log in: `npx wrangler login`
2. Create the database: `npx wrangler d1 create gemstocks`, then paste the `database_id` it prints into `wrangler.toml`.
3. Create photo storage: `npx wrangler r2 bucket create gemstocks-images` (R2 must be enabled in the Cloudflare dashboard first).
4. Load the tables and starting cards: `npm run db:remote`
5. Set the secrets, one at a time:
   - `npx wrangler secret put ADMIN_PASSWORD` (long and unique)
   - `npx wrangler secret put SESSION_SECRET` (any long random string)
   - `npx wrangler secret put STRIPE_SECRET_KEY` (start with the `sk_test_...` key)
6. Deploy: `npm run deploy`. It prints the live address.
7. In Stripe, add a webhook pointing at `https://YOUR-ADDRESS/api/stripe/webhook` for the events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   and `checkout.session.expired`. Then `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with the `whsec_...` value.
8. Test a purchase with Stripe's test card, then swap `STRIPE_SECRET_KEY` and the webhook for the live ones.

Do not set `DEV_FAKE_PAY` in production. It is ignored anyway once a Stripe key is set.

## How stock works

When a buyer starts checkout, their cards are held for about 30 minutes. If they pay, the order appears under
Orders. If they back out or the time runs out, the cards go back on sale. Cards sold on eBay or Facebook still
need "Mark sold" pressed in the admin.
