from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import hashlib
import json
import mimetypes
import os
import secrets
import sqlite3
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, "oneten.sqlite3")
PORT = int(os.environ.get("PORT", "4181"))


def now():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def hash_password(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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


def normalize_phone(phone):
    value = str(phone or "").strip()
    return "".join(ch for ch in value if ch.isdigit() or ch == "+")


def sync_product_visibility(cur, product_id):
    row = cur.execute("SELECT stock FROM products WHERE id = ?", (product_id,)).fetchone()
    if not row:
        return
    cur.execute("UPDATE products SET active = ? WHERE id = ?", (1 if int(row["stock"] or 0) > 0 else 0, product_id))


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
    conn = db()
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
          image TEXT NOT NULL,
          images TEXT DEFAULT '[]',
          crop TEXT DEFAULT 'center',
          description TEXT DEFAULT '',
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
    product_cols = [row["name"] for row in cur.execute("PRAGMA table_info(products)")]
    if "images" not in product_cols:
        cur.execute("ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'")

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
    for product in products:
        try:
            product["images"] = json.loads(product.get("images") or "[]")
        except json.JSONDecodeError:
            product["images"] = []
        product["images"] = product_image_list(product)
        product["image"] = product["images"][0]
    ads = rows(cur.execute("SELECT * FROM ads WHERE active = 1 ORDER BY sort_order, id"))
    settings = {row["key"]: row["value"] for row in cur.execute("SELECT key, value FROM settings")}
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

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
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
            return self.send_json(500, {"error": str(exc)})

    def do_POST(self):
        try:
            return self.handle_write_api("POST", urlparse(self.path).path)
        except Exception as exc:
            return self.send_json(500, {"error": str(exc)})

    def do_PUT(self):
        try:
            return self.handle_write_api("PUT", urlparse(self.path).path)
        except Exception as exc:
            return self.send_json(500, {"error": str(exc)})

    def do_DELETE(self):
        try:
            return self.handle_write_api("DELETE", urlparse(self.path).path)
        except Exception as exc:
            return self.send_json(500, {"error": str(exc)})

    def handle_get_api(self, path):
        if path == "/api/public/bootstrap":
            return self.send_json(200, public_payload())

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
                try:
                    product["images"] = json.loads(product.get("images") or "[]")
                except json.JSONDecodeError:
                    product["images"] = []
                product["images"] = product_image_list(product)
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
            except sqlite3.IntegrityError:
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
            product_ids = [int(item["id"]) for item in items]
            placeholders = ",".join("?" for _ in product_ids)
            products = {row["id"]: dict(row) for row in cur.execute(f"SELECT * FROM products WHERE id IN ({placeholders})", product_ids)}
            total = 0
            prepared_items = []
            for item in items:
                product = products.get(int(item["id"]))
                if product:
                    qty = max(1, int(item.get("qty", 1)))
                    stock = int(product.get("stock") or 0)
                    if product.get("active") != 1 or stock <= 0:
                        conn.close()
                        return self.send_json(409, {"error": f"{product['name']} is out of stock"})
                    if qty > stock:
                        conn.close()
                        return self.send_json(409, {"error": f"Only {stock} left for {product['name']}"})
                    total += float(product["price"]) * qty
                    prepared_items.append((product, qty))
            cur.execute(
                "INSERT INTO orders (customer_id, customer_name, phone, address, status, total, created_at) VALUES (?, ?, ?, ?, 'Processing', ?, ?)",
                (customer["id"], customer["name"], data.get("phone", ""), data.get("address", ""), total, now()),
            )
            order_id = cur.lastrowid
            for product, qty in prepared_items:
                cur.execute(
                    "INSERT INTO order_items (order_id, product_id, product_name, product_image, price, requested_qty, qty, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Processing')",
                    (order_id, product["id"], product["name"], product["image"], product["price"], qty, qty),
                )
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
            except sqlite3.IntegrityError:
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
            cur.execute(
                """
                INSERT INTO products
                (category_id, name, price, old_price, badge, rating, stock, image, images, crop, description, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(data.get("category_id") or 1),
                    data.get("name", "Product"),
                    min(10, max(1, float(data.get("price", 1) or 1))),
                    float(data["old_price"]) if data.get("old_price") else None,
                    data.get("badge", ""),
                    data.get("rating", "4.8"),
                    int(data.get("stock", 0) or 0),
                    product_images[0],
                    json.dumps(product_images),
                    data.get("crop", "center"),
                    data.get("description", ""),
                    1 if data.get("active", True) else 0,
                    now(),
                ),
            )
            conn.commit()
            conn.close()
            return self.send_json(201, {"ok": True})

        if path.startswith("/api/admin/products/"):
            product_id = int(path.rsplit("/", 1)[1])
            if method == "PUT":
                data = self.body()
                product_images = product_image_list(data)
                cur.execute(
                    """
                    UPDATE products
                    SET category_id=?, name=?, price=?, old_price=?, badge=?, rating=?, stock=?, image=?, images=?, crop=?, description=?, active=?
                    WHERE id=?
                    """,
                    (
                        int(data.get("category_id") or 1),
                        data.get("name", "Product"),
                        min(10, max(1, float(data.get("price", 1) or 1))),
                        float(data["old_price"]) if data.get("old_price") else None,
                        data.get("badge", ""),
                        data.get("rating", "4.8"),
                        int(data.get("stock", 0) or 0),
                        product_images[0],
                        json.dumps(product_images),
                        data.get("crop", "center"),
                        data.get("description", ""),
                        1 if data.get("active", True) else 0,
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
                (data.get("title", "Ad"), data.get("subtitle", ""), data.get("button_text", "Shop Now"), data.get("link", "#/shop"), data.get("image", "assets/ai-hero.png"), 1 if data.get("active", True) else 0, int(data.get("sort_order", 0) or 0), now()),
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
                    (data.get("title", "Ad"), data.get("subtitle", ""), data.get("button_text", "Shop Now"), data.get("link", "#/shop"), data.get("image", "assets/ai-hero.png"), 1 if data.get("active", True) else 0, int(data.get("sort_order", 0) or 0), ad_id),
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
                    cur.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (int(item.get("qty") or 0), item["product_id"]))
                    sync_product_visibility(cur, item["product_id"])
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
            product = cur.execute("SELECT stock, name FROM products WHERE id = ?", (item["product_id"],)).fetchone()
            if not product:
                conn.close()
                return self.send_json(404, {"error": "Product not found"})
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
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"ONE TEN SQL server running at http://127.0.0.1:{PORT}")
    server.serve_forever()
