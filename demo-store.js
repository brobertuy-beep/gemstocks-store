/* Preview mode for GitHub Pages.
   There is no shop server on GitHub Pages, so this file stands in for it: cards, orders and postage
   settings are kept in this browser's localStorage. Nothing is sent anywhere and no payment is taken.
   It only switches on at a *.github.io address; on the real shop it does nothing. */
(function () {
  const on = /\.github\.io$/.test(location.hostname);
  const base = document.currentScript.src;
  const KEY = 'gs_demo_v1';
  const DEFAULT_POSTAGE = { letter: 500, parcel: 1200, express_extra: 500, signature_threshold: 30000, signature_fee: 500 };
  const CATEGORIES = ['pokemon', 'onepiece', 'lorcana', 'graded', 'singles', 'sealed', 'accessories'];
  const now = () => Math.floor(Date.now() / 1000);
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  const uid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ALPHA[b % ALPHA.length]).join('');
  const fail = (status, message, data) => Object.assign(new Error(message), { status, data });

  function get() { try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.products)) return s; } catch (e) {} return null; }
  function put(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { throw fail(400, 'Preview storage is full. Remove a photo or reset the preview data.'); } }
  async function seed() {
    const r = await fetch(new URL('demo-products.json', base));
    if (!r.ok) throw new Error('Could not load preview cards');
    const t = now();
    put({ products: (await r.json()).products.map((p, i) => ({ description: '', condition: '', ebay_url: '', status: 'active', created_at: t - i, updated_at: t - i, ...p })), orders: [], postage: { ...DEFAULT_POSTAGE } });
  }
  async function load() { if (!get()) await seed(); }

  function quote(items) {
    const s = get(), byId = Object.fromEntries(s.products.map(p => [p.id, p]));
    const unavailable = items.filter(i => { const p = byId[i.id]; return !p || p.status !== 'active' || p.qty < i.qty; }).map(i => i.id);
    if (unavailable.length) throw fail(409, 'Sorry, something in your cart has just sold.', { unavailable });
    const lines = items.map(i => { const p = byId[i.id]; return { id: p.id, title: p.title, qty: i.qty, price_cents: p.price_cents, image: p.images[0] || '', ship_class: p.ship_class }; });
    const subtotal = lines.reduce((a, l) => a + l.price_cents * l.qty, 0);
    const pg = { ...DEFAULT_POSTAGE, ...s.postage };
    const letter = lines.every(l => l.ship_class === 'letter');
    const sig = subtotal >= pg.signature_threshold ? pg.signature_fee : 0;
    const b = (letter ? pg.letter : pg.parcel) + sig, kind = letter ? 'letter' : 'parcel', tail = sig ? ' with signature' : '';
    return { lines, subtotal, options: [{ id: 'standard', label: `Tracked ${kind}${tail}`, cents: b }, { id: 'express', label: `Express ${kind}${tail}`, cents: b + pg.express_extra }] };
  }

  function placeOrder({ items, shipping, email, name, address }) {
    const q = quote(items), opt = q.options.find(o => o.id === shipping) || q.options[0];
    const s = get();
    for (const i of items) s.products.find(p => p.id === i.id).qty -= i.qty;
    const order = {
      id: 'GS-' + uid(8).toUpperCase(), status: 'paid', items: q.lines.map(({ ship_class, ...l }) => l),
      subtotal_cents: q.subtotal, shipping_cents: opt.cents, shipping_label: opt.label, total_cents: q.subtotal + opt.cents,
      email, name, phone: null, address, tracking: '', created_at: now(), paid_at: now(), posted_at: null
    };
    s.orders.unshift(order); put(s);
    return order;
  }
  function orderStatus(id) {
    const o = get().orders.find(x => x.id === id);
    if (!o) throw fail(404, 'Order not found');
    return { id: o.id, status: o.status, first_name: (o.name || '').split(' ')[0], total_cents: o.total_cents };
  }

  const toDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

  // Stands in for the /api/admin/* endpoints.
  async function admin(path, method = 'GET', data) {
    const [res, id] = path.split('/');
    if (res === 'login') { sessionStorage.setItem('gs_demo_admin', '1'); return { ok: true }; }
    if (res === 'logout') { sessionStorage.removeItem('gs_demo_admin'); return { ok: true }; }
    if (sessionStorage.getItem('gs_demo_admin') !== '1') throw fail(401, 'Please log in');
    await load();
    const s = get();
    if (res === 'me') return { ok: true, stripe: false, fakePay: true, demo: true };
    if (res === 'reset') { localStorage.removeItem(KEY); await seed(); return { ok: true }; }
    if (res === 'upload') return { url: await toDataUrl(data) };
    if (res === 'products') {
      if (method === 'GET') return { products: [...s.products].sort((a, b) => b.created_at - a.created_at) };
      if (method === 'DELETE') { s.products = s.products.filter(p => p.id !== id); put(s); return { ok: true }; }
      const title = String(data.title || '').trim(), price = Math.round(Number(data.price_cents)), qty = Math.floor(Number(data.qty));
      if (!title || title.length > 200) throw fail(400, 'Add a title (up to 200 characters)');
      if (!(price >= 50)) throw fail(400, 'Price must be at least $0.50');
      if (!(qty >= 0 && qty <= 999)) throw fail(400, 'Quantity must be between 0 and 999');
      const v = {
        title, description: String(data.description || '').slice(0, 4000), price_cents: price, qty,
        categories: (data.categories || []).filter(c => CATEGORIES.includes(c)), condition: String(data.condition || '').slice(0, 60),
        ship_class: data.ship_class === 'parcel' ? 'parcel' : 'letter', images: (data.images || []).slice(0, 8),
        status: data.status === 'hidden' ? 'hidden' : 'active', ebay_url: String(data.ebay_url || ''), updated_at: now()
      };
      if (method === 'PUT') { const p = s.products.find(x => x.id === id); if (!p) throw fail(404, 'Card not found'); Object.assign(p, v); put(s); return { product: p }; }
      const p = { id: uid(10), created_at: now(), ...v }; s.products.push(p); put(s); return { product: p };
    }
    if (res === 'orders') {
      if (method === 'GET') return { orders: s.orders };
      const o = s.orders.find(x => x.id === id); if (!o) throw fail(404, 'Order not found');
      if (data.tracking !== undefined) o.tracking = String(data.tracking).slice(0, 80);
      if (data.posted === true && o.status === 'paid') { o.status = 'posted'; o.posted_at = now(); }
      if (data.posted === false && o.status === 'posted') { o.status = 'paid'; o.posted_at = null; }
      put(s); return { ok: true };
    }
    if (res === 'postage') {
      if (method === 'GET') return { postage: { ...DEFAULT_POSTAGE, ...s.postage } };
      const out = {};
      for (const k of Object.keys(DEFAULT_POSTAGE)) { const n = Math.round(Number(data[k])); if (!(n >= 0)) throw fail(400, 'Check the postage amounts'); out[k] = n; }
      s.postage = out; put(s); return { postage: out };
    }
    throw fail(404, 'Not found');
  }

  window.GSDemo = {
    on, load, quote, placeOrder, orderStatus, admin,
    products: () => get().products.filter(p => p.status === 'active' && p.qty > 0).sort((a, b) => b.created_at - a.created_at)
  };
})();
