CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
  categories TEXT NOT NULL DEFAULT '[]', condition TEXT NOT NULL DEFAULT '',
  ship_class TEXT NOT NULL DEFAULT 'letter', images TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', ebay_url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', items TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL, shipping_label TEXT NOT NULL,
  total_cents INTEGER NOT NULL, stripe_session TEXT, cancel_token TEXT,
  email TEXT, name TEXT, phone TEXT, address TEXT, tracking TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, paid_at INTEGER, posted_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
