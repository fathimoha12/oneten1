const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const root = __dirname;
const dataFile = path.join(root, "data.json");
const port = Number(process.env.PORT || 4180);

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

function readData() {
  return JSON.parse(fs.readFileSync(dataFile, "utf8"));
}

function writeData(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function cleanProduct(input, fallbackId) {
  const price = Math.min(10, Math.max(1, Number(input.price) || 1));
  const oldPrice = input.oldPrice ? Math.max(price, Number(input.oldPrice)) : null;
  return {
    id: input.id || fallbackId,
    category: String(input.category || "T-Shirts").slice(0, 40),
    name: String(input.name || "ONE TEN Product").slice(0, 80),
    price,
    oldPrice,
    badge: String(input.badge || "").slice(0, 16),
    rating: String(input.rating || "4.8").slice(0, 8),
    stock: Math.max(0, Number(input.stock) || 0),
    image: String(input.image || "assets/ai-products.png").slice(0, 600),
    crop: String(input.crop || "center").slice(0, 40),
    description: String(input.description || "").slice(0, 220),
  };
}

async function handleApi(req, res, pathname) {
  const data = readData();

  if (req.method === "GET" && pathname === "/api/products") {
    return sendJson(res, 200, data.products);
  }

  if (req.method === "POST" && pathname === "/api/products") {
    const body = await readBody(req);
    const nextId = Math.max(0, ...data.products.map((product) => Number(product.id))) + 1;
    const product = cleanProduct(body, nextId);
    data.products.unshift(product);
    writeData(data);
    return sendJson(res, 201, product);
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch) {
    const id = Number(productMatch[1]);
    const index = data.products.findIndex((product) => Number(product.id) === id);
    if (index === -1) return sendJson(res, 404, { error: "Product not found" });

    if (req.method === "PUT") {
      const body = await readBody(req);
      data.products[index] = cleanProduct({ ...data.products[index], ...body, id }, id);
      writeData(data);
      return sendJson(res, 200, data.products[index]);
    }

    if (req.method === "DELETE") {
      const [removed] = data.products.splice(index, 1);
      writeData(data);
      return sendJson(res, 200, removed);
    }
  }

  if (req.method === "GET" && pathname === "/api/orders") {
    return sendJson(res, 200, data.orders);
  }

  if (req.method === "POST" && pathname === "/api/orders") {
    const body = await readBody(req);
    const nextId = Math.max(1000, ...data.orders.map((order) => Number(order.id))) + 1;
    const order = {
      id: nextId,
      customer: String(body.customer || "Guest").slice(0, 80),
      phone: String(body.phone || "").slice(0, 40),
      status: "Processing",
      total: Math.max(1, Number(body.total) || 1),
      items: Math.max(1, Number(body.items) || 1),
      date: new Date().toISOString().slice(0, 10),
    };
    data.orders.unshift(order);
    writeData(data);
    return sendJson(res, 201, order);
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && req.method === "PUT") {
    const id = Number(orderMatch[1]);
    const index = data.orders.findIndex((order) => Number(order.id) === id);
    if (index === -1) return sendJson(res, 404, { error: "Order not found" });
    const body = await readBody(req);
    data.orders[index] = { ...data.orders[index], ...body, id };
    writeData(data);
    return sendJson(res, 200, data.orders[index]);
  }

  if (req.method === "GET" && pathname === "/api/dashboard") {
    const revenue = data.orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
    return sendJson(res, 200, {
      products: data.products.length,
      orders: data.orders.length,
      revenue,
      lowStock: data.products.filter((product) => Number(product.stock) <= 12).length,
      settings: data.settings,
    });
  }

  return sendJson(res, 404, { error: "API route not found" });
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(root, safePath));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(root, "index.html"), (indexError, indexContent) => {
        if (indexError) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(indexContent);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);

  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ONE TEN backend running at http://127.0.0.1:${port}`);
});
