const { useEffect, useState } = React;

function adminApi(path, options = {}) {
  const token = localStorage.getItem("adminToken");
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  if (typeof fetch === "function") {
    return fetch(path, { ...options, headers }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    });
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method || "GET", path, true);
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));
    request.onload = () => {
      let data = {};
      try {
        data = request.responseText ? JSON.parse(request.responseText) : {};
      } catch {
        data = {};
      }
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error || "Request failed"));
    };
    request.onerror = () => reject(new Error("Request failed"));
    request.send(options.body || null);
  });
}

function getProductImages(product) {
  const images = Array.isArray(product && product.images) ? product.images : [];
  const merged = [product && product.image, ...images].filter(Boolean);
  const clean = [];
  merged.forEach((image) => {
    if (!clean.includes(image)) clean.push(image);
  });
  return clean.length ? clean : ["assets/ai-products.png"];
}

function readImageFiles(files) {
  return Promise.all(Array.from(files || []).map((file) => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  })));
}

const defaultInformationLinks = [
  { label: "About Us", href: "#/about" },
  { label: "Contact Us", href: "#/contact" },
  { label: "Shop Grid", href: "#/shop" },
];

const defaultDepartmentLinks = [
  { label: "Shirts", href: "#/shop" },
  { label: "Accessories", href: "#/shop" },
  { label: "Admin Login", href: "/admin.html" },
];

function cleanLinks(value, fallback) {
  const rows = Array.isArray(value) && value.length ? value : fallback;
  return rows.map((link) => ({ label: link.label || "", href: link.href || "" }));
}

const emptyProduct = {
  category_id: "",
  name: "",
  price: "5",
  old_price: "",
  badge: "New",
  rating: "4.8",
  stock: "10",
  image: "assets/ai-products.png",
  images: [],
  crop: "center",
  description: "",
  active: true,
};

const emptyCategory = { name: "", description: "", price_mode: "range", sort_order: "0" };
const emptyAd = {
  title: "",
  subtitle: "",
  button_text: "Shop Now",
  link: "#/shop",
  image: "assets/ai-hero.png",
  active: true,
  sort_order: "0",
};

function AdminApp() {
  const [token, setToken] = useState(localStorage.getItem("adminToken") || "");
  const [username, setUsername] = useState("onetenadmin");
  const [password, setPassword] = useState("oneten");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState("products");
  const [data, setData] = useState({ products: [], categories: [], ads: [], orders: [], subscribers: [], dashboard: {}, settings: {} });

  useEffect(() => {
    if (token) refresh();
  }, [token]);

  useEffect(() => {
    if (!token) {
      adminApi("/api/public/bootstrap")
        .then((payload) => setData((current) => ({ ...current, settings: payload.settings || {} })))
        .catch(() => {});
    }
  }, [token]);

  function login(event) {
    event.preventDefault();
    adminApi("/api/admin/login", { method: "POST", body: JSON.stringify({ username, password }) })
      .then((payload) => {
        localStorage.setItem("adminToken", payload.token);
        setToken(payload.token);
        setMessage("Admin login successful");
      })
      .catch((error) => setMessage(error.message));
  }

  function logout() {
    localStorage.removeItem("adminToken");
    setToken("");
  }

  function refresh() {
    adminApi("/api/admin/bootstrap").then(setData).catch((error) => {
      setMessage(error.message);
      if (error.message.includes("Admin")) logout();
    });
  }

  if (!token) {
    return React.createElement("div", { className: "admin-login-page" },
      React.createElement("form", { className: "admin-login-card", onSubmit: login },
        React.createElement("img", { src: data.settings.logo_day || data.settings.logo_image || "assets/logo-red.png", alt: "ONE TEN" }),
        React.createElement("h1", null, "Admin Login"),
        React.createElement("p", null, "Username: onetenadmin / Password: oneten"),
        message && React.createElement("div", { className: "admin-message" }, message),
        React.createElement("input", { value: username, onChange: (event) => setUsername(event.target.value), placeholder: "Username" }),
        React.createElement("input", { value: password, onChange: (event) => setPassword(event.target.value), placeholder: "Password", type: "password" }),
        React.createElement("button", { type: "submit" }, "Sign In"),
        React.createElement("a", { href: "/" }, "Back to public website")
      )
    );
  }

  return React.createElement("div", { className: "admin-shell" },
    React.createElement("aside", { className: "admin-sidebar" },
      React.createElement("img", { src: data.settings.logo_night || data.settings.logo_image || "assets/logo-white.png", alt: "ONE TEN" }),
      [["products", "Products"], ["categories", "Categories"], ["ads", "Landing Ads"], ["about", "About Us"], ["settings", "Logo/Contact/Footer"], ["subscribers", "Subscribers"], ["orders", "Orders"]].map(([id, label]) =>
        React.createElement("button", { className: tab === id ? "active" : "", key: id, onClick: () => setTab(id), type: "button" }, label)
      ),
      React.createElement("a", { href: "/" }, "Public Website"),
      React.createElement("button", { type: "button", onClick: logout }, "Logout")
    ),
    React.createElement("main", { className: "admin-main" },
      React.createElement("div", { className: "admin-top" },
        React.createElement("div", null, React.createElement("p", { className: "eyebrow" }, "ONE TEN SQL Admin"), React.createElement("h1", null, "Dashboard")),
        React.createElement("button", { onClick: refresh, type: "button" }, "Refresh")
      ),
      React.createElement("div", { className: "admin-stats" },
        React.createElement(Stat, { label: "Products", value: data.dashboard.products || 0 }),
        React.createElement(Stat, { label: "Categories", value: data.dashboard.categories || 0 }),
        React.createElement(Stat, { label: "Ads", value: data.dashboard.ads || 0 }),
        React.createElement(Stat, { label: "Orders", value: data.dashboard.orders || 0 }),
        React.createElement(Stat, { label: "Subscribers", value: data.dashboard.subscribers || 0 }),
        React.createElement(Stat, { label: "Revenue", value: `$${Number(data.dashboard.revenue || 0).toFixed(2)}` }),
        React.createElement(Stat, { label: "Low Stock", value: data.dashboard.lowStock || 0 })
      ),
      message && React.createElement("div", { className: "admin-message" }, message),
      tab === "products" && React.createElement(ProductsAdmin, { data, refresh, setMessage }),
      tab === "categories" && React.createElement(CategoriesAdmin, { data, refresh, setMessage }),
      tab === "ads" && React.createElement(AdsAdmin, { data, refresh, setMessage }),
      tab === "about" && React.createElement(AboutAdmin, { data, refresh, setMessage }),
      tab === "settings" && React.createElement(SettingsAdmin, { data, refresh, setMessage }),
      tab === "subscribers" && React.createElement(SubscribersAdmin, { data }),
      tab === "orders" && React.createElement(OrdersAdmin, { data, refresh, setMessage })
    )
  );
}

function Stat({ label, value }) {
  return React.createElement("div", { className: "stat" }, React.createElement("span", null, label), React.createElement("strong", null, value));
}

function ProductsAdmin({ data, refresh, setMessage }) {
  const [form, setForm] = useState(emptyProduct);
  const [editing, setEditing] = useState(null);

  function save(event) {
    event.preventDefault();
    const images = getProductImages(form);
    const body = { ...form, image: images[0], images, category_id: form.category_id || (data.categories[0] && data.categories[0].id) || 1 };
    const path = editing ? `/api/admin/products/${editing}` : "/api/admin/products";
    adminApi(path, { method: editing ? "PUT" : "POST", body: JSON.stringify(body) })
      .then(() => {
        setMessage(editing ? "Product updated" : "Product added");
        setEditing(null);
        setForm(emptyProduct);
        refresh();
      })
      .catch((error) => setMessage(error.message));
  }

  function edit(product) {
    setEditing(product.id);
    setForm({ ...emptyProduct, ...product, image: getProductImages(product)[0], images: getProductImages(product), old_price: product.old_price || "", category_id: product.category_id || "" });
  }

  function remove(id) {
    adminApi(`/api/admin/products/${id}`, { method: "DELETE" }).then(refresh).catch((error) => setMessage(error.message));
  }

  function chooseFile(event) {
    readImageFiles(event.target.files).then((uploaded) => {
      if (!uploaded.length) return;
      setForm((current) => {
        const base = Array.isArray(current.images) && current.images.length ? getProductImages(current) : (current.image && current.image !== "assets/ai-products.png" ? [current.image] : []);
        const images = [...base, ...uploaded].filter(Boolean);
        const clean = images.filter((image, index) => images.indexOf(image) === index);
        return { ...current, image: clean[0], images: clean, crop: "center" };
      });
    });
  }

  function removeImage(index) {
    setForm((current) => {
      const images = getProductImages(current).filter((_, imageIndex) => imageIndex !== index);
      const clean = images.length ? images : ["assets/ai-products.png"];
      return { ...current, image: clean[0], images: clean };
    });
  }

  const previewImages = getProductImages(form);
  const publicProducts = (data.products || []).filter((product) => Number(product.active) === 1 && Number(product.stock || 0) > 0);
  const inactiveProducts = (data.products || []).filter((product) => Number(product.active) !== 1 || Number(product.stock || 0) <= 0);

  function ProductRow(product) {
    const isPublic = Number(product.active) === 1 && Number(product.stock || 0) > 0;
    return React.createElement("article", { className: `admin-row ${isPublic ? "is-public" : "is-inactive"}`, key: product.id },
      React.createElement("img", { src: getProductImages(product)[0], alt: product.name, style: { objectPosition: product.crop || "center" } }),
      React.createElement("div", null,
        React.createElement("strong", null, product.name),
        React.createElement("span", null, `${product.category} / $${product.price} / Stock ${product.stock} / ${getProductImages(product).length} images`),
        React.createElement("em", { className: isPublic ? "product-state public" : "product-state inactive" }, isPublic ? "Public / Active" : Number(product.stock || 0) <= 0 ? "Inactive / Stock finished" : "Inactive / Hidden")
      ),
      React.createElement("button", { onClick: () => edit(product), type: "button" }, "Edit"),
      React.createElement("button", { onClick: () => remove(product.id), type: "button" }, "Delete")
    );
  }

  return React.createElement("section", { className: "admin-grid" },
    React.createElement("form", { className: "admin-form", onSubmit: save },
      React.createElement("h2", null, editing ? "Edit Product" : "Add Product"),
      React.createElement("input", { required: true, value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }), placeholder: "Product name" }),
      React.createElement("select", { value: form.category_id, onChange: (event) => setForm({ ...form, category_id: event.target.value }) }, React.createElement("option", { value: "" }, "Choose category"), data.categories.map((cat) => React.createElement("option", { key: cat.id, value: cat.id }, cat.name))),
      React.createElement("div", { className: "two-col" }, React.createElement("input", { value: form.price, onChange: (event) => setForm({ ...form, price: event.target.value }), placeholder: "Price 1-10" }), React.createElement("input", { value: form.old_price || "", onChange: (event) => setForm({ ...form, old_price: event.target.value }), placeholder: "Old price" })),
      React.createElement("div", { className: "two-col" }, React.createElement("input", { value: form.badge || "", onChange: (event) => setForm({ ...form, badge: event.target.value }), placeholder: "Badge" }), React.createElement("input", { value: form.stock, onChange: (event) => setForm({ ...form, stock: event.target.value }), placeholder: "Stock" })),
      React.createElement("label", { className: "file-picker" }, "Choose product images",
        React.createElement("input", { accept: "image/*", multiple: true, onChange: chooseFile, type: "file" })
      ),
      React.createElement("div", { className: "admin-image-preview" }, previewImages.map((image, index) => React.createElement("button", { key: `${image}-${index}`, onClick: () => removeImage(index), title: "Remove image", type: "button" }, React.createElement("img", { src: image, alt: `Product image ${index + 1}` }), React.createElement("span", null, index === 0 ? "Main" : "Alt")))),
      React.createElement("input", { value: form.image, onChange: (event) => setForm({ ...form, image: event.target.value, images: getProductImages({ ...form, image: event.target.value }) }), placeholder: "Main image path or online URL" }),
      React.createElement("input", { value: form.crop || "", onChange: (event) => setForm({ ...form, crop: event.target.value }), placeholder: "Image crop" }),
      React.createElement("textarea", { value: form.description || "", onChange: (event) => setForm({ ...form, description: event.target.value }), placeholder: "Description" }),
      React.createElement("button", { type: "submit" }, editing ? "Save Product" : "Add Product")
    ),
    React.createElement("div", { className: "admin-table" },
      React.createElement("h2", null, "Products"),
      React.createElement("div", { className: "product-admin-section" },
        React.createElement("div", { className: "product-admin-head" }, React.createElement("strong", null, "Public products"), React.createElement("span", null, `${publicProducts.length} active`)),
        publicProducts.length ? publicProducts.map(ProductRow) : React.createElement("div", { className: "empty-state compact" }, React.createElement("h2", null, "No public products"))
      ),
      React.createElement("div", { className: "product-admin-section inactive" },
        React.createElement("div", { className: "product-admin-head" }, React.createElement("strong", null, "Inactive / stock finished"), React.createElement("span", null, `${inactiveProducts.length} hidden`)),
        inactiveProducts.length ? inactiveProducts.map(ProductRow) : React.createElement("div", { className: "empty-state compact" }, React.createElement("h2", null, "No inactive products"))
      )
    )
  );
}

function CategoriesAdmin({ data, refresh, setMessage }) {
  const [form, setForm] = useState(emptyCategory);
  const [editing, setEditing] = useState(null);

  function save(event) {
    event.preventDefault();
    const path = editing ? `/api/admin/categories/${editing}` : "/api/admin/categories";
    adminApi(path, { method: editing ? "PUT" : "POST", body: JSON.stringify(form) })
      .then(() => {
        setMessage(editing ? "Category updated" : "Category added");
        setEditing(null);
        setForm(emptyCategory);
        refresh();
      })
      .catch((error) => setMessage(error.message));
  }

  return React.createElement("section", { className: "admin-grid" },
    React.createElement("form", { className: "admin-form", onSubmit: save },
      React.createElement("h2", null, editing ? "Edit Category" : "Add Category"),
      React.createElement("input", { required: true, value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }), placeholder: "Category name" }),
      React.createElement("select", { value: form.price_mode || "range", onChange: (event) => setForm({ ...form, price_mode: event.target.value }) },
        React.createElement("option", { value: "range" }, "$1 ilaa $10"),
        React.createElement("option", { value: "max10" }, "Kaliya $10")
      ),
      React.createElement("input", { value: form.sort_order, onChange: (event) => setForm({ ...form, sort_order: event.target.value }), placeholder: "Sort order" }),
      React.createElement("textarea", { value: form.description, onChange: (event) => setForm({ ...form, description: event.target.value }), placeholder: "Description" }),
      React.createElement("button", { type: "submit" }, editing ? "Save Category" : "Add Category")
    ),
    React.createElement("div", { className: "admin-table" },
      React.createElement("h2", null, "Categories"),
      data.categories.map((cat) => React.createElement("article", { className: "order-row", key: cat.id },
        React.createElement("div", null, React.createElement("strong", null, cat.name), React.createElement("span", null, `${cat.price_mode === "max10" ? "Kaliya $10" : "$1 ilaa $10"} / ${cat.description || "No description"}`)),
        React.createElement("div", { className: "row-actions" }, React.createElement("button", { onClick: () => { setEditing(cat.id); setForm(cat); }, type: "button" }, "Edit"), React.createElement("button", { onClick: () => adminApi(`/api/admin/categories/${cat.id}`, { method: "DELETE" }).then(refresh).catch((error) => setMessage(error.message)), type: "button" }, "Delete"))
      ))
    )
  );
}

function AdsAdmin({ data, refresh, setMessage }) {
  const [form, setForm] = useState(emptyAd);
  const [editing, setEditing] = useState(null);

  function chooseFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm({ ...form, image: reader.result });
    reader.readAsDataURL(file);
  }

  function save(event) {
    event.preventDefault();
    const path = editing ? `/api/admin/ads/${editing}` : "/api/admin/ads";
    adminApi(path, { method: editing ? "PUT" : "POST", body: JSON.stringify(form) })
      .then(() => {
        setMessage(editing ? "Ad updated" : "Ad added");
        setEditing(null);
        setForm(emptyAd);
        refresh();
      })
      .catch((error) => setMessage(error.message));
  }

  return React.createElement("section", { className: "admin-grid" },
    React.createElement("form", { className: "admin-form", onSubmit: save },
      React.createElement("h2", null, editing ? "Edit Landing Post" : "Add Landing Post / Ad"),
      React.createElement("input", { required: true, value: form.title, onChange: (event) => setForm({ ...form, title: event.target.value }), placeholder: "Post title" }),
      React.createElement("textarea", { value: form.subtitle, onChange: (event) => setForm({ ...form, subtitle: event.target.value }), placeholder: "Subtitle" }),
      React.createElement("div", { className: "two-col" }, React.createElement("input", { value: form.button_text, onChange: (event) => setForm({ ...form, button_text: event.target.value }), placeholder: "Button text" }), React.createElement("input", { value: form.link, onChange: (event) => setForm({ ...form, link: event.target.value }), placeholder: "Link" })),
      React.createElement("label", { className: "file-picker" }, "Choose ad image",
        React.createElement("input", { accept: "image/*", onChange: chooseFile, type: "file" })
      ),
      React.createElement("input", { value: form.image, onChange: (event) => setForm({ ...form, image: event.target.value }), placeholder: "Image path or online URL" }),
      React.createElement("input", { value: form.sort_order, onChange: (event) => setForm({ ...form, sort_order: event.target.value }), placeholder: "Sort order" }),
      React.createElement("label", { className: "check-row" }, React.createElement("input", { checked: !!form.active, onChange: (event) => setForm({ ...form, active: event.target.checked }), type: "checkbox" }), React.createElement("span", null, "Active")),
      React.createElement("button", { type: "submit" }, editing ? "Save Post" : "Add Post")
    ),
    React.createElement("div", { className: "admin-table" },
      React.createElement("h2", null, "Landing Posts / Ads"),
      data.ads.map((ad) => React.createElement("article", { className: "admin-row", key: ad.id },
        React.createElement("img", { src: ad.image, alt: ad.title }),
        React.createElement("div", null, React.createElement("strong", null, ad.title), React.createElement("span", null, ad.subtitle)),
        React.createElement("button", { onClick: () => { setEditing(ad.id); setForm(ad); }, type: "button" }, "Edit"),
        React.createElement("button", { onClick: () => adminApi(`/api/admin/ads/${ad.id}`, { method: "DELETE" }).then(refresh).catch((error) => setMessage(error.message)), type: "button" }, "Delete")
      ))
    )
  );
}

function AboutAdmin({ data, refresh, setMessage }) {
  const settings = data.settings || {};
  const [form, setForm] = useState({
    about_eyebrow: settings.about_eyebrow || "ONE TEN story",
    about_title: settings.about_title || "Affordable men's fashion with a sharp street look.",
    about_body: settings.about_body || "ONE TEN focuses on simple, clean menswear for daily outfits. Every product stays between $1 and $10, with fast local delivery and a bold red, white, and black identity.",
    about_image: settings.about_image || "assets/ai-hero.png",
  });

  useEffect(() => {
    setForm({
      about_eyebrow: settings.about_eyebrow || "ONE TEN story",
      about_title: settings.about_title || "Affordable men's fashion with a sharp street look.",
      about_body: settings.about_body || "ONE TEN focuses on simple, clean menswear for daily outfits. Every product stays between $1 and $10, with fast local delivery and a bold red, white, and black identity.",
      about_image: settings.about_image || "assets/ai-hero.png",
    });
  }, [JSON.stringify(settings)]);

  function chooseImage(event) {
    readImageFiles(event.target.files).then((images) => {
      if (images[0]) setForm((current) => ({ ...current, about_image: images[0] }));
    });
  }

  function save(event) {
    event.preventDefault();
    adminApi("/api/admin/settings", { method: "PUT", body: JSON.stringify(form) })
      .then(() => {
        setMessage("About Us updated");
        refresh();
      })
      .catch((error) => setMessage(error.message));
  }

  return React.createElement("section", { className: "admin-grid" },
    React.createElement("form", { className: "admin-form", onSubmit: save },
      React.createElement("h2", null, "Edit About Us"),
      React.createElement("input", { value: form.about_eyebrow, onChange: (event) => setForm({ ...form, about_eyebrow: event.target.value }), placeholder: "Small title" }),
      React.createElement("input", { value: form.about_title, onChange: (event) => setForm({ ...form, about_title: event.target.value }), placeholder: "Main headline" }),
      React.createElement("textarea", { value: form.about_body, onChange: (event) => setForm({ ...form, about_body: event.target.value }), placeholder: "About text" }),
      React.createElement("label", { className: "file-picker" }, "Choose about image",
        React.createElement("input", { accept: "image/*", onChange: chooseImage, type: "file" })
      ),
      React.createElement("input", { value: form.about_image, onChange: (event) => setForm({ ...form, about_image: event.target.value }), placeholder: "Image path or online URL" }),
      React.createElement("button", { type: "submit" }, "Save About Us")
    ),
    React.createElement("div", { className: "admin-table about-preview" },
      React.createElement("h2", null, "About Preview"),
      React.createElement("img", { src: form.about_image, alt: "About preview" }),
      React.createElement("p", { className: "eyebrow" }, form.about_eyebrow),
      React.createElement("strong", null, form.about_title),
      React.createElement("p", null, form.about_body)
    )
  );
}

function SettingsAdmin({ data, refresh, setMessage }) {
  const settings = data.settings || {};
  const [form, setForm] = useState({
    logo_image: settings.logo_image || "",
    logo_day: settings.logo_day || settings.logo_image || "",
    logo_night: settings.logo_night || "",
    footer_logo: settings.footer_logo || "",
    product_badge_logo: settings.product_badge_logo || "",
    footer_text: settings.footer_text || "",
    contact_title: settings.contact_title || "Get In Touch",
    phone: settings.phone || "",
    hotline: settings.hotline || "",
    email: settings.email || "",
    location: settings.location || "",
    information_links: cleanLinks(settings.information_links, defaultInformationLinks),
    department_links: cleanLinks(settings.department_links, defaultDepartmentLinks),
  });

  useEffect(() => {
    setForm({
      logo_image: settings.logo_image || "",
      logo_day: settings.logo_day || settings.logo_image || "",
      logo_night: settings.logo_night || "",
      footer_logo: settings.footer_logo || "",
      product_badge_logo: settings.product_badge_logo || "",
      footer_text: settings.footer_text || "",
      contact_title: settings.contact_title || "Get In Touch",
      phone: settings.phone || "",
      hotline: settings.hotline || "",
      email: settings.email || "",
      location: settings.location || "",
      information_links: cleanLinks(settings.information_links, defaultInformationLinks),
      department_links: cleanLinks(settings.department_links, defaultDepartmentLinks),
    });
  }, [JSON.stringify(settings)]);

  function updateLink(listName, index, field, value) {
    setForm((current) => {
      const links = current[listName].map((link, linkIndex) => linkIndex === index ? { ...link, [field]: value } : link);
      return { ...current, [listName]: links };
    });
  }

  function addLink(listName) {
    setForm((current) => ({ ...current, [listName]: [...current[listName], { label: "", href: "#/shop" }] }));
  }

  function removeLink(listName, index) {
    setForm((current) => {
      const links = current[listName].filter((_, linkIndex) => linkIndex !== index);
      return { ...current, [listName]: links.length ? links : [{ label: "", href: "#/shop" }] };
    });
  }

  function chooseLogo(field, event) {
    readImageFiles(event.target.files).then((images) => {
      if (images[0]) setForm((current) => ({ ...current, [field]: images[0] }));
    });
  }

  function save(event) {
    event.preventDefault();
    const body = {
      logo_image: form.logo_image,
      logo_day: form.logo_day,
      logo_night: form.logo_night,
      footer_logo: form.footer_logo,
      product_badge_logo: form.product_badge_logo,
      footer_text: form.footer_text,
      contact_title: form.contact_title,
      phone: form.phone,
      hotline: form.hotline,
      email: form.email,
      location: form.location,
      information_links: form.information_links.filter((link) => link.label.trim() && link.href.trim()),
      department_links: form.department_links.filter((link) => link.label.trim() && link.href.trim()),
    };
    adminApi("/api/admin/settings", { method: "PUT", body: JSON.stringify(body) })
      .then(() => {
        setMessage("Logo, contact, hotline, and footer updated");
        refresh();
      })
      .catch((error) => setMessage(error.message));
  }

  function LinkEditor({ title, listName }) {
    return React.createElement("div", { className: "link-editor" },
      React.createElement("div", { className: "link-editor-head" }, React.createElement("strong", null, title), React.createElement("button", { onClick: () => addLink(listName), type: "button" }, "Add")),
      form[listName].map((link, index) => React.createElement("div", { className: "link-row", key: index },
        React.createElement("input", { value: link.label, onChange: (event) => updateLink(listName, index, "label", event.target.value), placeholder: "Label" }),
        React.createElement("input", { value: link.href, onChange: (event) => updateLink(listName, index, "href", event.target.value), placeholder: "Link" }),
        React.createElement("button", { onClick: () => removeLink(listName, index), type: "button" }, "Remove")
      ))
    );
  }

  function LogoField({ field, label, placeholder }) {
    return React.createElement("div", { className: "logo-field" },
      React.createElement("label", { className: "file-picker" }, label,
        React.createElement("input", { accept: "image/*", onChange: (event) => chooseLogo(field, event), type: "file" })
      ),
      form[field] && React.createElement("div", { className: "logo-preview" }, React.createElement("img", { src: form[field], alt: `${label} preview` })),
      React.createElement("input", { value: form[field], onChange: (event) => setForm({ ...form, [field]: event.target.value }), placeholder })
    );
  }

  return React.createElement("section", { className: "admin-grid" },
    React.createElement("form", { className: "admin-form", onSubmit: save },
      React.createElement("h2", null, "Logo / Contact / Hotline / Footer"),
      React.createElement("div", { className: "two-col" },
        React.createElement(LogoField, { field: "logo_day", label: "Choose day logo", placeholder: "Day logo path or online URL" }),
        React.createElement(LogoField, { field: "logo_night", label: "Choose night logo", placeholder: "Night logo path or online URL" })
      ),
      React.createElement("div", { className: "two-col" },
        React.createElement(LogoField, { field: "footer_logo", label: "Choose footer logo", placeholder: "Footer logo path or online URL" }),
        React.createElement(LogoField, { field: "product_badge_logo", label: "Choose product badge logo", placeholder: "Small product badge logo path or URL" })
      ),
      React.createElement("input", { value: form.logo_image, onChange: (event) => setForm({ ...form, logo_image: event.target.value }), placeholder: "Old/general logo fallback path" }),
      React.createElement("input", { value: form.contact_title, onChange: (event) => setForm({ ...form, contact_title: event.target.value }), placeholder: "Contact title" }),
      React.createElement("div", { className: "two-col" },
        React.createElement("input", { value: form.phone, onChange: (event) => setForm({ ...form, phone: event.target.value }), placeholder: "Phone" }),
        React.createElement("input", { value: form.hotline, onChange: (event) => setForm({ ...form, hotline: event.target.value }), placeholder: "Hotline" })
      ),
      React.createElement("div", { className: "two-col" },
        React.createElement("input", { value: form.email, onChange: (event) => setForm({ ...form, email: event.target.value }), placeholder: "Email" }),
        React.createElement("input", { value: form.location, onChange: (event) => setForm({ ...form, location: event.target.value }), placeholder: "Location" })
      ),
      React.createElement("textarea", { value: form.footer_text, onChange: (event) => setForm({ ...form, footer_text: event.target.value }), placeholder: "Footer text" }),
      React.createElement(LinkEditor, { title: "Information links", listName: "information_links" }),
      React.createElement(LinkEditor, { title: "Shop departments", listName: "department_links" }),
      React.createElement("button", { type: "submit" }, "Save Settings")
    ),
    React.createElement("div", { className: "admin-table" },
      React.createElement("h2", null, "Footer Preview"),
      React.createElement("div", { className: "logo-preview" }, React.createElement("img", { src: form.footer_logo || form.logo_night || form.logo_day || "assets/logo-white.png", alt: "Footer logo preview" })),
      React.createElement("p", null, form.footer_text),
      React.createElement("p", null, `Phone: ${form.phone}`),
      React.createElement("p", null, `Hotline: ${form.hotline}`),
      React.createElement("p", null, form.email),
      React.createElement("p", null, form.location)
    )
  );
}

function SubscribersAdmin({ data }) {
  const subscribers = data.subscribers || [];
  return React.createElement("section", { className: "admin-table subscribers" },
    React.createElement("h2", null, "Newsletter Phone Numbers"),
    subscribers.length ? subscribers.map((subscriber) => React.createElement("article", { className: "order-row", key: subscriber.id },
      React.createElement("div", null,
        React.createElement("strong", null, subscriber.phone),
        React.createElement("span", null, `Subscribed: ${subscriber.created_at}`)
      ),
      React.createElement("span", { className: "subscriber-badge" }, "Active")
    )) : React.createElement("div", { className: "empty-state" }, React.createElement("h2", null, "No subscribers yet"), React.createElement("p", null, "Phone numbers will appear here after customers subscribe."))
  );
}

function OrdersAdmin({ data, refresh, setMessage }) {
  const [openOrder, setOpenOrder] = useState(null);

  function update(order, status) {
    adminApi(`/api/admin/orders/${order.id}`, { method: "PUT", body: JSON.stringify({ status }) })
      .then(refresh)
      .catch((error) => setMessage(error.message));
  }

  function updateItem(item, changes) {
    adminApi(`/api/admin/order-items/${item.id}`, { method: "PUT", body: JSON.stringify({ qty: item.qty, status: item.status || "Processing", ...changes }) })
      .then(() => {
        setMessage("Order item updated and stock synced");
        refresh();
      })
      .catch((error) => setMessage(error.message));
  }

  return React.createElement("section", { className: "admin-table orders" },
    React.createElement("h2", null, "Orders"),
    data.orders.map((order) => React.createElement("article", { className: "order-row", key: order.id },
      React.createElement("div", null,
        React.createElement("strong", null, `#${order.id} ${order.customer_name}`),
        React.createElement("span", null, `${order.phone} / ${order.items} product lines / $${Number(order.total).toFixed(2)} / ${order.created_at}`),
        React.createElement("button", { className: "small-admin-btn", onClick: () => setOpenOrder(openOrder === order.id ? null : order.id), type: "button" }, openOrder === order.id ? "Close products" : "Open products"),
        openOrder === order.id && React.createElement("div", { className: "order-detail-panel" },
          (order.order_items || []).map((item) => React.createElement("div", { className: "order-item-editor", key: item.id },
            React.createElement("img", { src: item.product_image || "assets/ai-products.png", alt: item.product_name }),
            React.createElement("div", null,
              React.createElement("strong", null, item.product_name),
              React.createElement("span", null, `Requested ${item.requested_qty || item.qty} / Current ${item.qty} / $${Number(item.price).toFixed(2)}`)
            ),
            React.createElement("input", { max: item.requested_qty || item.qty, min: "0", onChange: (event) => updateItem(item, { qty: Number(event.target.value) }), type: "number", value: item.qty }),
            React.createElement("select", { value: item.status || "Processing", onChange: (event) => updateItem(item, { status: event.target.value }) }, ["Processing", "Approved", "Cancelled"].map((status) => React.createElement("option", { key: status }, status)))
          ))
        )
      ),
      React.createElement("select", { value: order.status, onChange: (event) => update(order, event.target.value) }, ["Processing", "Packed", "Delivered", "Cancelled"].map((status) => React.createElement("option", { key: status }, status)))
    ))
  );
}

ReactDOM.createRoot(document.getElementById("admin-root")).render(React.createElement(AdminApp));
