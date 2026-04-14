-- Aosom Sync — SQLite Schema
-- Loaded at startup by database.ts

-- Produits Aosom (snapshot du dernier CSV)
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT,
  price REAL,
  qty INTEGER,
  color TEXT,
  size TEXT,
  product_type TEXT,
  image1 TEXT,
  image2 TEXT,
  image3 TEXT,
  image4 TEXT,
  image5 TEXT,
  image6 TEXT,
  image7 TEXT,
  video TEXT,
  description TEXT,
  short_description TEXT,
  material TEXT,
  gtin TEXT,
  weight REAL,
  out_of_stock_expected TEXT,
  estimated_arrival TEXT,
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  last_seen_at INTEGER,
  last_posted_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type);
CREATE INDEX IF NOT EXISTS idx_products_shopify_id ON products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
CREATE INDEX IF NOT EXISTS idx_products_qty ON products(qty);

-- Historique des changements détectés par le differ
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  old_price REAL,
  new_price REAL,
  old_qty INTEGER,
  new_qty INTEGER,
  change_type TEXT,
  detected_at INTEGER DEFAULT (strftime('%s','now')),
  applied_to_shopify INTEGER DEFAULT 0,
  FOREIGN KEY (sku) REFERENCES products(sku)
);

CREATE INDEX IF NOT EXISTS idx_price_history_sku ON price_history(sku);
CREATE INDEX IF NOT EXISTS idx_price_history_change_type ON price_history(change_type);
CREATE INDEX IF NOT EXISTS idx_price_history_detected_at ON price_history(detected_at);

-- Drafts de posts Facebook
CREATE TABLE IF NOT EXISTS facebook_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  language TEXT NOT NULL,
  post_text TEXT NOT NULL,
  image_path TEXT,
  image_url TEXT,
  image_urls TEXT,
  old_price REAL,
  new_price REAL,
  status TEXT DEFAULT 'draft',
  scheduled_at INTEGER,
  published_at INTEGER,
  facebook_post_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY (sku) REFERENCES products(sku)
);

CREATE INDEX IF NOT EXISTS idx_facebook_drafts_sku ON facebook_drafts(sku);
CREATE INDEX IF NOT EXISTS idx_facebook_drafts_status ON facebook_drafts(status);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- Paramètres configurables (clé-valeur)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Valeurs par défaut
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('social_default_language', 'FR'),
  ('social_post_frequency', '1'),
  ('social_preferred_hour', '13'),
  ('social_price_drop_threshold', '10'),
  ('social_min_days_between_reposts', '30'),
  ('social_hashtags_fr', '#jardinage #patio #mobilierexterieur #canada'),
  ('social_hashtags_en', '#garden #patio #outdoorfurniture #canada'),
  ('social_include_price', 'true'),
  ('social_include_link', 'true'),
  ('social_tone', 'promotional'),
  ('prompt_new_product_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook engageant pour ce nouveau produit : {product_name}. Prix : {price}$. Ton : enthousiaste et accessible. Maximum 150 mots. Termine avec les hashtags : {hashtags}'),
  ('prompt_new_product_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write an engaging Facebook post for this new product: {product_name}. Price: {price}$. Tone: enthusiastic and approachable. Maximum 150 words. End with hashtags: {hashtags}'),
  ('prompt_price_drop_fr', 'Tu es un expert en marketing promotionnel québécois. Rédige un post Facebook pour annoncer une baisse de prix sur : {product_name}. Ancien prix : {old_price}$. Nouveau prix : {new_price}$. Mets en valeur les économies. Maximum 120 mots. Hashtags : {hashtags}'),
  ('prompt_price_drop_en', 'You are a Canadian promotional marketing expert. Write a Facebook post announcing a price drop on: {product_name}. Old price: {old_price}$. New price: {new_price}$. Highlight the savings. Maximum 120 words. Hashtags: {hashtags}'),
  ('prompt_highlight_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook pour mettre en valeur ce produit populaire de notre catalogue : {product_name}. Prix : {price}$. Stock disponible : {qty} unités. Maximum 130 mots. Hashtags : {hashtags}'),
  ('prompt_highlight_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write a Facebook post highlighting this popular product from our catalogue: {product_name}. Price: {price}$. Stock: {qty} units available. Maximum 130 words. Hashtags: {hashtags}'),
  ('social_accent_color', '#2563eb'),
  ('social_text_color', '#ffffff'),
  ('social_store_display_name', ''),
  ('social_banner_opacity', '75'),
  ('social_logo_position', 'bottom-right');
