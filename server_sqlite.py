from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import hashlib
import gzip
import json
import mimetypes
import os
import secrets
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:
    psycopg = None
    dict_row = None
    Jsonb = None

INTEGRITY_ERRORS = (sqlite3.IntegrityError,)
if psycopg is not None:
    INTEGRITY_ERRORS = (sqlite3.IntegrityError, psycopg.errors.UniqueViolation)

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, "oneten.sqlite3")
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL") or ""
USE_POSTGRES = bool(DATABASE_URL.strip())
SQLITE_BUSY_TIMEOUT_MS = int(os.environ.get("SQLITE_BUSY_TIMEOUT_MS", "30000"))
PORT = int(os.environ.get("PORT", "4181"))
HOST = os.environ.get("HOST", "0.0.0.0")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
SECRET_SETTING_KEYS = {"openai_api_key"}


def now():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def hash_password(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def db_bool(value):
    return bool(value) if USE_POSTGRES else (1 if value else 0)


class PostgresCursor:
    def __init__(self, cursor):
        self.cursor = cursor
        self.lastrowid = None

    def execute(self, query, params=()):
        translated = translate_query(query)
        wants_id = self._needs_returning_id(translated)
        if wants_id and " returning " not in translated.lower():
            translated = translated.rstrip().rstrip(";") + " RETURNING id"
        params = adapt_postgres_params(translated, params)
        self.cursor.execute(translated, params)
        self.lastrowid = None
        if wants_id:
            row = self.cursor.fetchone()
            self.lastrowid = row["id"] if row else None
        return self

    def fetchone(self):
        return self.cursor.fetchone()

    def fetchall(self):
        return self.cursor.fetchall()

    def _needs_returning_id(self, query):
        lowered = " ".join(query.lower().split())
        return lowered.startswith("insert into customers ") or lowered.startswith("insert into orders ")


class PostgresConnection:
    def __init__(self):
        if psycopg is None:
            raise RuntimeError("psycopg is required for Supabase/Postgres. Install requirements.txt on the host.")
        self.conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)

    def cursor(self):
        return PostgresCursor(self.conn.cursor())

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()


def translate_query(query):
    translated = query
    translated = translated.replace("?", "%s")
    translated = translated.replace("p.active = 1", "p.active = true")
    translated = translated.replace("active = 1", "active = true")
    translated = translated.replace("active, created_at)\n                VALUES", "active, created_at)\n                VALUES")
    translated = translated.replace("INSERT OR REPLACE INTO settings (key, value) VALUES (%s, %s)", "INSERT INTO settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
    return translated


def adapt_postgres_params(query, params):
    if not USE_POSTGRES or Jsonb is None or not params:
        return params
    lowered = query.lower()
    if "products" not in lowered or not any(name in lowered for name in ("images", "ai_images", "ai_prompts", "product_sizes")):
        return params
    adapted = []
    for value in params:
        if isinstance(value, str) and value.strip().startswith(("[", "{")):
            try:
                adapted.append(Jsonb(json.loads(value)))
                continue
            except json.JSONDecodeError:
                pass
        adapted.append(value)
    return tuple(adapted)


def db():
    if USE_POSTGRES:
        return PostgresConnection()
    conn = sqlite3.connect(DB_PATH, timeout=max(1, SQLITE_BUSY_TIMEOUT_MS // 1000))
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def configure_sqlite_database(conn):
    if USE_POSTGRES:
        return
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
    except sqlite3.OperationalError:
        pass


def database_error_message(exc):
    message = str(exc)
    if not USE_POSTGRES and "database is locked" in message.lower():
        return "SQLite database is locked. On Render, set DATABASE_URL to your Supabase/Postgres connection string, then redeploy the backend."
    return message


def rows(cursor):
    return [dict(row) for row in cursor.fetchall()]


def product_image_list(data):
    images = data.get("images", [])
    if isinstance(images, str):
        try:
            images = json.loads(images)
        except json.JSONDecodeError:
            images = []
    images = [str(item).strip() for item in images if str(item).strip()]
    primary = str(data.get("image", "")).strip()
    if primary:
        images.insert(0, primary)
    clean = []
    for image in images:
        if image not in clean:
            clean.append(image)
    return clean or ["assets/ai-products.png"]


def json_list(value):
    if isinstance(value, list):
        return value
    if not value:
        return []
    try:
        data = json.loads(value)
        return data if isinstance(data, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def product_sizes(value):
    source = value.get("product_sizes", []) if isinstance(value, dict) else value
    if isinstance(source, str):
        try:
            source = json.loads(source)
        except json.JSONDecodeError:
            source = []
    if not isinstance(source, list):
        return []
    clean = {}
    for item in source:
        if not isinstance(item, dict):
            continue
        size = str(item.get("size", "")).strip().upper()
        if not size:
            continue
        try:
            stock = max(0, int(item.get("stock", 0) or 0))
        except (TypeError, ValueError):
            stock = 0
        clean[size] = clean.get(size, 0) + stock
    return [{"size": size, "stock": stock} for size, stock in clean.items()]


def product_total_stock(size_rows, fallback=0):
    if size_rows:
        return sum(int(item.get("stock") or 0) for item in size_rows)
    return max(0, int(fallback or 0))


def public_size_rows(size_rows):
    return [item for item in size_rows if int(item.get("stock") or 0) > 0]


def public_product_record(product, full=False):
    product = dict(product)
    sizes = public_size_rows(product_sizes(product))
    if product_sizes(product) and not sizes:
        return None
    gallery = json_list(product.get("ai_images")) or product_image_list(product)
    image = gallery[0] if gallery else "assets/ai-products.png"
    clean = {
        "id": product.get("id"),
        "category_id": product.get("category_id"),
        "category": product.get("category"),
        "name": product.get("name"),
        "price": product.get("price"),
        "old_price": product.get("old_price"),
        "badge": product.get("badge"),
        "rating": product.get("rating"),
        "stock": product_total_stock(sizes, product.get("stock")),
        "product_sizes": sizes,
        "image": image,
        "images": [image],
        "crop": product.get("crop") or "center",
        "description": product.get("description") or "",
        "active": product.get("active"),
    }
    if full:
        clean["images"] = gallery
        clean["ai_images"] = json_list(product.get("ai_images"))
        clean["ai_prompts"] = json_list(product.get("ai_prompts"))
        clean["ai_type"] = product.get("ai_type") or "top"
    return clean


def add_product_size_stock(cur, product_id, size, qty):
    qty = int(qty or 0)
    if qty <= 0:
        return
    product = cur.execute("SELECT stock, product_sizes FROM products WHERE id = ?", (product_id,)).fetchone()
    if not product:
        return
    sizes = product_sizes(product)
    if sizes and str(size or "").strip():
        selected = str(size or "").strip().upper()
        found = False
        for item in sizes:
            if item["size"] == selected:
                item["stock"] = int(item.get("stock") or 0) + qty
                found = True
                break
        if not found:
            sizes.append({"size": selected, "stock": qty})
        new_stock = product_total_stock(sizes)
        cur.execute("UPDATE products SET stock = ?, product_sizes = ? WHERE id = ?", (new_stock, json.dumps(sizes), product_id))
    else:
        cur.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (qty, product_id))
    sync_product_visibility(cur, product_id)


AI_TYPE_LABELS = {
    "top": "shirt, t-shirt, jacket, hoodie, or upper-body garment",
    "pants": "pants, trousers, jeans, shorts, or lower-body garment",
    "outfit": "full outfit, suit, tracksuit, or complete coordinated look",
    "shoes": "shoes, sneakers, sandals, or footwear",
    "watch": "watch, bracelet, ring, or small accessory",
    "accessory": "cap, belt, bag, sunglasses, or men's accessory",
}


def ai_product_prompts(product, ai_type, has_model_reference=False):
    name = product.get("name", "ONE TEN product")
    description = product.get("description", "")
    product_type = AI_TYPE_LABELS.get(ai_type, AI_TYPE_LABELS["top"])
    model = (
        "same stylish young Black male model as the reference portrait, clean shaped beard, "
        "modern curly afro, confident professional fashion pose"
    )
    if has_model_reference:
        model += ", preserve the uploaded AI model reference identity and grooming style"
    rules = {
        "top": "focus on the upper garment; crop around chest and torso; pants are neutral and not advertised",
        "pants": "focus on lower body first; if torso appears, shirtless athletic upper body with a clean six-pack, no shirt promotion",
        "outfit": "show full-body styling, complete outfit visible, fashion campaign pose",
        "shoes": "focus on footwear, low-angle shoe detail, model styling supports the shoes",
        "watch": "close detail on wrist/hand accessory, luxury men's fashion framing",
        "accessory": "focus on the exact accessory placement and use, clean men's fashion styling",
    }
    focus = rules.get(ai_type, rules["top"])
    base = f"{name}. {description}. Product type: {product_type}. {focus}."
    return [
        f"Studio ecommerce hero on smooth light gray background, ultra clean product advertisement, {model}, {base}",
        f"Sharp catalog detail shot, product texture and cut in focus, soft gray studio lighting, {model}, {base}",
        f"Premium lifestyle streetwear scene, red white black ONE TEN color mood, natural confident pose, {model}, {base}",
        f"Editorial men's fashion campaign, clean shadows, high-end online shop look, {model}, {base}",
        f"Social ad crop, bold modern composition, product clearly visible, professional retouched finish, {model}, {base}",
    ]


def generate_ai_images(prompts, api_key=""):
    api_key = (api_key or os.environ.get("OPENAI_API_KEY", "")).strip()
    if not api_key:
        return []
    images = []
    for prompt in prompts:
        body = json.dumps({
            "model": os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2"),
            "prompt": prompt,
            "size": "1024x1024",
            "quality": os.environ.get("OPENAI_IMAGE_QUALITY", "low"),
        }).encode("utf-8")
        request = urllib.request.Request(
            "https://api.openai.com/v1/images/generations",
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
        image = (payload.get("data") or [{}])[0]
        if image.get("b64_json"):
            images.append(f"data:image/png;base64,{image['b64_json']}")
        elif image.get("url"):
            images.append(image["url"])
    return images


def friendly_ai_error(error_text):
    if not error_text:
        return ""
    try:
        payload = json.loads(error_text)
        message = ((payload.get("error") or {}).get("message") or "").strip()
        if message:
            return message
    except (TypeError, json.JSONDecodeError):
        pass
    return str(error_text).strip()


def normalize_phone(phone):
    value = str(phone or "").strip()
    return "".join(ch for ch in value if ch.isdigit() or ch == "+")


def sync_product_visibility(cur, product_id):
    row = cur.execute("SELECT stock, product_sizes FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return
    size_rows = product_sizes(row)
    stock = product_total_stock(size_rows, row["stock"])
    cur.execute("UPDATE products SET stock = ?, active = ? WHERE id = ?", (stock, db_bool(stock > 0), product_id))


def recalc_order(cur, order_id):
    total = cur.execute(
        "SELECT COALESCE(SUM(price * qty), 0) AS total FROM order_items WHERE order_id = ? AND status != 'Cancelled'",
        (order_id,),
    ).fetchone()["total"]
    items = rows(cur.execute("SELECT status FROM order_items WHERE order_id = ?", (order_id,)))
    active_items = [item for item in items if item["status"] != "Cancelled"]
    if not items or not active_items:
        status = "Cancelled"
    elif all(item["status"] == "Approved" for item in active_items):
        status = "Approved"
    else:
        status = "Processing"
    cur.execute("UPDATE orders SET total = ?, status = ? WHERE id = ?", (total, status, order_id))


def init_db():
    if USE_POSTGRES:
        schema_path = os.path.join(ROOT, "supabase_schema.sql")
        if not os.path.exists(schema_path):
            raise RuntimeError("supabase_schema.sql is missing")
        conn = db()
        cur = conn.cursor()
        cur.cursor.execute(open(schema_path, "r", encoding="utf-8").read())
        conn.commit()
        conn.close()
        return

    conn = db()
    configure_sqlite_database(conn)
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS admin_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_type TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          description TEXT DEFAULT '',
          price_mode TEXT DEFAULT 'range',
          sort_order INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER,
          name TEXT NOT NULL,
          price REAL NOT NULL,
          old_price REAL,
          badge TEXT DEFAULT '',
          rating TEXT DEFAULT '4.8',
          stock INTEGER DEFAULT 0,
          product_sizes TEXT DEFAULT '[]',
          image TEXT NOT NULL,
          images TEXT DEFAULT '[]',
          crop TEXT DEFAULT 'center',
          description TEXT DEFAULT '',
          ai_type TEXT DEFAULT 'top',
          ai_images TEXT DEFAULT '[]',
          ai_prompts TEXT DEFAULT '[]',
          active INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY(category_id) REFERENCES categories(id)
        );
        CREATE TABLE IF NOT EXISTS ads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          subtitle TEXT DEFAULT '',
          button_text TEXT DEFAULT 'Shop Now',
          link TEXT DEFAULT '#/shop',
          image TEXT NOT NULL,
          active INTEGER DEFAULT 1,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL,
          customer_name TEXT NOT NULL,
          phone TEXT NOT NULL,
          address TEXT DEFAULT '',
          status TEXT DEFAULT 'Processing',
          total REAL NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(customer_id) REFERENCES customers(id)
        );
        CREATE TABLE IF NOT EXISTS order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          product_name TEXT NOT NULL,
          product_image TEXT DEFAULT '',
          price REAL NOT NULL,
          requested_qty INTEGER DEFAULT 1,
          qty INTEGER NOT NULL,
          size TEXT DEFAULT '',
          status TEXT DEFAULT 'Processing',
          FOREIGN KEY(order_id) REFERENCES orders(id),
          FOREIGN KEY(product_id) REFERENCES products(id)
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS newsletter_subscribers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL
        );
        """
    )

    category_cols = [row["name"] for row in cur.execute("PRAGMA table_info(categories)")]
    if "price_mode" not in category_cols:
        cur.execute("ALTER TABLE categories ADD COLUMN price_mode TEXT DEFAULT 'range'")
    order_item_cols = [row["name"] for row in cur.execute("PRAGMA table_info(order_items)")]
    if "product_image" not in order_item_cols:
        cur.execute("ALTER TABLE order_items ADD COLUMN product_image TEXT DEFAULT ''")
    if "requested_qty" not in order_item_cols:
        cur.execute("ALTER TABLE order_items ADD COLUMN requested_qty INTEGER DEFAULT 1")
        cur.execute("UPDATE order_items SET requested_qty = qty WHERE requested_qty IS NULL OR requested_qty = 1")
    if "status" not in order_item_cols:
        cur.execute("ALTER TABLE order_items ADD COLUMN status TEXT DEFAULT 'Processing'")
    if "size" not in order_item_cols:
        cur.execute("ALTER TABLE order_items ADD COLUMN size TEXT DEFAULT ''")
    product_cols = [row["name"] for row in cur.execute("PRAGMA table_info(products)")]
    if "images" not in product_cols:
        cur.execute("ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'")
    if "product_sizes" not in product_cols:
        cur.execute("ALTER TABLE products ADD COLUMN product_sizes TEXT DEFAULT '[]'")
    if "ai_type" not in product_cols:
        cur.execute("ALTER TABLE products ADD COLUMN ai_type TEXT DEFAULT 'top'")
    if "ai_images" not in product_cols:
        cur.execute("ALTER TABLE products ADD COLUMN ai_images TEXT DEFAULT '[]'")
    if "ai_prompts" not in product_cols:
        cur.execute("ALTER TABLE products ADD COLUMN ai_prompts TEXT DEFAULT '[]'")

    cur.execute("SELECT COUNT(*) AS c FROM admin_users")
    if cur.fetchone()["c"] == 0:
        cur.execute(
            "INSERT INTO admin_users (username, password_hash, created_at) VALUES (?, ?, ?)",
            ("onetenadmin", hash_password("oneten"), now()),
        )

    cur.execute("SELECT COUNT(*) AS c FROM categories")
    if cur.fetchone()["c"] == 0:
        for order, name in enumerate(["T-Shirts", "Shirts", "Pants", "Jackets", "Sneakers", "Accessories", "Caps", "Socks"], start=1):
            cur.execute(
                "INSERT INTO categories (name, description, price_mode, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
                (name, f"ONE TEN {name.lower()} from $1 to $10.", "max10" if name in ("Shirts", "Sneakers", "Jackets") else "range", order, now()),
            )

    cur.execute("SELECT COUNT(*) AS c FROM products")
    if cur.fetchone()["c"] == 0:
        category_ids = {row["name"]: row["id"] for row in cur.execute("SELECT id, name FROM categories")}
        seed_products = [
            ("T-Shirts", "Red Core Tee", 5, 7, "New", 42, "assets/ai-products.png", "0% 0%", "Soft red cotton tee for daily men's outfits."),
            ("Shirts", "White Clean Shirt", 10, 12, "-20%", 25, "assets/ai-products.png", "50% 0%", "White smart-casual shirt for clean day and evening looks."),
            ("Pants", "Black Smart Pants", 9, None, "", 18, "assets/ai-products.png", "100% 0%", "Black trousers with a clean shape for work and weekends."),
            ("Caps", "Black Daily Cap", 3, 5, "Hot", 63, "assets/ai-products.png", "0% 50%", "Simple black cap that completes casual outfits."),
            ("Accessories", "Black Belt", 4, None, "", 38, "assets/ai-products.png", "50% 50%", "Minimal black belt with clean everyday styling."),
            ("Accessories", "Black Sunglasses", 6, 8, "-25%", 31, "assets/ai-products.png", "100% 50%", "Sharp black sunglasses for a stronger streetwear look."),
            ("Sneakers", "White Low Sneakers", 10, None, "New", 14, "assets/ai-products.png", "0% 100%", "White low sneakers for clean outfit finishing."),
            ("Socks", "Black Sport Socks", 1, 2, "-50%", 80, "assets/ai-products.png", "50% 100%", "Black socks with simple white athletic detail."),
            ("Jackets", "Night Bomber Jacket", 10, 14, "Deal", 11, "assets/ai-products.png", "100% 100%", "Black bomber jacket for evening casual style."),
        ]
        for item in seed_products:
            category, name, price, old_price, badge, stock, image, crop, desc = item
            cur.execute(
                """
                INSERT INTO products
                (category_id, name, price, old_price, badge, rating, stock, image, crop, description, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (category_ids[category], name, price, old_price, badge, "4.8", stock, image, crop, desc, now()),
            )

    cur.execute("SELECT COUNT(*) AS c FROM ads")
    if cur.fetchone()["c"] == 0:
        seed_ads = [
            ("Men's Outfits From $1 to $10", "Red, white, and black essentials for everyday style.", "Shop Grid", "#/shop", "assets/ai-hero.png", 1),
            ("Weekend Flash Sale", "Caps, socks, belts, and tees ready for fast delivery.", "See Deals", "#/shop", "assets/ai-products.png", 2),
            ("New ONE TEN Drop", "Fresh shirts and black layers for clean Hargaysa looks.", "New Arrivals", "#/shop", "assets/ai-hero.png", 3),
        ]
        for title, subtitle, button, link, image, order in seed_ads:
            cur.execute(
                """
                INSERT INTO ads (title, subtitle, button_text, link, image, active, sort_order, created_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (title, subtitle, button, link, image, order, now()),
            )

    seed_settings = {
        "store_name": "ONE TEN",
        "logo_image": "",
        "logo_day": "",
        "logo_night": "",
        "footer_logo": "",
        "product_badge_logo": "",
        "ai_model_reference": "",
        "footer_text": "Men's fashion, clean prices, Hargaysa delivery.",
        "contact_title": "Get In Touch",
        "phone": "+252 63 000 1010",
        "hotline": "(+252) 63 000 1010",
        "email": "support@oneten.shop",
        "location": "Hargaysa",
        "about_eyebrow": "ONE TEN story",
        "about_title": "Affordable men's fashion with a sharp street look.",
        "about_body": "ONE TEN focuses on simple, clean menswear for daily outfits. Every product stays between $1 and $10, with fast local delivery and a bold red, white, and black identity.",
        "about_image": "assets/ai-hero.png",
        "information_links": json.dumps([
            {"label": "About Us", "href": "#/about"},
            {"label": "Contact Us", "href": "#/contact"},
            {"label": "Shop Grid", "href": "#/shop"}
        ]),
        "department_links": json.dumps([
            {"label": "Shirts", "href": "#/shop"},
            {"label": "Accessories", "href": "#/shop"},
            {"label": "Admin Login", "href": "/admin.html"}
        ]),
    }
    for key, value in seed_settings.items():
        cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))

    conn.commit()
    conn.close()


def require_session(headers, user_type):
    auth = headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth.replace("Bearer ", "", 1).strip()
    conn = db()
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM sessions WHERE token = ? AND user_type = ?",
        (token, user_type),
    )
    session = cur.fetchone()
    if not session:
        conn.close()
        return None
    table = "admin_users" if user_type == "admin" else "customers"
    cur.execute(f"SELECT * FROM {table} WHERE id = ?", (session["user_id"],))
    user = cur.fetchone()
    conn.close()
    return dict(user) if user else None


def public_payload():
    conn = db()
    cur = conn.cursor()
    categories = rows(cur.execute("SELECT * FROM categories ORDER BY sort_order, name"))
    products = rows(
        cur.execute(
            """
            SELECT p.*, c.name AS category
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.active = 1 AND COALESCE(p.stock, 0) > 0
            ORDER BY p.id DESC
            """
        )
    )
    public_products = []
    for product in products:
        clean_product = public_product_record(product, full=False)
        if clean_product:
            public_products.append(clean_product)
    products = public_products
    ads = rows(cur.execute("SELECT * FROM ads WHERE active = 1 ORDER BY sort_order, id"))
    raw_settings = {row["key"]: row["value"] for row in cur.execute("SELECT key, value FROM settings")}
    settings = {key: value for key, value in raw_settings.items() if key not in SECRET_SETTING_KEYS}
    settings["openai_api_configured"] = "1" if (os.environ.get("OPENAI_API_KEY", "").strip() or raw_settings.get("openai_api_key", "").strip()) else ""
    for key in ("information_links", "department_links"):
        try:
            settings[key] = json.loads(settings.get(key, "[]"))
        except json.JSONDecodeError:
            settings[key] = []
    conn.close()
    return {"categories": categories, "products": products, "ads": ads, "settings": settings}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        use_gzip = "gzip" in self.headers.get("Accept-Encoding", "").lower() and len(body) > 1024
        if use_gzip:
            body = gzip.compress(body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                return self.handle_get_api(path)
            return self.serve_file(path)
        except Exception as exc:
            return self.send_json(500, {"error": database_error_message(exc)})

    def do_POST(self):
        try:
            return self.handle_write_api("POST", urlparse(self.path).path)
        except Exception as exc:
            return self.send_json(500, {"error": database_error_message(exc)})

    def do_PUT(self):
        try:
            return self.handle_write_api("PUT", urlparse(self.path).path)
        except Exception as exc:
            return self.send_json(500, {"error": database_error_message(exc)})

    def do_DELETE(self):
        try:
            return self.handle_write_api("DELETE", urlparse(self.path).path)
        except Exception as exc:
            return self.send_json(500, {"error": database_error_message(exc)})

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors_headers()
        self.end_headers()

    def handle_get_api(self, path):
        if path == "/api/public/bootstrap":
            return self.send_json(200, public_payload())

        if path.startswith("/api/public/products/"):
            product_id = int(path.rsplit("/", 1)[1])
            conn = db()
            cur = conn.cursor()
            product = cur.execute(
                """
                SELECT p.*, c.name AS category
                FROM products p
                LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.id = ? AND p.active = 1 AND COALESCE(p.stock, 0) > 0
                """,
                (product_id,),
            ).fetchone()
            conn.close()
            clean_product = public_product_record(product, full=True) if product else None
            if not clean_product:
                return self.send_json(404, {"error": "Product not found"})
            return self.send_json(200, {"product": clean_product})

        if path == "/api/customer/me":
            user = require_session(self.headers, "customer")
            if not user:
                return self.send_json(401, {"error": "Login required"})
            return self.send_json(200, {"id": user["id"], "name": user["name"], "email": user["email"]})

        if path == "/api/customer/orders":
            user = require_session(self.headers, "customer")
            if not user:
                return self.send_json(401, {"error": "Login required"})
            conn = db()
            cur = conn.cursor()
            orders = rows(cur.execute("SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC", (user["id"],)))
            order_items = rows(
                cur.execute(
                    """
                    SELECT oi.*
                    FROM order_items oi
                    JOIN orders o ON o.id = oi.order_id
                    WHERE o.customer_id = ?
                    ORDER BY oi.order_id DESC, oi.id
                    """,
                    (user["id"],),
                )
            )
            items_by_order = {}
            for item in order_items:
                items_by_order.setdefault(item["order_id"], []).append(item)
            for order in orders:
                order["order_items"] = items_by_order.get(order["id"], [])
            conn.close()
            return self.send_json(200, {"orders": orders})

        admin = require_session(self.headers, "admin")
        if path.startswith("/api/admin/") and not admin:
            return self.send_json(401, {"error": "Admin login required"})

        conn = db()
        cur = conn.cursor()
        if path == "/api/admin/bootstrap":
            payload = public_payload()
            admin_products = rows(
                cur.execute(
                    """
                    SELECT p.*, c.name AS category
                    FROM products p
                    LEFT JOIN categories c ON c.id = p.category_id
                    ORDER BY p.id DESC
                    """
                )
            )
            for product in admin_products:
                sizes = product_sizes(product)
                product["product_sizes"] = sizes
                product["stock"] = product_total_stock(sizes, product.get("stock"))
                product["ai_images"] = json_list(product.get("ai_images"))
                product["ai_prompts"] = json_list(product.get("ai_prompts"))
                product["images"] = product["ai_images"] or product_image_list(product)
                product["image"] = product["images"][0]
            payload["products"] = admin_products
            orders = rows(
                cur.execute(
                    """
                    SELECT o.*, COUNT(oi.id) AS items
                    FROM orders o
                    LEFT JOIN order_items oi ON oi.order_id = o.id
                    GROUP BY o.id
                    ORDER BY o.id DESC
                    """
                )
            )
            subscribers = rows(cur.execute("SELECT * FROM newsletter_subscribers ORDER BY id DESC"))
            order_items = rows(cur.execute("SELECT * FROM order_items ORDER BY order_id DESC, id"))
            items_by_order = {}
            for item in order_items:
                items_by_order.setdefault(item["order_id"], []).append(item)
            for order in orders:
                order["order_items"] = items_by_order.get(order["id"], [])
            revenue = cur.execute("SELECT COALESCE(SUM(total), 0) AS total FROM orders").fetchone()["total"]
            payload["orders"] = orders
            payload["subscribers"] = subscribers
            payload["dashboard"] = {
                "products": len(payload["products"]),
                "categories": len(payload["categories"]),
                "ads": len(payload["ads"]),
                "orders": len(orders),
                "subscribers": len(subscribers),
                "revenue": revenue,
                "lowStock": len([p for p in payload["products"] if int(p["stock"] or 0) <= 12]),
            }
            conn.close()
            return self.send_json(200, payload)

        conn.close()
        return self.send_json(404, {"error": "Route not found"})

    def handle_write_api(self, method, path):
        if method == "POST" and path == "/api/customer/register":
            data = self.body()
            conn = db()
            cur = conn.cursor()
            try:
                cur.execute(
                    "INSERT INTO customers (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (data.get("name", "Customer"), data.get("email", "").lower(), hash_password(data.get("password", "")), now()),
                )
                user_id = cur.lastrowid
                token = secrets.token_hex(24)
                cur.execute("INSERT INTO sessions (token, user_type, user_id, created_at) VALUES (?, 'customer', ?, ?)", (token, user_id, now()))
                conn.commit()
                return self.send_json(201, {"token": token, "user": {"id": user_id, "name": data.get("name", "Customer"), "email": data.get("email", "").lower()}})
            except INTEGRITY_ERRORS:
                return self.send_json(409, {"error": "Email already exists"})
            finally:
                conn.close()

        if method == "POST" and path == "/api/customer/login":
            data = self.body()
            conn = db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM customers WHERE email = ? AND password_hash = ?", (data.get("email", "").lower(), hash_password(data.get("password", ""))))
            user = cur.fetchone()
            if not user:
                conn.close()
                return self.send_json(401, {"error": "Wrong email or password"})
            token = secrets.token_hex(24)
            cur.execute("INSERT INTO sessions (token, user_type, user_id, created_at) VALUES (?, 'customer', ?, ?)", (token, user["id"], now()))
            conn.commit()
            conn.close()
            return self.send_json(200, {"token": token, "user": {"id": user["id"], "name": user["name"], "email": user["email"]}})

        if method == "POST" and path == "/api/admin/login":
            data = self.body()
            conn = db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM admin_users WHERE username = ? AND password_hash = ?", (data.get("username", ""), hash_password(data.get("password", ""))))
            user = cur.fetchone()
            if not user:
                conn.close()
                return self.send_json(401, {"error": "Wrong admin username or password"})
            token = secrets.token_hex(24)
            cur.execute("INSERT INTO sessions (token, user_type, user_id, created_at) VALUES (?, 'admin', ?, ?)", (token, user["id"], now()))
            conn.commit()
            conn.close()
            return self.send_json(200, {"token": token, "admin": {"id": user["id"], "username": user["username"]}})

        if method == "POST" and path == "/api/orders":
            customer = require_session(self.headers, "customer")
            if not customer:
                return self.send_json(401, {"error": "Register or sign in before ordering"})
            data = self.body()
            items = data.get("items", [])
            if not items:
                return self.send_json(400, {"error": "Cart is empty"})
            conn = db()
            cur = conn.cursor()
            product_ids = list({int(item["id"]) for item in items})
            placeholders = ",".join("?" for _ in product_ids)
            products = {row["id"]: dict(row) for row in cur.execute(f"SELECT * FROM products WHERE id IN ({placeholders})", product_ids)}
            total = 0
            prepared_items = []
            for item in items:
                product = products.get(int(item["id"]))
                if product:
                    qty = max(1, int(item.get("qty", 1)))
                    selected_size = str(item.get("size", "") or "").strip().upper()
                    size_rows = product_sizes(product)
                    stock = product_total_stock(size_rows, product.get("stock"))
                    if product.get("active") not in (1, True) or stock <= 0:
                        conn.close()
                        return self.send_json(409, {"error": f"{product['name']} is out of stock"})
                    if size_rows:
                        size_row = next((row for row in size_rows if row["size"] == selected_size), None)
                        if not selected_size or not size_row or int(size_row.get("stock") or 0) <= 0:
                            conn.close()
                            return self.send_json(409, {"error": f"Size {selected_size or 'selected'} is not available for {product['name']}"})
                        size_stock = int(size_row.get("stock") or 0)
                        if qty > size_stock:
                            conn.close()
                            return self.send_json(409, {"error": f"Only {size_stock} left for {product['name']} size {selected_size}"})
                    elif qty > stock:
                        conn.close()
                        return self.send_json(409, {"error": f"Only {stock} left for {product['name']}"})
                    total += float(product["price"]) * qty
                    prepared_items.append((product, qty, selected_size, size_rows))
            cur.execute(
                "INSERT INTO orders (customer_id, customer_name, phone, address, status, total, created_at) VALUES (?, ?, ?, ?, 'Processing', ?, ?)",
                (customer["id"], customer["name"], data.get("phone", ""), data.get("address", ""), total, now()),
            )
            order_id = cur.lastrowid
            for product, qty, selected_size, size_rows in prepared_items:
                cur.execute(
                    "INSERT INTO order_items (order_id, product_id, product_name, product_image, price, requested_qty, qty, size, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Processing')",
                    (order_id, product["id"], product["name"], product["image"], product["price"], qty, qty, selected_size),
                )
                if size_rows:
                    for row in size_rows:
                        if row["size"] == selected_size:
                            row["stock"] = max(0, int(row.get("stock") or 0) - qty)
                            break
                    new_stock = product_total_stock(size_rows)
                    cur.execute("UPDATE products SET stock = ?, product_sizes = ? WHERE id = ?", (new_stock, json.dumps(size_rows), product["id"]))
                else:
                    cur.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (qty, product["id"]))
                sync_product_visibility(cur, product["id"])
            conn.commit()
            conn.close()
            return self.send_json(201, {"id": order_id, "total": total, "status": "Processing"})

        if method == "POST" and path == "/api/newsletter":
            data = self.body()
            phone = normalize_phone(data.get("phone", ""))
            if len(phone) < 7:
                return self.send_json(400, {"error": "Enter a valid phone number"})
            conn = db()
            cur = conn.cursor()
            try:
                cur.execute("INSERT INTO newsletter_subscribers (phone, created_at) VALUES (?, ?)", (phone, now()))
                conn.commit()
                return self.send_json(201, {"ok": True})
            except INTEGRITY_ERRORS:
                return self.send_json(409, {"error": "This phone number is already subscribed"})
            finally:
                conn.close()

        admin = require_session(self.headers, "admin")
        if path.startswith("/api/admin/") and not admin:
            return self.send_json(401, {"error": "Admin login required"})

        conn = db()
        cur = conn.cursor()

        if path == "/api/admin/categories" and method == "POST":
            data = self.body()
            cur.execute(
                "INSERT INTO categories (name, description, price_mode, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
                (data.get("name", "Category"), data.get("description", ""), data.get("price_mode", "range"), int(data.get("sort_order", 0) or 0), now()),
            )
            conn.commit()
            conn.close()
            return self.send_json(201, {"ok": True})

        if path.startswith("/api/admin/categories/"):
            category_id = int(path.rsplit("/", 1)[1])
            if method == "PUT":
                data = self.body()
                cur.execute(
                    "UPDATE categories SET name = ?, description = ?, price_mode = ?, sort_order = ? WHERE id = ?",
                    (data.get("name", "Category"), data.get("description", ""), data.get("price_mode", "range"), int(data.get("sort_order", 0) or 0), category_id),
                )
            elif method == "DELETE":
                cur.execute("DELETE FROM categories WHERE id = ?", (category_id,))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        if path == "/api/admin/products" and method == "POST":
            data = self.body()
            product_images = product_image_list(data)
            size_rows = product_sizes(data)
            stock = product_total_stock(size_rows, data.get("stock", 0))
            cur.execute(
                """
                INSERT INTO products
                (category_id, name, price, old_price, badge, rating, stock, product_sizes, image, images, crop, description, ai_type, ai_images, ai_prompts, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(data.get("category_id") or 1),
                    data.get("name", "Product"),
                    min(10, max(1, float(data.get("price", 1) or 1))),
                    float(data["old_price"]) if data.get("old_price") else None,
                    data.get("badge", ""),
                    data.get("rating", "4.8"),
                    stock,
                    json.dumps(size_rows),
                    product_images[0],
                    json.dumps(product_images),
                    data.get("crop", "center"),
                    data.get("description", ""),
                    data.get("ai_type", "top"),
                    json.dumps(json_list(data.get("ai_images"))),
                    json.dumps(json_list(data.get("ai_prompts"))),
                    db_bool(data.get("active", True)),
                    now(),
                ),
            )
            conn.commit()
            conn.close()
            return self.send_json(201, {"ok": True})

        if path.startswith("/api/admin/products/") and path.endswith("/ai-pack") and method == "POST":
            product_id = int(path.split("/")[-2])
            data = self.body()
            product = cur.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
            if not product:
                conn.close()
                return self.send_json(404, {"error": "Product not found"})
            product = dict(product)
            ai_type = data.get("ai_type") or product.get("ai_type") or "top"
            model_reference = cur.execute("SELECT value FROM settings WHERE key = 'ai_model_reference'").fetchone()
            prompts = ai_product_prompts(product, ai_type, bool(model_reference and model_reference["value"]))
            stored_key = cur.execute("SELECT value FROM settings WHERE key = 'openai_api_key'").fetchone()
            api_key = os.environ.get("OPENAI_API_KEY", "").strip() or (stored_key["value"].strip() if stored_key and stored_key["value"] else "")
            generated_images = []
            ai_error = ""
            try:
                generated_images = generate_ai_images(prompts, api_key)
            except urllib.error.HTTPError as exc:
                try:
                    ai_error = exc.read().decode("utf-8")
                except Exception:
                    ai_error = str(exc)
            except (urllib.error.URLError, TimeoutError, ValueError, KeyError, json.JSONDecodeError) as exc:
                ai_error = str(exc)
            images_to_store = generated_images or json_list(product.get("ai_images"))
            cur.execute(
                "UPDATE products SET ai_type = ?, ai_prompts = ?, ai_images = ? WHERE id = ?",
                (ai_type, json.dumps(prompts), json.dumps(images_to_store), product_id),
            )
            conn.commit()
            conn.close()
            friendly_error = friendly_ai_error(ai_error)
            if generated_images:
                ai_message = "AI images generated"
            elif friendly_error:
                ai_message = f"AI images were not generated: {friendly_error}"
            elif not api_key:
                ai_message = "OpenAI API key is missing"
            else:
                ai_message = "AI prompts saved, but no images were returned"
            return self.send_json(200, {
                "ok": True,
                "ai_type": ai_type,
                "prompts": prompts,
                "images": images_to_store,
                "generated": len(generated_images),
                "message": ai_message,
                "error": friendly_error,
            })

        if path.startswith("/api/admin/products/"):
            product_id = int(path.rsplit("/", 1)[1])
            if method == "PUT":
                data = self.body()
                product_images = product_image_list(data)
                size_rows = product_sizes(data)
                stock = product_total_stock(size_rows, data.get("stock", 0))
                cur.execute(
                    """
                    UPDATE products
                    SET category_id=?, name=?, price=?, old_price=?, badge=?, rating=?, stock=?, product_sizes=?, image=?, images=?, crop=?, description=?, ai_type=?, ai_images=?, ai_prompts=?, active=?
                    WHERE id=?
                    """,
                    (
                        int(data.get("category_id") or 1),
                        data.get("name", "Product"),
                        min(10, max(1, float(data.get("price", 1) or 1))),
                        float(data["old_price"]) if data.get("old_price") else None,
                        data.get("badge", ""),
                        data.get("rating", "4.8"),
                        stock,
                        json.dumps(size_rows),
                        product_images[0],
                        json.dumps(product_images),
                        data.get("crop", "center"),
                        data.get("description", ""),
                        data.get("ai_type", "top"),
                        json.dumps(json_list(data.get("ai_images"))),
                        json.dumps(json_list(data.get("ai_prompts"))),
                        db_bool(data.get("active", True)),
                        product_id,
                    ),
                )
            elif method == "DELETE":
                cur.execute("DELETE FROM products WHERE id = ?", (product_id,))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        if path == "/api/admin/ads" and method == "POST":
            data = self.body()
            cur.execute(
                "INSERT INTO ads (title, subtitle, button_text, link, image, active, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (data.get("title", "Ad"), data.get("subtitle", ""), data.get("button_text", "Shop Now"), data.get("link", "#/shop"), data.get("image", "assets/ai-hero.png"), db_bool(data.get("active", True)), int(data.get("sort_order", 0) or 0), now()),
            )
            conn.commit()
            conn.close()
            return self.send_json(201, {"ok": True})

        if path.startswith("/api/admin/ads/"):
            ad_id = int(path.rsplit("/", 1)[1])
            if method == "PUT":
                data = self.body()
                cur.execute(
                    "UPDATE ads SET title=?, subtitle=?, button_text=?, link=?, image=?, active=?, sort_order=? WHERE id=?",
                    (data.get("title", "Ad"), data.get("subtitle", ""), data.get("button_text", "Shop Now"), data.get("link", "#/shop"), data.get("image", "assets/ai-hero.png"), db_bool(data.get("active", True)), int(data.get("sort_order", 0) or 0), ad_id),
                )
            elif method == "DELETE":
                cur.execute("DELETE FROM ads WHERE id = ?", (ad_id,))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        if path.startswith("/api/admin/orders/") and method == "PUT":
            order_id = int(path.rsplit("/", 1)[1])
            data = self.body()
            status = data.get("status", "Processing")
            if status == "Cancelled":
                active_items = rows(cur.execute("SELECT * FROM order_items WHERE order_id = ? AND status != 'Cancelled'", (order_id,)))
                for item in active_items:
                    add_product_size_stock(cur, item["product_id"], item.get("size", ""), int(item.get("qty") or 0))
                cur.execute("UPDATE order_items SET qty = 0, status = 'Cancelled' WHERE order_id = ?", (order_id,))
                cur.execute("UPDATE orders SET status = 'Cancelled', total = 0 WHERE id = ?", (order_id,))
            else:
                cur.execute("UPDATE orders SET status = ? WHERE id = ?", (status, order_id))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        if path.startswith("/api/admin/order-items/") and method == "PUT":
            item_id = int(path.rsplit("/", 1)[1])
            data = self.body()
            item = cur.execute("SELECT * FROM order_items WHERE id = ?", (item_id,)).fetchone()
            if not item:
                conn.close()
                return self.send_json(404, {"error": "Order item not found"})
            item = dict(item)
            new_status = data.get("status", item.get("status") or "Processing")
            if new_status not in ("Processing", "Approved", "Cancelled"):
                new_status = "Processing"
            requested_qty = max(1, int(item.get("requested_qty") or item.get("qty") or 1))
            new_qty = min(requested_qty, max(0, int(data.get("qty", item.get("qty") or 0) or 0)))
            if new_status == "Cancelled":
                new_qty = 0

            old_reserved = int(item.get("qty") or 0) if item.get("status") != "Cancelled" else 0
            new_reserved = new_qty if new_status != "Cancelled" else 0
            stock_delta = old_reserved - new_reserved
            product = cur.execute("SELECT stock, name, product_sizes FROM products WHERE id = ?", (item["product_id"],)).fetchone()
            if not product:
                conn.close()
                return self.send_json(404, {"error": "Product not found"})
            size_rows = product_sizes(product)
            item_size = str(item.get("size", "") or "").strip().upper()
            if size_rows and item_size:
                size_row = next((row for row in size_rows if row["size"] == item_size), None)
                if stock_delta >= 0:
                    add_product_size_stock(cur, item["product_id"], item_size, stock_delta)
                else:
                    needed = abs(stock_delta)
                    if not size_row or int(size_row.get("stock") or 0) < needed:
                        conn.close()
                        available = int((size_row or {}).get("stock") or 0)
                        return self.send_json(409, {"error": f"Only {available} left for {product['name']} size {item_size}"})
                    size_row["stock"] = int(size_row.get("stock") or 0) - needed
                    cur.execute("UPDATE products SET stock = ?, product_sizes = ? WHERE id = ?", (product_total_stock(size_rows), json.dumps(size_rows), item["product_id"]))
            else:
                new_stock = int(product["stock"] or 0) + stock_delta
                if new_stock < 0:
                    conn.close()
                    return self.send_json(409, {"error": f"Not enough stock for {product['name']}"})
                cur.execute("UPDATE products SET stock = ? WHERE id = ?", (new_stock, item["product_id"]))
            sync_product_visibility(cur, item["product_id"])
            cur.execute("UPDATE order_items SET qty = ?, status = ? WHERE id = ?", (new_qty, new_status, item_id))
            recalc_order(cur, item["order_id"])
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        if path == "/api/admin/settings" and method == "PUT":
            data = self.body()
            for key, value in data.items():
                if key in ("information_links", "department_links") and not isinstance(value, str):
                    value = json.dumps(value)
                cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        conn.close()
        return self.send_json(404, {"error": "Route not found"})

    def serve_file(self, path):
        if path in ("", "/"):
            path = "/index.html"
        if path == "/admin":
            path = "/admin.html"
        file_path = os.path.abspath(os.path.join(ROOT, path.lstrip("/")))
        if not file_path.startswith(ROOT):
            self.send_response(403)
            self.end_headers()
            return
        if not os.path.exists(file_path):
            file_path = os.path.join(ROOT, "index.html")
        ctype = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        with open(file_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"ONE TEN server running on {HOST}:{PORT}")
    server.serve_forever()
