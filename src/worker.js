// GemStocks TCG shop API: products, cart quotes, Stripe checkout, orders and the admin panel backend.
// Runs on Cloudflare Workers with D1 (database) and R2 (card photos).

const enc = new TextEncoder();
const CATEGORIES = ['pokemon', 'onepiece', 'lorcana', 'graded', 'singles', 'sealed', 'accessories'];
const DEFAULT_POSTAGE = { letter: 500, parcel: 1200, express_extra: 500, signature_threshold: 30000, signature_fee: 500 };
const RESERVE_SECONDS = 31 * 60;      // how long a card is held while a buyer is on the Stripe page
const STALE_SECONDS = 35 * 60;        // pending orders older than this are checked and released
const SESSION_DAYS = 30;

class HttpError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }
const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const now = () => Math.floor(Date.now() / 1000);
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const uid = (n = 12) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => ALPHA[b % ALPHA.length]).join('');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      return (await route(req, env, url)) ?? env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.data || {}) }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  }
};

async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  if (m === 'GET' && p.startsWith('/img/')) return image(env, p.slice(5));
  if (!p.startsWith('/api/')) return null;

  // ---- public ----
  if (m === 'GET' && p === '/api/products') {
    const { results } = await env.DB.prepare("SELECT * FROM products WHERE status='active' AND qty>0 ORDER BY created_at DESC").all();
    return json({ products: results.map(publicProduct) });
  }
  if (m === 'POST' && p === '/api/quote') return json(await quote(env, cleanItems(await body(req))));
  if (m === 'POST' && p === '/api/checkout') return checkout(req, env, url);
  if (m === 'POST' && p === '/api/checkout/cancel') return cancelByToken(req, env);
  if (m === 'GET' && p === '/api/order') return orderStatus(env, url);
  if (m === 'POST' && p === '/api/stripe/webhook') return webhook(req, env);
  if (m === 'GET' && p === '/api/dev/pay') return devPay(env, url);

  // ---- admin ----
  if (p === '/api/admin/login' && m === 'POST') return login(req, env, url);
  if (p === '/api/admin/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': 'gs_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
  if (p.startsWith('/api/admin/')) {
    await requireAdmin(req, env);
    if (m !== 'GET' && req.headers.get('x-gs') !== '1') throw new HttpError(403, 'Bad request');
    const [, , , res, id] = p.split('/');
    if (res === 'me') return json({ ok: true, stripe: !!env.STRIPE_SECRET_KEY, fakePay: fakePay(env) });
    if (res === 'products') {
      if (m === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
        return json({ products: results.map(parseProduct) });
      }
      if (m === 'POST' && !id) return saveProduct(env, null, await body(req));
      if (m === 'PUT' && id) return saveProduct(env, id, await body(req));
      if (m === 'DELETE' && id) return deleteProduct(env, id);
    }
    if (res === 'upload' && m === 'POST') return upload(req, env);
    if (res === 'orders') {
      if (m === 'GET') {
        await reconcileStale(env);
        const { results } = await env.DB.prepare("SELECT * FROM orders WHERE status!='cancelled' ORDER BY created_at DESC LIMIT 200").all();
        return json({ orders: results.map(o => ({ ...o, cancel_token: undefined, items: JSON.parse(o.items), address: o.address ? JSON.parse(o.address) : null })) });
      }
      if (m === 'PUT' && id) return updateOrder(env, id, await body(req));
    }
    if (res === 'postage') {
      if (m === 'GET') return json({ postage: await getPostage(env) });
      if (m === 'PUT') return savePostage(env, await body(req));
    }
  }
  throw new HttpError(404, 'Not found');
}

/* ------------------------------ helpers ------------------------------ */

async function body(req) {
  const text = await req.text();
  if (text.length > 100000) throw new HttpError(413, 'Too large');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid request'); }
}
const parseProduct = r => ({ ...r, categories: safeArr(r.categories), images: safeArr(r.images) });
const publicProduct = r => { const p = parseProduct(r); return { id: p.id, title: p.title, description: p.description, price_cents: p.price_cents, qty: p.qty, categories: p.categories, condition: p.condition, images: p.images }; };
function safeArr(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }

async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const fakePay = env => env.DEV_FAKE_PAY === '1' && !env.STRIPE_SECRET_KEY;

function flat(o, pre, out = []) {
  for (const [k, v] of Object.entries(o)) {
    const key = pre ? `${pre}[${k}]` : k;
    if (v && typeof v === 'object') flat(v, key, out);
    else if (v !== undefined && v !== null) out.push([key, String(v)]);
  }
  return out;
}
async function stripe(env, method, path, params) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method,
    headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: params ? new URLSearchParams(flat(params)).toString() : undefined
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Stripe: ' + (d.error?.message || r.status));
  return d;
}

/* ------------------------------ images ------------------------------ */

async function image(env, key) {
  if (!/^[a-z0-9]{20}\.(jpg|png|webp)$/.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' } });
}
async function upload(req, env) {
  const type = (req.headers.get('content-type') || '').split(';')[0];
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
  if (!ext) throw new HttpError(400, 'Photos must be JPEG, PNG or WebP');
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 6 * 1024 * 1024) throw new HttpError(400, 'Photo is too large (6 MB max)');
  const key = `${uid(20)}.${ext}`;
  await env.IMAGES.put(key, buf, { httpMetadata: { contentType: type } });
  return json({ url: '/img/' + key });
}

/* ------------------------------ postage ------------------------------ */

async function getPostage(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='postage'").first();
  let saved = {}; try { saved = row ? JSON.parse(row.value) : {}; } catch {}
  return { ...DEFAULT_POSTAGE, ...saved };
}
async function savePostage(env, b) {
  const out = {};
  for (const k of Object.keys(DEFAULT_POSTAGE)) {
    const v = Math.round(Number(b[k]));
    if (!Number.isFinite(v) || v < 0 || v > 10000000) throw new HttpError(400, 'Check the postage amounts');
    out[k] = v;
  }
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('postage',?1) ON CONFLICT(key) DO UPDATE SET value=?1").bind(JSON.stringify(out)).run();
  return json({ postage: out });
}

function cleanItems(b) {
  const list = Array.isArray(b.items) ? b.items : [];
  if (!list.length || list.length > 30) throw new HttpError(400, 'Your cart is empty');
  const seen = new Map();
  for (const it of list) {
    const id = String(it.id || ''), qty = Math.floor(Number(it.qty));
    if (!/^[a-z0-9-]{1,40}$/i.test(id) || !(qty >= 1 && qty <= 50)) throw new HttpError(400, 'Invalid cart');
    seen.set(id, (seen.get(id) || 0) + qty);
  }
  return [...seen].map(([id, qty]) => ({ id, qty }));
}

// Works out cart lines, subtotal and postage options from what is actually in stock.
async function quote(env, items) {
  const ph = items.map((_, i) => '?' + (i + 1)).join(',');
  const { results } = await env.DB.prepare(`SELECT * FROM products WHERE id IN (${ph})`).bind(...items.map(i => i.id)).all();
  const byId = Object.fromEntries(results.map(r => [r.id, parseProduct(r)]));
  const unavailable = items.filter(i => { const p = byId[i.id]; return !p || p.status !== 'active' || p.qty < i.qty; }).map(i => i.id);
  if (unavailable.length) throw new HttpError(409, 'Sorry, something in your cart has just sold.', { unavailable });
  const lines = items.map(i => { const p = byId[i.id]; return { id: p.id, title: p.title, qty: i.qty, price_cents: p.price_cents, image: p.images[0] || '', ship_class: p.ship_class }; });
  const subtotal = lines.reduce((s, l) => s + l.price_cents * l.qty, 0);
  const pg = await getPostage(env);
  const letter = lines.every(l => l.ship_class === 'letter');
  const sig = subtotal >= pg.signature_threshold ? pg.signature_fee : 0;
  const base = (letter ? pg.letter : pg.parcel) + sig;
  const kind = letter ? 'letter' : 'parcel';
  const options = [
    { id: 'standard', label: `Tracked ${kind}${sig ? ' with signature' : ''}`, cents: base },
    { id: 'express', label: `Express ${kind}${sig ? ' with signature' : ''}`, cents: base + pg.express_extra }
  ];
  return { lines, subtotal, options };
}

/* ------------------------------ checkout ------------------------------ */

async function restoreStock(env, items) {
  for (const i of items) await env.DB.prepare('UPDATE products SET qty=qty+?1, updated_at=?3 WHERE id=?2').bind(i.qty, i.id, now()).run();
}
async function cancelOrder(env, order) {
  const r = await env.DB.prepare("UPDATE orders SET status='cancelled' WHERE id=?1 AND status='pending'").bind(order.id).run();
  if (r.meta.changes) await restoreStock(env, JSON.parse(order.items));
}
async function finalizePaid(env, orderId, s) {
  const ship = s.collected_information?.shipping_details || s.shipping_details || null;
  const cd = s.customer_details || {};
  await env.DB.prepare("UPDATE orders SET status='paid', email=?2, name=?3, phone=?4, address=?5, paid_at=?6 WHERE id=?1 AND status='pending'")
    .bind(orderId, cd.email || null, ship?.name || cd.name || null, cd.phone || null, JSON.stringify(ship?.address || cd.address || null), now()).run();
}
// Looks at old unpaid orders: confirms with Stripe whether they were paid, otherwise puts the cards back on sale.
async function reconcileStale(env) {
  const { results } = await env.DB.prepare("SELECT * FROM orders WHERE status='pending' AND created_at<?1 LIMIT 5").bind(now() - STALE_SECONDS).all();
  for (const o of results) {
    try {
      if (env.STRIPE_SECRET_KEY && o.stripe_session && o.stripe_session !== 'dev') {
        const s = await stripe(env, 'GET', '/checkout/sessions/' + o.stripe_session);
        if (s.payment_status === 'paid') { await finalizePaid(env, o.id, s); continue; }
        if (s.status === 'open') continue;
      }
      await cancelOrder(env, o);
    } catch (e) { console.error('reconcile', o.id, e); }
  }
}

async function checkout(req, env, url) {
  const b = await body(req);
  const items = cleanItems(b);
  await reconcileStale(env);
  const q = await quote(env, items);
  const opt = q.options.find(o => o.id === b.shipping) || q.options[0];
  if (!env.STRIPE_SECRET_KEY && !fakePay(env)) throw new HttpError(503, 'Online payments are not switched on yet. Please message us to order.');

  // Hold the stock so two buyers can't pay for the same card.
  const held = [];
  for (const i of items) {
    const r = await env.DB.prepare("UPDATE products SET qty=qty-?1, updated_at=?3 WHERE id=?2 AND status='active' AND qty>=?1").bind(i.qty, i.id, now()).run();
    if (!r.meta.changes) { await restoreStock(env, held); throw new HttpError(409, 'Sorry, something in your cart has just sold.', { unavailable: [i.id] }); }
    held.push(i);
  }
  const id = 'GS-' + uid(8).toUpperCase(), token = uid(24);
  const lines = q.lines.map(l => ({ id: l.id, title: l.title, qty: l.qty, price_cents: l.price_cents, image: l.image }));
  await env.DB.prepare('INSERT INTO orders (id,status,items,subtotal_cents,shipping_cents,shipping_label,total_cents,cancel_token,created_at) VALUES (?1,\'pending\',?2,?3,?4,?5,?6,?7,?8)')
    .bind(id, JSON.stringify(lines), q.subtotal, opt.cents, opt.label, q.subtotal + opt.cents, token, now()).run();

  if (fakePay(env)) {
    await env.DB.prepare("UPDATE orders SET stripe_session='dev' WHERE id=?1").bind(id).run();
    return json({ url: `/api/dev/pay?order=${id}` });
  }
  try {
    const abs = u => u.startsWith('https://') ? u : (u.startsWith('/img/') && url.protocol === 'https:' ? url.origin + u : null);
    const s = await stripe(env, 'POST', '/checkout/sessions', {
      mode: 'payment',
      success_url: `${url.origin}/?paid=${id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${url.origin}/?cancelled=${token}`,
      client_reference_id: id,
      metadata: { order_id: id },
      expires_at: now() + RESERVE_SECONDS,
      shipping_address_collection: { allowed_countries: ['AU'] },
      phone_number_collection: { enabled: 'true' },
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: opt.label, fixed_amount: { amount: opt.cents, currency: 'aud' } } }],
      line_items: lines.map(l => {
        const img = l.image && abs(l.image);
        return { quantity: l.qty, price_data: { currency: 'aud', unit_amount: l.price_cents, product_data: { name: l.title.slice(0, 250), ...(img ? { images: [img] } : {}) } } };
      })
    });
    await env.DB.prepare('UPDATE orders SET stripe_session=?2 WHERE id=?1').bind(id, s.id).run();
    return json({ url: s.url });
  } catch (e) {
    console.error(e);
    await cancelOrder(env, { id, items: JSON.stringify(lines) });
    throw new HttpError(502, 'Checkout could not start. Please try again.');
  }
}

// Buyer pressed "back" on the Stripe page: release the held cards straight away.
async function cancelByToken(req, env) {
  const { token } = await body(req);
  if (typeof token !== 'string' || token.length !== 24) throw new HttpError(400, 'Invalid request');
  const o = await env.DB.prepare("SELECT * FROM orders WHERE cancel_token=?1 AND status='pending'").bind(token).first();
  if (!o) return json({ ok: true });
  if (env.STRIPE_SECRET_KEY && o.stripe_session && o.stripe_session !== 'dev') {
    const s = await stripe(env, 'GET', '/checkout/sessions/' + o.stripe_session);
    if (s.payment_status === 'paid') { await finalizePaid(env, o.id, s); return json({ ok: true }); }
    if (s.status === 'open') await stripe(env, 'POST', `/checkout/sessions/${o.stripe_session}/expire`, {}).catch(() => {});
  }
  await cancelOrder(env, o);
  return json({ ok: true });
}

// Called by the thank-you screen. Confirms payment with Stripe in case the webhook has not arrived yet.
async function orderStatus(env, url) {
  const id = url.searchParams.get('id') || '', sid = url.searchParams.get('session_id') || '';
  let o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first();
  if (!o || !sid || o.stripe_session !== sid) throw new HttpError(404, 'Order not found');
  if (o.status === 'pending' && env.STRIPE_SECRET_KEY && sid !== 'dev') {
    const s = await stripe(env, 'GET', '/checkout/sessions/' + sid);
    if (s.payment_status === 'paid') { await finalizePaid(env, o.id, s); o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first(); }
  }
  return json({ id: o.id, status: o.status, first_name: (o.name || '').split(' ')[0], total_cents: o.total_cents });
}

async function webhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Webhook not configured');
  const raw = await req.text();
  const parts = Object.fromEntries((req.headers.get('stripe-signature') || '').split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1 || Math.abs(now() - Number(parts.t)) > 300) throw new HttpError(400, 'Bad signature');
  if (!safeEq(await hmac(env.STRIPE_WEBHOOK_SECRET, `${parts.t}.${raw}`), parts.v1)) throw new HttpError(400, 'Bad signature');
  const ev = JSON.parse(raw), s = ev.data?.object || {};
  const id = s.metadata?.order_id;
  if (id) {
    if ((ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') && s.payment_status === 'paid') await finalizePaid(env, id, s);
    if (ev.type === 'checkout.session.expired' || ev.type === 'checkout.session.async_payment_failed') {
      const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first();
      if (o) await cancelOrder(env, o);
    }
  }
  return json({ received: true });
}

// Local testing only: pretends Stripe took the payment. Disabled as soon as a Stripe key is set.
async function devPay(env, url) {
  if (!fakePay(env)) throw new HttpError(404, 'Not found');
  const id = url.searchParams.get('order') || '';
  await finalizePaid(env, id, {
    customer_details: { email: 'test.buyer@example.com', name: 'Test Buyer', phone: null },
    shipping_details: { name: 'Test Buyer', address: { line1: '1 Example Street', line2: null, city: 'Brisbane', state: 'QLD', postal_code: '4000', country: 'AU' } }
  });
  return Response.redirect(`${url.origin}/?paid=${encodeURIComponent(id)}&session_id=dev`, 302);
}

/* ------------------------------ admin ------------------------------ */

async function login(req, env, url) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Admin password has not been set');
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const since = now() - 900;
  const tries = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip=?1 AND at>?2').bind(ip, since).first();
  if (tries.n >= 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  const { password } = await body(req);
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  if (typeof password !== 'string' || !safeEq(await hmac(secret, password), await hmac(secret, env.ADMIN_PASSWORD))) {
    await env.DB.batch([env.DB.prepare('INSERT INTO login_attempts (ip,at) VALUES (?1,?2)').bind(ip, now()), env.DB.prepare('DELETE FROM login_attempts WHERE at<?1').bind(since)]);
    throw new HttpError(401, 'Wrong password');
  }
  const exp = now() + SESSION_DAYS * 86400;
  const cookie = `gs_admin=${exp}.${await hmac(secret, 'admin.' + exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}`;
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}
async function requireAdmin(req, env) {
  const m = /(?:^|;\s*)gs_admin=(\d+)\.([0-9a-f]{64})/.exec(req.headers.get('cookie') || '');
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  if (!m || !secret || Number(m[1]) < now() || !safeEq(await hmac(secret, 'admin.' + m[1]), m[2])) throw new HttpError(401, 'Please log in');
}

async function saveProduct(env, id, b) {
  const title = String(b.title || '').trim();
  const price = Math.round(Number(b.price_cents)), qty = Math.floor(Number(b.qty));
  if (!title || title.length > 200) throw new HttpError(400, 'Add a title (up to 200 characters)');
  if (!(price >= 50 && price <= 100000000)) throw new HttpError(400, 'Price must be at least $0.50');
  if (!(qty >= 0 && qty <= 999)) throw new HttpError(400, 'Quantity must be between 0 and 999');
  const categories = (Array.isArray(b.categories) ? b.categories : []).filter(c => CATEGORIES.includes(c));
  const images = (Array.isArray(b.images) ? b.images : []).filter(u => typeof u === 'string' && u.length < 500 && (/^\/img\/[a-z0-9]{20}\.(jpg|png|webp)$/.test(u) || u.startsWith('https://'))).slice(0, 8);
  const ebay = String(b.ebay_url || '').trim();
  if (ebay && !ebay.startsWith('https://')) throw new HttpError(400, 'eBay link must start with https://');
  const v = [title, String(b.description || '').slice(0, 4000), price, qty, JSON.stringify(categories), String(b.condition || '').slice(0, 60),
    b.ship_class === 'parcel' ? 'parcel' : 'letter', JSON.stringify(images), b.status === 'hidden' ? 'hidden' : 'active', ebay.slice(0, 500), now()];
  if (id) {
    const r = await env.DB.prepare('UPDATE products SET title=?1,description=?2,price_cents=?3,qty=?4,categories=?5,condition=?6,ship_class=?7,images=?8,status=?9,ebay_url=?10,updated_at=?11 WHERE id=?12').bind(...v, id).run();
    if (!r.meta.changes) throw new HttpError(404, 'Card not found');
  } else {
    id = uid(10);
    await env.DB.prepare('INSERT INTO products (title,description,price_cents,qty,categories,condition,ship_class,images,status,ebay_url,updated_at,id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?11)').bind(...v, id).run();
  }
  return json({ product: parseProduct(await env.DB.prepare('SELECT * FROM products WHERE id=?1').bind(id).first()) });
}
async function deleteProduct(env, id) {
  const row = await env.DB.prepare('SELECT images FROM products WHERE id=?1').bind(id).first();
  if (!row) throw new HttpError(404, 'Card not found');
  await env.DB.prepare('DELETE FROM products WHERE id=?1').bind(id).run();
  for (const u of safeArr(row.images)) if (u.startsWith('/img/')) await env.IMAGES.delete(u.slice(5)).catch(() => {});
  return json({ ok: true });
}
async function updateOrder(env, id, b) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(id).first();
  if (!o) throw new HttpError(404, 'Order not found');
  const tracking = String(b.tracking ?? o.tracking).slice(0, 80);
  let status = o.status, posted = o.posted_at;
  if (b.posted === true && o.status === 'paid') { status = 'posted'; posted = now(); }
  if (b.posted === false && o.status === 'posted') { status = 'paid'; posted = null; }
  await env.DB.prepare('UPDATE orders SET status=?2, tracking=?3, posted_at=?4 WHERE id=?1').bind(id, status, tracking, posted).run();
  return json({ ok: true });
}
