const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { Pool } = require("pg");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4181);
const HOST = process.env.HOST || "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SECRET_SETTING_KEYS = new Set(["openai_api_key"]);

if (!DATABASE_URL.trim()) {
  console.warn("DATABASE_URL is missing. Add your Supabase/Postgres connection string on Render.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.trim() && process.env.PGSSL !== "false" ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 6),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

let databaseStartupError = "";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");
}

function token() {
  return crypto.randomBytes(24).toString("hex");
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["", "0", "false", "no", "off"].includes(value.toLowerCase());
  return !!value;
}

function jsonList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object") return Array.isArray(value) ? value : [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function productImageList(data = {}) {
  const rawImages = jsonList(data.images);
  const images = rawImages.map((item) => String(item || "").trim()).filter(Boolean);
  const primary = String(data.image || "").trim();
  if (primary) images.unshift(primary);
  return [...new Set(images)].filter(Boolean).length ? [...new Set(images)].filter(Boolean) : ["assets/ai-products.png"];
}

function productSizes(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value && value.product_sizes)
      ? value.product_sizes
      : jsonList(value && value.product_sizes);
  const clean = new Map();
  source.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const size = String(item.size || "").trim().toUpperCase();
    const stock = Math.max(0, Number.parseInt(item.stock || 0, 10) || 0);
    if (size) clean.set(size, (clean.get(size) || 0) + stock);
  });
  return [...clean.entries()].map(([size, stock]) => ({ size, stock }));
}

function productTotalStock(sizeRows, fallback = 0) {
  return sizeRows.length ? sizeRows.reduce((sum, item) => sum + Number(item.stock || 0), 0) : Math.max(0, Number.parseInt(fallback || 0, 10) || 0);
}

function publicSizeRows(sizeRows) {
  return sizeRows.filter((item) => Number(item.stock || 0) > 0);
}

function publicProductRecord(product, full = false) {
  if (!product) return null;
  const sizes = publicSizeRows(productSizes(product));
  if (productSizes(product).length && !sizes.length) return null;
  const gallery = jsonList(product.ai_images).length ? jsonList(product.ai_images) : productImageList(product);
  const image = gallery[0] || "assets/ai-products.png";
  const clean = {
    id: product.id,
    category_id: product.category_id,
    category: product.category,
    name: product.name,
    price: Number(product.price),
    old_price: product.old_price === null || product.old_price === undefined ? null : Number(product.old_price),
    badge: product.badge || "",
    rating: product.rating || "4.8",
    stock: productTotalStock(sizes, product.stock),
    product_sizes: sizes,
    image,
    images: [image],
    crop: product.crop || "center",
    description: product.description || "",
    active: product.active,
  };
  if (full) {
    clean.images = gallery;
    clean.ai_images = jsonList(product.ai_images);
    clean.ai_prompts = jsonList(product.ai_prompts);
    clean.ai_type = product.ai_type || "top";
  }
  return clean;
}

function adminProductRecord(product) {
  const sizes = productSizes(product);
  const gallery = jsonList(product.ai_images).length ? jsonList(product.ai_images) : productImageList(product);
  return {
    ...product,
    price: Number(product.price),
    old_price: product.old_price === null || product.old_price === undefined ? null : Number(product.old_price),
    product_sizes: sizes,
    stock: productTotalStock(sizes, product.stock),
    images: gallery,
    image: gallery[0] || "assets/ai-products.png",
    ai_images: jsonList(product.ai_images),
    ai_prompts: jsonList(product.ai_prompts),
  };
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "").trim();
}

function getAuthToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.replace("Bearer ", "").trim() : "";
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

async function withClient(callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function initDb() {
  if (!DATABASE_URL.trim()) return;
  if (process.env.INIT_DB_ON_START !== "1") {
    await query("SELECT 1");
    return;
  }
  const schemaPath = path.join(ROOT, "supabase_schema.sql");
  if (fs.existsSync(schemaPath)) {
    await query(fs.readFileSync(schemaPath, "utf8"));
  }
}

async function requireSession(req, userType) {
  const authToken = getAuthToken(req);
  if (!authToken) return null;
  const session = await query("SELECT * FROM sessions WHERE token = $1 AND user_type = $2", [authToken, userType]);
  if (!session.rows[0]) return null;
  const table = userType === "admin" ? "admin_users" : "customers";
  const user = await query(`SELECT * FROM ${table} WHERE id = $1`, [session.rows[0].user_id]);
  return user.rows[0] || null;
}

async function publicPayload(includeProducts = false) {
  const [categories, ads, settingsRows] = await Promise.all([
    query("SELECT * FROM categories ORDER BY sort_order, name"),
    query("SELECT * FROM ads WHERE active = true ORDER BY sort_order, id"),
    query("SELECT key, value FROM settings"),
  ]);
  const settings = {};
  const rawSettings = {};
  settingsRows.rows.forEach((row) => {
    rawSettings[row.key] = row.value;
    if (!SECRET_SETTING_KEYS.has(row.key)) settings[row.key] = row.value;
  });
  ["information_links", "department_links"].forEach((key) => {
    settings[key] = jsonList(settings[key]);
  });
  settings.openai_api_configured = (process.env.OPENAI_API_KEY || rawSettings.openai_api_key || "").trim() ? "1" : "";
  const payload = {
    categories: categories.rows,
    products: [],
    ads: ads.rows,
    settings,
  };
  if (includeProducts) payload.products = await publicProducts();
  return payload;
}

async function publicProducts() {
  const products = await query(
    `SELECT p.*, c.name AS category
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.active = true AND COALESCE(p.stock, 0) > 0
     ORDER BY p.id DESC`
  );
  return products.rows.map((product) => publicProductRecord(product, false)).filter(Boolean);
}

async function syncProductVisibility(client, productId) {
  const product = await client.query("SELECT stock, product_sizes FROM products WHERE id = $1", [productId]);
  if (!product.rows[0]) return;
  const sizes = productSizes(product.rows[0]);
  const stock = productTotalStock(sizes, product.rows[0].stock);
  await client.query("UPDATE products SET stock = $1, active = $2 WHERE id = $3", [stock, stock > 0, productId]);
}

async function addProductSizeStock(client, productId, size, qty) {
  const amount = Number.parseInt(qty || 0, 10) || 0;
  if (amount <= 0) return;
  const product = await client.query("SELECT stock, product_sizes FROM products WHERE id = $1", [productId]);
  if (!product.rows[0]) return;
  const sizes = productSizes(product.rows[0]);
  const selected = String(size || "").trim().toUpperCase();
  if (sizes.length && selected) {
    const match = sizes.find((item) => item.size === selected);
    if (match) match.stock += amount;
    else sizes.push({ size: selected, stock: amount });
    await client.query("UPDATE products SET stock = $1, product_sizes = $2::jsonb WHERE id = $3", [productTotalStock(sizes), JSON.stringify(sizes), productId]);
  } else {
    await client.query("UPDATE products SET stock = COALESCE(stock, 0) + $1 WHERE id = $2", [amount, productId]);
  }
  await syncProductVisibility(client, productId);
}

async function recalcOrder(client, orderId) {
  const total = await client.query("SELECT COALESCE(SUM(price * qty), 0) AS total FROM order_items WHERE order_id = $1 AND status != 'Cancelled'", [orderId]);
  const items = await client.query("SELECT status FROM order_items WHERE order_id = $1", [orderId]);
  const activeItems = items.rows.filter((item) => item.status !== "Cancelled");
  let status = "Processing";
  if (!items.rows.length || !activeItems.length) status = "Cancelled";
  else if (activeItems.every((item) => item.status === "Approved")) status = "Approved";
  await client.query("UPDATE orders SET total = $1, status = $2 WHERE id = $3", [Number(total.rows[0].total || 0), status, orderId]);
}

const aiTypeLabels = {
  top: "shirt, t-shirt, jacket, hoodie, or upper-body garment",
  pants: "pants, trousers, jeans, shorts, or lower-body garment",
  outfit: "full outfit, suit, tracksuit, or complete coordinated look",
  shoes: "shoes, sneakers, sandals, or footwear",
  watch: "watch, bracelet, ring, or small accessory",
  accessory: "cap, belt, bag, sunglasses, or men's accessory",
};

function aiProductPrompts(product, aiType, hasModelReference = false) {
  const model = `same stylish young Black male model as the reference portrait, clean shaped beard, modern curly afro, confident professional fashion pose${hasModelReference ? ", preserve the uploaded AI model reference identity and grooming style" : ""}`;
  const rules = {
    top: "focus on the upper garment; crop around chest and torso; pants are neutral and not advertised",
    pants: "focus on lower body first; if torso appears, shirtless athletic upper body with a clean six-pack, no shirt promotion",
    outfit: "show full-body styling, complete outfit visible, fashion campaign pose",
    shoes: "focus on footwear, low-angle shoe detail, model styling supports the shoes",
    watch: "close detail on wrist/hand accessory, luxury men's fashion framing",
    accessory: "focus on the exact accessory placement and use, clean men's fashion styling",
  };
  const type = aiTypeLabels[aiType] || aiTypeLabels.top;
  const focus = rules[aiType] || rules.top;
  const base = `${product.name || "ONE TEN product"}. ${product.description || ""}. Product type: ${type}. ${focus}.`;
  return [
    `Studio ecommerce hero on smooth light gray background, ultra clean product advertisement, ${model}, ${base}`,
    `Sharp catalog detail shot, product texture and cut in focus, soft gray studio lighting, ${model}, ${base}`,
    `Premium lifestyle streetwear scene, red white black ONE TEN color mood, natural confident pose, ${model}, ${base}`,
    `Editorial men's fashion campaign, clean shadows, high-end online shop look, ${model}, ${base}`,
    `Social ad crop, bold modern composition, product clearly visible, professional retouched finish, ${model}, ${base}`,
  ];
}

async function generateAiImages(prompts, apiKey) {
  const key = String(apiKey || process.env.OPENAI_API_KEY || "").trim();
  if (!key) return [];
  const images = [];
  for (const prompt of prompts) {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
        prompt,
        size: "1024x1024",
        quality: process.env.OPENAI_IMAGE_QUALITY || "low",
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    const image = (payload.data || [])[0] || {};
    if (image.b64_json) images.push(`data:image/png;base64,${image.b64_json}`);
    else if (image.url) images.push(image.url);
  }
  return images;
}

function friendlyAiError(errorText) {
  if (!errorText) return "";
  try {
    const payload = JSON.parse(errorText);
    const code = payload.error && payload.error.code;
    const message = payload.error && payload.error.message;
    if (code === "insufficient_quota") return "OpenAI credit/quota is finished. Add billing credit or use another API key.";
    return message || String(errorText).slice(0, 220);
  } catch {
    return String(errorText).slice(0, 220);
  }
}

function sendJson(req, res, status, payload) {
  let body = Buffer.from(JSON.stringify(payload), "utf8");
  const useGzip = (req.headers["accept-encoding"] || "").includes("gzip") && body.length > 1024;
  if (useGzip) body = zlib.gzipSync(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...(useGzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
    "Content-Length": body.length,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 18_000_000) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function cors(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

async function handleGet(req, res, pathname) {
  if (pathname === "/api/health") {
    return sendJson(req, res, 200, {
      ok: !databaseStartupError,
      runtime: "node",
      database: DATABASE_URL.trim() ? (databaseStartupError ? "error" : "configured") : "missing",
      error: databaseStartupError,
    });
  }
  if (pathname === "/api/public/bootstrap") return sendJson(req, res, 200, await publicPayload(false));
  if (pathname === "/api/public/products") return sendJson(req, res, 200, { products: await publicProducts() });

  const publicProductMatch = pathname.match(/^\/api\/public\/products\/(\d+)$/);
  if (publicProductMatch) {
    const result = await query(
      `SELECT p.*, c.name AS category
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.active = true AND COALESCE(p.stock, 0) > 0`,
      [Number(publicProductMatch[1])]
    );
    const product = publicProductRecord(result.rows[0], true);
    return product ? sendJson(req, res, 200, { product }) : sendJson(req, res, 404, { error: "Product not found" });
  }

  if (pathname === "/api/customer/me") {
    const user = await requireSession(req, "customer");
    if (!user) return sendJson(req, res, 401, { error: "Login required" });
    return sendJson(req, res, 200, { id: user.id, name: user.name, email: user.email });
  }

  if (pathname === "/api/customer/orders") {
    const user = await requireSession(req, "customer");
    if (!user) return sendJson(req, res, 401, { error: "Login required" });
    const orders = await query("SELECT * FROM orders WHERE customer_id = $1 ORDER BY id DESC", [user.id]);
    const items = await query(
      `SELECT oi.*
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.customer_id = $1
       ORDER BY oi.order_id DESC, oi.id`,
      [user.id]
    );
    const byOrder = new Map();
    items.rows.forEach((item) => {
      if (!byOrder.has(String(item.order_id))) byOrder.set(String(item.order_id), []);
      byOrder.get(String(item.order_id)).push(item);
    });
    return sendJson(req, res, 200, { orders: orders.rows.map((order) => ({ ...order, order_items: byOrder.get(String(order.id)) || [] })) });
  }

  if (pathname.startsWith("/api/admin/")) {
    const admin = await requireSession(req, "admin");
    if (!admin) return sendJson(req, res, 401, { error: "Admin login required" });
    if (pathname === "/api/admin/bootstrap") {
      const payload = await publicPayload(false);
      const [products, orders, subscribers, orderItems, revenue] = await Promise.all([
        query(`SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC`),
        query(`SELECT o.*, COUNT(oi.id) AS items FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id GROUP BY o.id ORDER BY o.id DESC`),
        query("SELECT * FROM newsletter_subscribers ORDER BY id DESC"),
        query("SELECT * FROM order_items ORDER BY order_id DESC, id"),
        query("SELECT COALESCE(SUM(total), 0) AS total FROM orders"),
      ]);
      const byOrder = new Map();
      orderItems.rows.forEach((item) => {
        if (!byOrder.has(String(item.order_id))) byOrder.set(String(item.order_id), []);
        byOrder.get(String(item.order_id)).push(item);
      });
      payload.products = products.rows.map(adminProductRecord);
      payload.orders = orders.rows.map((order) => ({ ...order, order_items: byOrder.get(String(order.id)) || [] }));
      payload.subscribers = subscribers.rows;
      payload.dashboard = {
        products: payload.products.length,
        categories: payload.categories.length,
        ads: payload.ads.length,
        orders: payload.orders.length,
        subscribers: payload.subscribers.length,
        revenue: Number(revenue.rows[0].total || 0),
        lowStock: payload.products.filter((product) => Number(product.stock || 0) <= 12).length,
      };
      return sendJson(req, res, 200, payload);
    }
  }

  return sendJson(req, res, 404, { error: "Route not found" });
}

async function handlePostPutDelete(req, res, method, pathname) {
  const data = await readBody(req);

  if (method === "POST" && pathname === "/api/customer/register") {
    try {
      const inserted = await query(
        "INSERT INTO customers (name, email, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
        [data.name || "Customer", String(data.email || "").toLowerCase(), hashPassword(data.password), now()]
      );
      const customerId = inserted.rows[0].id;
      const authToken = token();
      await query("INSERT INTO sessions (token, user_type, user_id, created_at) VALUES ($1, 'customer', $2, $3)", [authToken, customerId, now()]);
      return sendJson(req, res, 201, { token: authToken, user: { id: customerId, name: data.name || "Customer", email: String(data.email || "").toLowerCase() } });
    } catch (error) {
      if (error.code === "23505") return sendJson(req, res, 409, { error: "Email already exists" });
      throw error;
    }
  }

  if (method === "POST" && pathname === "/api/customer/login") {
    const user = await query("SELECT * FROM customers WHERE email = $1 AND password_hash = $2", [String(data.email || "").toLowerCase(), hashPassword(data.password)]);
    if (!user.rows[0]) return sendJson(req, res, 401, { error: "Wrong email or password" });
    const authToken = token();
    await query("INSERT INTO sessions (token, user_type, user_id, created_at) VALUES ($1, 'customer', $2, $3)", [authToken, user.rows[0].id, now()]);
    return sendJson(req, res, 200, { token: authToken, user: { id: user.rows[0].id, name: user.rows[0].name, email: user.rows[0].email } });
  }

  if (method === "POST" && pathname === "/api/admin/login") {
    const user = await query("SELECT * FROM admin_users WHERE username = $1 AND password_hash = $2", [data.username || "", hashPassword(data.password)]);
    if (!user.rows[0]) return sendJson(req, res, 401, { error: "Wrong admin username or password" });
    const authToken = token();
    await query("INSERT INTO sessions (token, user_type, user_id, created_at) VALUES ($1, 'admin', $2, $3)", [authToken, user.rows[0].id, now()]);
    return sendJson(req, res, 200, { token: authToken, admin: { id: user.rows[0].id, username: user.rows[0].username } });
  }

  if (method === "POST" && pathname === "/api/orders") {
    const customer = await requireSession(req, "customer");
    if (!customer) return sendJson(req, res, 401, { error: "Register or sign in before ordering" });
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return sendJson(req, res, 400, { error: "Cart is empty" });
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const ids = [...new Set(items.map((item) => Number(item.id)).filter(Boolean))];
        const products = await client.query("SELECT * FROM products WHERE id = ANY($1::bigint[]) FOR UPDATE", [ids]);
        const productMap = new Map(products.rows.map((product) => [String(product.id), product]));
        let total = 0;
        const prepared = [];
        for (const item of items) {
          const product = productMap.get(String(item.id));
          if (!product) continue;
          const qty = Math.max(1, Number.parseInt(item.qty || 1, 10) || 1);
          const selectedSize = String(item.size || "").trim().toUpperCase();
          const sizes = productSizes(product);
          const stock = productTotalStock(sizes, product.stock);
          if (!product.active || stock <= 0) throw Object.assign(new Error(`${product.name} is out of stock`), { status: 409 });
          if (sizes.length) {
            const sizeRow = sizes.find((row) => row.size === selectedSize);
            if (!selectedSize || !sizeRow || Number(sizeRow.stock || 0) <= 0) throw Object.assign(new Error(`Size ${selectedSize || "selected"} is not available for ${product.name}`), { status: 409 });
            if (qty > Number(sizeRow.stock || 0)) throw Object.assign(new Error(`Only ${sizeRow.stock} left for ${product.name} size ${selectedSize}`), { status: 409 });
          } else if (qty > stock) {
            throw Object.assign(new Error(`Only ${stock} left for ${product.name}`), { status: 409 });
          }
          total += Number(product.price) * qty;
          prepared.push({ product, qty, selectedSize, sizes });
        }
        const order = await client.query(
          "INSERT INTO orders (customer_id, customer_name, phone, address, status, total, created_at) VALUES ($1, $2, $3, $4, 'Processing', $5, $6) RETURNING id",
          [customer.id, customer.name, data.phone || "", data.address || "", total, now()]
        );
        const orderId = order.rows[0].id;
        for (const item of prepared) {
          await client.query(
            "INSERT INTO order_items (order_id, product_id, product_name, product_image, price, requested_qty, qty, size, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Processing')",
            [orderId, item.product.id, item.product.name, item.product.image, item.product.price, item.qty, item.qty, item.selectedSize]
          );
          if (item.sizes.length) {
            const row = item.sizes.find((size) => size.size === item.selectedSize);
            row.stock = Math.max(0, Number(row.stock || 0) - item.qty);
            await client.query("UPDATE products SET stock = $1, product_sizes = $2::jsonb WHERE id = $3", [productTotalStock(item.sizes), JSON.stringify(item.sizes), item.product.id]);
          } else {
            await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [item.qty, item.product.id]);
          }
          await syncProductVisibility(client, item.product.id);
        }
        await client.query("COMMIT");
        return sendJson(req, res, 201, { id: orderId, total, status: "Processing" });
      } catch (error) {
        await client.query("ROLLBACK");
        return sendJson(req, res, error.status || 500, { error: error.message || "Order failed" });
      }
    });
  }

  if (method === "POST" && pathname === "/api/newsletter") {
    const phone = normalizePhone(data.phone);
    if (phone.length < 7) return sendJson(req, res, 400, { error: "Enter a valid phone number" });
    try {
      await query("INSERT INTO newsletter_subscribers (phone, created_at) VALUES ($1, $2)", [phone, now()]);
      return sendJson(req, res, 201, { ok: true });
    } catch (error) {
      if (error.code === "23505") return sendJson(req, res, 409, { error: "This phone number is already subscribed" });
      throw error;
    }
  }

  const admin = pathname.startsWith("/api/admin/") ? await requireSession(req, "admin") : null;
  if (pathname.startsWith("/api/admin/") && !admin) return sendJson(req, res, 401, { error: "Admin login required" });

  if (pathname === "/api/admin/categories" && method === "POST") {
    await query("INSERT INTO categories (name, description, price_mode, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)", [data.name || "Category", data.description || "", data.price_mode || "range", Number.parseInt(data.sort_order || 0, 10) || 0, now()]);
    return sendJson(req, res, 201, { ok: true });
  }

  const categoryMatch = pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (categoryMatch) {
    const id = Number(categoryMatch[1]);
    if (method === "PUT") await query("UPDATE categories SET name = $1, description = $2, price_mode = $3, sort_order = $4 WHERE id = $5", [data.name || "Category", data.description || "", data.price_mode || "range", Number.parseInt(data.sort_order || 0, 10) || 0, id]);
    if (method === "DELETE") await query("DELETE FROM categories WHERE id = $1", [id]);
    return sendJson(req, res, 200, { ok: true });
  }

  if (pathname === "/api/admin/products" && method === "POST") {
    const images = productImageList(data);
    const sizes = productSizes(data);
    await query(
      `INSERT INTO products
       (category_id, name, price, old_price, badge, rating, stock, product_sizes, image, images, crop, description, ai_type, ai_images, ai_prompts, active, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17)`,
      [
        Number(data.category_id || 1),
        data.name || "Product",
        Math.min(10, Math.max(1, Number(data.price) || 1)),
        data.old_price ? Number(data.old_price) : null,
        data.badge || "",
        data.rating || "4.8",
        productTotalStock(sizes, data.stock),
        JSON.stringify(sizes),
        images[0],
        JSON.stringify(images),
        data.crop || "center",
        data.description || "",
        data.ai_type || "top",
        JSON.stringify(jsonList(data.ai_images)),
        JSON.stringify(jsonList(data.ai_prompts)),
        toBool(data.active !== undefined ? data.active : true),
        now(),
      ]
    );
    return sendJson(req, res, 201, { ok: true });
  }

  const aiPackMatch = pathname.match(/^\/api\/admin\/products\/(\d+)\/ai-pack$/);
  if (aiPackMatch && method === "POST") {
    const productId = Number(aiPackMatch[1]);
    const product = await query("SELECT * FROM products WHERE id = $1", [productId]);
    if (!product.rows[0]) return sendJson(req, res, 404, { error: "Product not found" });
    const aiType = data.ai_type || product.rows[0].ai_type || "top";
    const reference = await query("SELECT value FROM settings WHERE key = 'ai_model_reference'");
    const prompts = aiProductPrompts(product.rows[0], aiType, Boolean(reference.rows[0] && reference.rows[0].value));
    const storedKey = await query("SELECT value FROM settings WHERE key = 'openai_api_key'");
    const apiKey = (process.env.OPENAI_API_KEY || (storedKey.rows[0] && storedKey.rows[0].value) || "").trim();
    let generatedImages = [];
    let aiError = "";
    try {
      generatedImages = await generateAiImages(prompts, apiKey);
    } catch (error) {
      aiError = error.message || String(error);
    }
    const imagesToStore = generatedImages.length ? generatedImages : jsonList(product.rows[0].ai_images);
    await query("UPDATE products SET ai_type = $1, ai_prompts = $2::jsonb, ai_images = $3::jsonb WHERE id = $4", [aiType, JSON.stringify(prompts), JSON.stringify(imagesToStore), productId]);
    const friendly = friendlyAiError(aiError);
    return sendJson(req, res, 200, {
      ok: true,
      ai_type: aiType,
      prompts,
      images: imagesToStore,
      generated: generatedImages.length,
      message: generatedImages.length ? "AI images generated" : friendly ? `AI images were not generated: ${friendly}` : !apiKey ? "OpenAI API key is missing" : "AI prompts saved, but no images were returned",
      error: friendly,
    });
  }

  const productMatch = pathname.match(/^\/api\/admin\/products\/(\d+)$/);
  if (productMatch) {
    const id = Number(productMatch[1]);
    if (method === "PUT") {
      const images = productImageList(data);
      const sizes = productSizes(data);
      await query(
        `UPDATE products
         SET category_id=$1, name=$2, price=$3, old_price=$4, badge=$5, rating=$6, stock=$7, product_sizes=$8::jsonb, image=$9, images=$10::jsonb, crop=$11, description=$12, ai_type=$13, ai_images=$14::jsonb, ai_prompts=$15::jsonb, active=$16
         WHERE id=$17`,
        [Number(data.category_id || 1), data.name || "Product", Math.min(10, Math.max(1, Number(data.price) || 1)), data.old_price ? Number(data.old_price) : null, data.badge || "", data.rating || "4.8", productTotalStock(sizes, data.stock), JSON.stringify(sizes), images[0], JSON.stringify(images), data.crop || "center", data.description || "", data.ai_type || "top", JSON.stringify(jsonList(data.ai_images)), JSON.stringify(jsonList(data.ai_prompts)), toBool(data.active !== undefined ? data.active : true), id]
      );
    }
    if (method === "DELETE") await query("DELETE FROM products WHERE id = $1", [id]);
    return sendJson(req, res, 200, { ok: true });
  }

  if (pathname === "/api/admin/ads" && method === "POST") {
    await query("INSERT INTO ads (title, subtitle, button_text, link, image, active, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [data.title || "Ad", data.subtitle || "", data.button_text || "Shop Now", data.link || "#/shop", data.image || "assets/ai-hero.png", toBool(data.active !== undefined ? data.active : true), Number.parseInt(data.sort_order || 0, 10) || 0, now()]);
    return sendJson(req, res, 201, { ok: true });
  }

  const adMatch = pathname.match(/^\/api\/admin\/ads\/(\d+)$/);
  if (adMatch) {
    const id = Number(adMatch[1]);
    if (method === "PUT") await query("UPDATE ads SET title=$1, subtitle=$2, button_text=$3, link=$4, image=$5, active=$6, sort_order=$7 WHERE id=$8", [data.title || "Ad", data.subtitle || "", data.button_text || "Shop Now", data.link || "#/shop", data.image || "assets/ai-hero.png", toBool(data.active !== undefined ? data.active : true), Number.parseInt(data.sort_order || 0, 10) || 0, id]);
    if (method === "DELETE") await query("DELETE FROM ads WHERE id = $1", [id]);
    return sendJson(req, res, 200, { ok: true });
  }

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (orderMatch && method === "PUT") {
    const orderId = Number(orderMatch[1]);
    const status = data.status || "Processing";
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        if (status === "Cancelled") {
          const activeItems = await client.query("SELECT * FROM order_items WHERE order_id = $1 AND status != 'Cancelled'", [orderId]);
          for (const item of activeItems.rows) await addProductSizeStock(client, item.product_id, item.size || "", Number(item.qty || 0));
          await client.query("UPDATE order_items SET qty = 0, status = 'Cancelled' WHERE order_id = $1", [orderId]);
          await client.query("UPDATE orders SET status = 'Cancelled', total = 0 WHERE id = $1", [orderId]);
        } else {
          await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, orderId]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    return sendJson(req, res, 200, { ok: true });
  }

  const orderItemMatch = pathname.match(/^\/api\/admin\/order-items\/(\d+)$/);
  if (orderItemMatch && method === "PUT") {
    const itemId = Number(orderItemMatch[1]);
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const itemResult = await client.query("SELECT * FROM order_items WHERE id = $1", [itemId]);
        const item = itemResult.rows[0];
        if (!item) throw Object.assign(new Error("Order item not found"), { status: 404 });
        let newStatus = data.status || item.status || "Processing";
        if (!["Processing", "Approved", "Cancelled"].includes(newStatus)) newStatus = "Processing";
        const requestedQty = Math.max(1, Number.parseInt(item.requested_qty || item.qty || 1, 10) || 1);
        let newQty = Math.min(requestedQty, Math.max(0, Number.parseInt(data.qty !== undefined ? data.qty : item.qty || 0, 10) || 0));
        if (newStatus === "Cancelled") newQty = 0;
        const oldReserved = item.status !== "Cancelled" ? Number(item.qty || 0) : 0;
        const newReserved = newStatus !== "Cancelled" ? newQty : 0;
        const stockDelta = oldReserved - newReserved;
        const productResult = await client.query("SELECT stock, name, product_sizes FROM products WHERE id = $1 FOR UPDATE", [item.product_id]);
        const product = productResult.rows[0];
        if (!product) throw Object.assign(new Error("Product not found"), { status: 404 });
        const sizes = productSizes(product);
        const itemSize = String(item.size || "").trim().toUpperCase();
        if (sizes.length && itemSize) {
          const sizeRow = sizes.find((row) => row.size === itemSize);
          if (stockDelta >= 0) {
            await addProductSizeStock(client, item.product_id, itemSize, stockDelta);
          } else {
            const needed = Math.abs(stockDelta);
            if (!sizeRow || Number(sizeRow.stock || 0) < needed) throw Object.assign(new Error(`Only ${Number(sizeRow && sizeRow.stock || 0)} left for ${product.name} size ${itemSize}`), { status: 409 });
            sizeRow.stock = Number(sizeRow.stock || 0) - needed;
            await client.query("UPDATE products SET stock = $1, product_sizes = $2::jsonb WHERE id = $3", [productTotalStock(sizes), JSON.stringify(sizes), item.product_id]);
          }
        } else {
          const newStock = Number(product.stock || 0) + stockDelta;
          if (newStock < 0) throw Object.assign(new Error(`Not enough stock for ${product.name}`), { status: 409 });
          await client.query("UPDATE products SET stock = $1 WHERE id = $2", [newStock, item.product_id]);
        }
        await syncProductVisibility(client, item.product_id);
        await client.query("UPDATE order_items SET qty = $1, status = $2 WHERE id = $3", [newQty, newStatus, itemId]);
        await recalcOrder(client, item.order_id);
        await client.query("COMMIT");
        return sendJson(req, res, 200, { ok: true });
      } catch (error) {
        await client.query("ROLLBACK");
        return sendJson(req, res, error.status || 500, { error: error.message || "Order item update failed" });
      }
    });
  }

  if (pathname === "/api/admin/settings" && method === "PUT") {
    for (const [key, rawValue] of Object.entries(data)) {
      const value = Array.isArray(rawValue) || (rawValue && typeof rawValue === "object") ? JSON.stringify(rawValue) : String(rawValue);
      await query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
    }
    return sendJson(req, res, 200, { ok: true });
  }

  return sendJson(req, res, 404, { error: "Route not found" });
}

function serveStatic(req, res, pathname) {
  let safePath = pathname === "/" ? "/index.html" : pathname;
  if (safePath === "/admin") safePath = "/admin.html";
  const filePath = path.normalize(path.join(ROOT, safePath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (error, content) => {
    const finalPath = error ? path.join(ROOT, "index.html") : filePath;
    fs.readFile(finalPath, (indexError, finalContent) => {
      if (indexError) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(finalPath).toLowerCase();
      res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
      res.end(error ? finalContent : content);
    });
  });
}

let initPromise = null;

function ensureInit() {
  if (!initPromise) {
    initPromise = initDb().catch((error) => {
      databaseStartupError = error.message || String(error);
      console.error("Database startup check failed:", databaseStartupError);
    });
  }
  return initPromise;
}

async function handleRequest(req, res) {
  await ensureInit();
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname);
  try {
    if (req.method === "OPTIONS") return cors(res);
    if (pathname.startsWith("/api/")) {
      if (!DATABASE_URL.trim()) return sendJson(req, res, 500, { error: "DATABASE_URL is missing on the backend host" });
      if (req.method === "GET") return await handleGet(req, res, pathname);
      if (["POST", "PUT", "DELETE"].includes(req.method)) return await handlePostPutDelete(req, res, req.method, pathname);
      return sendJson(req, res, 405, { error: "Method not allowed" });
    }
    return serveStatic(req, res, pathname);
  } catch (error) {
    return sendJson(req, res, error.status || 500, { error: error.message || "Server error" });
  }
}

function startServer() {
  ensureInit().finally(() => {
    const server = http.createServer(handleRequest);
    server.listen(PORT, HOST, () => {
      console.log(`ONE TEN Node backend running on ${HOST}:${PORT}`);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = handleRequest;
