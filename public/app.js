const { useEffect, useMemo, useState } = React;

const assets = {
  logoRed: "assets/logo-red.png",
  logoWhite: "assets/logo-white.png",
  hero: "assets/ai-hero.png",
  products: "assets/ai-products.png",
};

const API_BASE_URL = (window.API_BASE_URL || localStorage.getItem("API_BASE_URL") || "").replace(/\/$/, "");

function apiUrl(path) {
  return path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
}

function api(path, options = {}) {
  const token = localStorage.getItem("customerToken");
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  if (typeof fetch === "function") {
    return fetch(apiUrl(path), { ...options, headers }).then(async (response) => {
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      return data;
    });
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method || "GET", apiUrl(path), true);
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
  return clean.length ? clean : [assets.products];
}

function getProductSizes(product) {
  return (Array.isArray(product && product.product_sizes) ? product.product_sizes : [])
    .map((item) => ({
      size: String(item && item.size ? item.size : "").trim().toUpperCase(),
      stock: Math.max(0, Number(item && item.stock) || 0),
    }))
    .filter((item) => item.size && item.stock > 0);
}

function cartKey(item) {
  return `${item && item.id}::${String(item && item.size || "").toUpperCase()}`;
}

function getSizeStock(product, size) {
  const sizes = getProductSizes(product);
  if (!sizes.length) return Math.max(0, Number(product && product.stock) || 0);
  const match = sizes.find((item) => item.size === String(size || "").toUpperCase());
  return match ? match.stock : 0;
}

const iconPaths = {
  home: ["M3 10.5 12 3l9 7.5", "M5 10v10h5v-6h4v6h5V10"],
  shop: ["M4 7h16l-1.2 13H5.2L4 7Z", "M8 7a4 4 0 0 1 8 0", "M8 11h8"],
  info: ["M12 17v-6", "M12 7h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  phone: ["M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9Z"],
  cart: ["M6 6h15l-2 8H8L6 2H3", "M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z", "M18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"],
  history: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v6h6", "M12 7v5l4 2"],
  user: ["M20 21a8 8 0 0 0-16 0", "M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"],
  sun: ["M12 4V2", "M12 22v-2", "M4.9 4.9 3.5 3.5", "M20.5 20.5l-1.4-1.4", "M4 12H2", "M22 12h-2", "M4.9 19.1l-1.4 1.4", "M20.5 3.5l-1.4 1.4", "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"],
  moon: ["M21 12.8A8.5 8.5 0 1 1 11.2 3 6.5 6.5 0 0 0 21 12.8Z"],
  check: ["M20 6 9 17l-5-5"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  back: ["M15 18l-6-6 6-6"],
  minus: ["M5 12h14"],
  plus: ["M12 5v14", "M5 12h14"],
};

function Icon({ name }) {
  return React.createElement("svg", { className: "icon", viewBox: "0 0 24 24", "aria-hidden": "true" },
    (iconPaths[name] || iconPaths.home).map((d, index) => React.createElement("path", { d, key: index }))
  );
}

function routeFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [page = "home", id] = raw.split("/");
  return { page: page || "home", id };
}

function safeCartItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({ id: item && item.id, size: String(item && item.size || "").toUpperCase(), qty: Math.max(1, Number(item && item.qty) || 1) }))
    .filter((item) => item.id !== undefined && item.id !== null);
}

function loadCart() {
  try {
    return safeCartItems(JSON.parse(localStorage.getItem("oneTenCart") || "[]"));
  } catch {
    localStorage.removeItem("oneTenCart");
    return [];
  }
}

function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [theme, setTheme] = useState(localStorage.getItem("oneTenTheme") || "day");
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [ads, setAds] = useState([]);
  const [settings, setSettings] = useState({});
  const [query, setQuery] = useState("");
  const [customer, setCustomer] = useState(null);
  const [cart, setCart] = useState(loadCart);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    loadPublic();
    loadCustomer();
  }, []);

  useEffect(() => {
    const safeCart = safeCartItems(cart);
    try {
      localStorage.setItem("oneTenCart", JSON.stringify(safeCart));
    } catch {
      localStorage.removeItem("oneTenCart");
    }
  }, [cart]);

  function loadPublic() {
    api("/api/public/bootstrap")
      .then((data) => {
        setCategories(data.categories || []);
        setAds(data.ads || []);
        setSettings(data.settings || {});
      })
      .catch(() => {
        setCategories([]);
        setAds([]);
        setSettings({});
      });
    api("/api/public/products")
      .then((data) => setProducts(data.products || []))
      .catch(() => setProducts([]));
  }

  function loadCustomer() {
    if (!localStorage.getItem("customerToken")) return;
    api("/api/customer/me").then(setCustomer).catch(() => {
      localStorage.removeItem("customerToken");
      setCustomer(null);
    });
  }

  function navigate(page) {
    window.location.hash = `#/${page}`;
  }

  function addToCart(product, size = "", qty = 1) {
    const amount = Math.max(1, Number(qty) || 1);
    const sizes = getProductSizes(product);
    const selectedSize = String(size || "").toUpperCase();
    if (sizes.length && !sizes.some((item) => item.size === selectedSize)) {
      setNotice("Size-kan waxba kama yaalaan, fadlan dooro size kale");
      window.setTimeout(() => setNotice(""), 1800);
      return false;
    }
    const maxStock = getSizeStock(product, selectedSize);
    if (maxStock <= 0) {
      setNotice(`${product.name} hadda stock kama yaallo`);
      window.setTimeout(() => setNotice(""), 1800);
      return false;
    }
    const existing = cart.find((item) => String(item.id) === String(product.id) && String(item.size || "") === selectedSize);
    const nextQty = Number(existing && existing.qty || 0) + amount;
    if (nextQty > maxStock) {
      setNotice(`Kaliya ${maxStock} ayaa ka yaalla ${selectedSize ? `size ${selectedSize}` : product.name}`);
      window.setTimeout(() => setNotice(""), 2200);
      return false;
    }
    if (existing) {
      setCart(cart.map((item) => cartKey(item) === cartKey({ id: product.id, size: selectedSize }) ? { id: item.id, size: item.size || selectedSize, qty: nextQty } : { id: item.id, size: item.size || "", qty: item.qty }));
    } else {
      setCart([{ id: product.id, size: selectedSize, qty: amount }, ...safeCartItems(cart)]);
    }
    setNotice(`${product.name}${selectedSize ? ` size ${selectedSize}` : ""} added to cart`);
    window.setTimeout(() => setNotice(""), 1300);
    return true;
  }

  function logout() {
    localStorage.removeItem("customerToken");
    setCustomer(null);
    navigate("home");
  }

  const activeProduct = route.page === "product" ? products.find((product) => String(product.id) === String(route.id)) : null;
  const cartProducts = useMemo(() => cart.map((item) => {
    const product = products.find((candidate) => String(candidate.id) === String(item.id));
    return product ? { ...product, size: item.size || "", sizeStock: getSizeStock(product, item.size), qty: item.qty } : { ...item, name: "Product", price: 0, image: assets.products, sizeStock: 0 };
  }), [cart, products]);
  const total = cartProducts.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0);
  const cartCount = cart.length;

  return React.createElement("div", { className: `store ${theme}` },
    React.createElement(TopBar, { customer, logout }),
    React.createElement(Header, { theme, setTheme, query, setQuery, cartCount, navigate, settings }),
    React.createElement(NavBarClean, { active: route.page }),
    notice && React.createElement("div", { className: "notice" }, notice),
    route.page === "home" && React.createElement(HomePage, { ads, products, categories, addToCart, navigate, settings }),
    route.page === "shop" && React.createElement(ShopPage, { products, categories, query, addToCart, navigate, settings }),
    route.page === "product" && React.createElement(ProductPage, { product: activeProduct, products, settings, addToCart, navigate }),
    route.page === "about" && React.createElement(AboutPage, { settings }),
    route.page === "contact" && React.createElement(ContactPage, { settings }),
    route.page === "cart" && React.createElement(CartPage, { cart: cartProducts, setCart, total, navigate }),
    route.page === "checkout" && React.createElement(CheckoutPage, { cart: cartProducts, total, customer, setCart, navigate }),
    route.page === "order-history" && React.createElement(OrderHistoryPage, { customer, navigate }),
    route.page === "profile" && React.createElement(ProfilePage, { customer, navigate, logout }),
    route.page === "signin" && (customer ? React.createElement(ProfilePage, { customer, navigate, logout }) : React.createElement(AuthPage, { mode: "signin", setCustomer, navigate })),
    route.page === "register" && React.createElement(AuthPage, { mode: "register", setCustomer, navigate }),
    !["home", "shop", "product", "about", "contact", "cart", "checkout", "order-history", "profile", "signin", "register"].includes(route.page) && React.createElement(NotFoundPage, { navigate }),
    React.createElement(Newsletter),
    React.createElement(Footer, { settings })
  );
}

function TopBar({ customer, logout }) {
  return React.createElement("div", { className: "topbar" },
    React.createElement("div", null, React.createElement("span", null, "$ USD"), React.createElement("span", null, "English"), React.createElement("span", null, "Hargaysa")),
    React.createElement("div", null,
      React.createElement("a", { href: "#/home" }, "Home"),
      React.createElement("a", { href: "#/about" }, "About Us"),
      React.createElement("a", { href: "#/contact" }, "Contact Us"),
      customer ? React.createElement("button", { className: "top-link", onClick: logout, type: "button" }, `Logout ${customer.name}`) : React.createElement("a", { href: "#/signin" }, "Sign In"),
      !customer && React.createElement("a", { href: "#/register" }, "Register")
    )
  );
}

function Header({ theme, setTheme, query, setQuery, cartCount, navigate, settings }) {
  const headerLogo = theme === "night"
    ? (settings.logo_night || settings.logo_image || assets.logoWhite)
    : (settings.logo_day || settings.logo_image || assets.logoRed);

  function toggleTheme() {
    const next = theme === "day" ? "night" : "day";
    setTheme(next);
    localStorage.setItem("oneTenTheme", next);
  }

  return React.createElement("header", { className: "header" },
    React.createElement("a", { className: "brand", href: "#/home" }, React.createElement("img", { src: headerLogo, alt: "ONE TEN" })),
    React.createElement("form", { className: "search", onSubmit: (event) => { event.preventDefault(); navigate("shop"); } },
      React.createElement("select", { "aria-label": "Search category" }, React.createElement("option", null, "All"), React.createElement("option", null, "Men's Fashion")),
      React.createElement("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "Search men's fashion" }),
      React.createElement("button", { type: "submit" }, "Search")
    ),
    React.createElement("div", { className: "header-info" },
      React.createElement("div", { className: "hotline" }, React.createElement("span", null, "Hotline"), React.createElement("strong", null, settings.hotline || "(+252) 63 000 1010")),
      React.createElement("button", { className: "theme-btn", type: "button", onClick: toggleTheme, "aria-label": theme === "day" ? "Switch to night mode" : "Switch to day mode" }, React.createElement(Icon, { name: theme === "day" ? "sun" : "moon" })),
      React.createElement("a", { className: "mini-action cart", href: "#/cart" }, "Cart ", React.createElement("strong", null, cartCount))
    )
  );
}

function NavBarClean({ active }) {
  const links = [["home", "Home", "home"], ["shop", "Shop", "shop"], ["cart", "Cart", "cart"], ["order-history", "Orders", "history"], ["contact", "Contact", "phone"], ["profile", "Profile", "user"]];
  return React.createElement("nav", { className: "category-nav" },
    links.map(([page, label, icon]) => React.createElement("a", { className: active === page ? "active" : "", href: `#/${page}`, key: page, title: label }, React.createElement("span", { className: "nav-icon" }, React.createElement(Icon, { name: icon })), React.createElement("span", { className: "nav-label" }, label)))
  );
}

function NavBar({ active }) {
  const links = [["home", "Home", "⌂"], ["shop", "Shop Grid", "▦"], ["about", "About Us", "i"], ["contact", "Contact Us", "☎"], ["cart", "Cart", "▣"], ["checkout", "Checkout", "✓"]];
  return React.createElement("nav", { className: "category-nav" },
    React.createElement("button", { type: "button" }, React.createElement("span", { className: "nav-icon" }, "▤"), "All Categories"),
    links.map(([page, label, icon]) => React.createElement("a", { className: active === page ? "active" : "", href: `#/${page}`, key: page }, React.createElement("span", { className: "nav-icon" }, icon), label))
  );
}

function HomePage({ ads, products, categories, addToCart, navigate, settings }) {
  const [active, setActive] = useState(0);
  const activeAds = ads.length ? ads : [{ title: "ONE TEN Men's Fashion", subtitle: "Everything from $1 to $10.", button_text: "Shop Now", link: "#/shop", image: assets.hero }];

  useEffect(() => {
    const timer = window.setInterval(() => setActive((value) => (value + 1) % activeAds.length), 4500);
    return () => window.clearInterval(timer);
  }, [activeAds.length]);

  const ad = activeAds[active] || activeAds[0];
  const prevAd = () => setActive((value) => (value - 1 + activeAds.length) % activeAds.length);
  const nextAd = () => setActive((value) => (value + 1) % activeAds.length);

  return React.createElement(React.Fragment, null,
    React.createElement("section", { className: "home-hero" },
      React.createElement("div", { className: "home-copy" },
        React.createElement("p", { className: "eyebrow" }, "ONE TEN ads"),
        React.createElement("h1", null, ad.title),
        React.createElement("p", null, ad.subtitle),
        React.createElement("div", { className: "home-actions" }, React.createElement("a", { className: "btn primary", href: ad.link }, React.createElement("span", { className: "btn-icon" }, "›"), ad.button_text || "Shop Now"), React.createElement("a", { className: "btn ghost", href: "#/shop" }, React.createElement("span", { className: "btn-icon" }, "▦"), "View Products")),
        React.createElement("div", { className: "ad-dots" }, activeAds.map((item, index) => React.createElement("button", { className: active === index ? "active" : "", key: item.id || index, onClick: () => setActive(index), type: "button" }, index + 1)))
      ),
      React.createElement("div", { className: "hero-media" },
        React.createElement("button", { className: "hero-arrow prev", onClick: prevAd, type: "button", "aria-label": "Previous ad" }, "‹"),
        React.createElement("img", { src: ad.image, alt: ad.title }),
        React.createElement("button", { className: "hero-arrow next", onClick: nextAd, type: "button", "aria-label": "Next ad" }, "›")
      )
    ),
    React.createElement("section", { className: "quick-cats" }, categories.slice(0, 6).map((cat) => React.createElement("a", { href: "#/shop", key: cat.id }, React.createElement("strong", null, cat.name), React.createElement("span", null, cat.price_mode === "max10" ? "Only $10" : "$1-$10")))),
    React.createElement("section", { className: "section" },
      React.createElement("div", { className: "section-head" }, React.createElement("div", null, React.createElement("p", { className: "eyebrow" }, "Featured"), React.createElement("h2", null, "Top picks this week")), React.createElement("a", { href: "#/shop" }, "View all")),
      React.createElement("div", { className: "product-grid" }, products.slice(0, 6).map((product) => React.createElement(ProductCard, { key: product.id, product, settings, addToCart, navigate })))
    )
  );
}

function ShopPage({ products, categories, query, addToCart, navigate, settings }) {
  const [categoryId, setCategoryId] = useState("All");
  const [sort, setSort] = useState("popular");
  const [view, setView] = useState("grid");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [priceFilters, setPriceFilters] = useState([]);
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const productsPerPage = view === "list" ? 4 : 3;

  const priceRanges = [
    { id: "1-3", label: "$1 - $3", min: 1, max: 3 },
    { id: "4-6", label: "$4 - $6", min: 4, max: 6 },
    { id: "7-9", label: "$7 - $9", min: 7, max: 9 },
    { id: "10", label: "$10 Max", min: 10, max: 10 },
  ];

  const visible = useMemo(() => {
    let next = products.filter((product) => {
      const categoryMatch = categoryId === "All" || String(product.category_id) === String(categoryId);
      const haystack = `${product.name} ${product.category} ${product.description || ""}`.toLowerCase();
      const headerMatch = !query.trim() || haystack.includes(query.trim().toLowerCase());
      const sidebarMatch = !sidebarQuery.trim() || haystack.includes(sidebarQuery.trim().toLowerCase());
      const priceMatch = priceFilters.length === 0 || priceRanges.some((range) => priceFilters.includes(range.id) && Number(product.price) >= range.min && Number(product.price) <= range.max);
      return categoryMatch && headerMatch && sidebarMatch && priceMatch;
    });
    if (sort === "low") next = [...next].sort((a, b) => Number(a.price) - Number(b.price));
    if (sort === "high") next = [...next].sort((a, b) => Number(b.price) - Number(a.price));
    if (sort === "az") next = [...next].sort((a, b) => a.name.localeCompare(b.name));
    return next;
  }, [products, categoryId, sort, query, sidebarQuery, priceFilters]);
  const pageCount = Math.max(1, Math.ceil(visible.length / productsPerPage));
  const safePage = Math.min(page, pageCount);
  const pagedProducts = visible.slice((safePage - 1) * productsPerPage, safePage * productsPerPage);
  const showingFrom = visible.length ? (safePage - 1) * productsPerPage + 1 : 0;
  const showingTo = Math.min(safePage * productsPerPage, visible.length);

  useEffect(() => {
    setPage(1);
  }, [categoryId, sort, query, sidebarQuery, priceFilters.join(","), view]);

  return React.createElement(React.Fragment, null,
    React.createElement(Breadcrumb, { title: "Shop Grid", trail: "Home / Shop / Men's Fashion" }),
    React.createElement("main", { className: "shop-layout" },
      React.createElement(Sidebar, { categories, categoryId, setCategoryId, sidebarQuery, setSidebarQuery, priceFilters, setPriceFilters, priceRanges }),
      React.createElement("section", { className: "shop-main" },
        React.createElement(Toolbar, { count: visible.length, from: showingFrom, to: showingTo, sort, setSort, view, setView }),
        visible.length ? React.createElement("div", { className: view === "grid" ? "product-grid" : "product-list" }, pagedProducts.map((product) => React.createElement(ProductCard, { key: product.id, product, settings, view, addToCart, navigate }))) : React.createElement("div", { className: "empty-state" }, React.createElement("h2", null, "No products found"), React.createElement("p", null, "Try another search, category, or price range.")),
        visible.length > productsPerPage && React.createElement(Pagination, { page: safePage, pageCount, setPage })
      )
    ),
    React.createElement("button", { className: "mobile-filter-toggle", onClick: () => setFiltersOpen(true), title: "Search / Filter", type: "button" }, React.createElement("span", { className: "filter-fab-icon" }, "⌕")),
    filtersOpen && React.createElement("div", { className: "mobile-filter-panel" },
      React.createElement("button", { className: "mobile-filter-backdrop", onClick: () => setFiltersOpen(false), type: "button", "aria-label": "Close filters" }),
      React.createElement("aside", { className: "mobile-filter-drawer" },
        React.createElement("div", { className: "mobile-filter-head" }, React.createElement("strong", null, React.createElement("span", { className: "filter-title-icon" }, "⌕"), "Search & Filters"), React.createElement("button", { onClick: () => setFiltersOpen(false), type: "button" }, "×")),
        React.createElement(Sidebar, { categories, categoryId, setCategoryId, sidebarQuery, setSidebarQuery, priceFilters, setPriceFilters, priceRanges }),
        React.createElement("button", { className: "btn primary mobile-apply", onClick: () => setFiltersOpen(false), type: "button" }, React.createElement("span", { className: "btn-icon" }, "✓"), "Show Products")
      )
    )
  );
}

function Breadcrumb({ title, trail }) {
  return React.createElement("section", { className: "breadcrumb" }, React.createElement("h1", null, title), React.createElement("p", null, trail || `Home / ${title}`));
}

function Sidebar({ categories, categoryId, setCategoryId, sidebarQuery, setSidebarQuery, priceFilters, setPriceFilters, priceRanges }) {
  function togglePrice(id) {
    setPriceFilters(priceFilters.includes(id) ? priceFilters.filter((item) => item !== id) : [...priceFilters, id]);
  }

  return React.createElement("aside", { className: "sidebar" },
    React.createElement(FilterBlock, { icon: "⌕", title: "Search Product" }, React.createElement("div", { className: "sidebar-search-wrap" }, React.createElement("span", null, "⌕"), React.createElement("input", { className: "sidebar-input", value: sidebarQuery, onChange: (event) => setSidebarQuery(event.target.value), placeholder: "Search here..." }))),
    React.createElement(FilterBlock, { icon: "▦", title: "All Categories" },
      React.createElement("button", { className: categoryId === "All" ? "filter-link active" : "filter-link", onClick: () => setCategoryId("All"), type: "button" }, React.createElement("span", { className: "filter-link-icon" }, "▤"), "All Men's Fashion", React.createElement("span", { className: "filter-chev" }, "›")),
      categories.map((cat) => React.createElement("button", { className: String(categoryId) === String(cat.id) ? "filter-link active" : "filter-link", key: cat.id, onClick: () => setCategoryId(cat.id), type: "button" }, React.createElement("span", { className: "filter-link-icon" }, "•"), cat.name, React.createElement("span", { className: "filter-chev" }, "›")))
    ),
    React.createElement(FilterBlock, { icon: "$", title: "Price Range" }, React.createElement("div", { className: "price-widget" }, React.createElement("span", null, "$1"), React.createElement("div", { className: "price-line" }, React.createElement("i", null)), React.createElement("span", null, "$10"))),
    React.createElement(FilterBlock, { icon: "✓", title: "Filter by Price" }, priceRanges.map((item) => React.createElement("label", { className: "check-row", key: item.id }, React.createElement("input", { checked: priceFilters.includes(item.id), onChange: () => togglePrice(item.id), type: "checkbox" }), React.createElement("span", { className: "check-icon" }, "$"), React.createElement("span", null, item.label))))
  );
}

function FilterBlock({ icon, title, children }) {
  return React.createElement("div", { className: "filter-block" }, React.createElement("h3", null, icon && React.createElement("span", { className: "filter-block-icon" }, icon), title), children);
}

function Toolbar({ count, from, to, sort, setSort, view, setView }) {
  return React.createElement("div", { className: "toolbar" },
    React.createElement("div", { className: "sort" }, React.createElement("label", null, "Sort by:"), React.createElement("select", { value: sort, onChange: (event) => setSort(event.target.value) }, React.createElement("option", { value: "popular" }, "Popularity"), React.createElement("option", { value: "low" }, "Low - High Price"), React.createElement("option", { value: "high" }, "High - Low Price"), React.createElement("option", { value: "az" }, "A - Z Order"))),
    React.createElement("strong", null, count ? `Showing: ${from} - ${to} of ${count} items` : "Showing: 0 items"),
    React.createElement("div", { className: "view-toggle" }, React.createElement("button", { className: view === "grid" ? "active" : "", onClick: () => setView("grid"), type: "button" }, "Grid"), React.createElement("button", { className: view === "list" ? "active" : "", onClick: () => setView("list"), type: "button" }, "List"))
  );
}

function ProductCard({ product, settings = {}, view = "grid", addToCart, navigate }) {
  const mainImage = getProductImages(product)[0];
  const needsSize = getProductSizes(product).length > 0;
  return React.createElement("article", { className: `product-card ${view}`, onClick: () => navigate("product/" + product.id), role: "button", tabIndex: 0 },
    React.createElement("div", { className: "product-image" },
      React.createElement("a", { className: "product-card-link", href: `#/product/${product.id}`, "aria-label": `View ${product.name}` }),
      product.badge && React.createElement("span", { className: "badge" }, product.badge),
      settings.product_badge_logo && React.createElement("span", { className: "product-badge-logo" }, React.createElement("img", { src: settings.product_badge_logo, alt: "ONE TEN badge" })),
      React.createElement("img", { src: mainImage, alt: product.name, decoding: "async", loading: "lazy", style: { objectPosition: product.crop || "center" } }),
      React.createElement("div", { className: "hover-actions" }, React.createElement("button", { onClick: (event) => { event.stopPropagation(); navigate("product/" + product.id); }, type: "button" }, "View"), React.createElement("button", { onClick: (event) => { event.stopPropagation(); needsSize ? navigate("product/" + product.id) : addToCart(product); }, type: "button" }, needsSize ? "Choose Size" : "Add to Cart"))
    ),
    React.createElement("div", { className: "product-content" }, React.createElement("span", { className: "category" }, product.category), React.createElement("h3", null, React.createElement("a", { href: `#/product/${product.id}`, onClick: (event) => event.stopPropagation() }, product.name)), React.createElement("div", { className: "rating" }, React.createElement("span", null, "Rating"), React.createElement("strong", null, product.rating || "4.8"), React.createElement("em", null, "Review(s)")), React.createElement("div", { className: "price" }, React.createElement("strong", null, `$${Number(product.price).toFixed(2)}`), product.old_price && React.createElement("del", null, `$${Number(product.old_price).toFixed(2)}`)))
  );
}

function ProductPage({ product, products = [], settings = {}, addToCart, navigate }) {
  const [detailProduct, setDetailProduct] = useState(null);
  useEffect(() => {
    setDetailProduct(null);
    if (!product) return undefined;
    let cancelled = false;
    api(`/api/public/products/${product.id}`)
      .then((payload) => {
        if (!cancelled && payload.product) setDetailProduct({ ...product, ...payload.product });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [product && product.id]);
  const currentProduct = detailProduct || product;
  const images = currentProduct ? getProductImages(currentProduct) : [assets.products];
  const [activeImage, setActiveImage] = useState(images[0]);
  const [selectedSize, setSelectedSize] = useState("");
  const [qty, setQty] = useState(1);
  const [message, setMessage] = useState("");
  useEffect(() => setActiveImage(images[0]), [currentProduct && currentProduct.id, images[0]]);
  useEffect(() => {
    const sizes = getProductSizes(currentProduct);
    setSelectedSize(sizes[0] ? sizes[0].size : "");
    setQty(1);
    setMessage("");
  }, [currentProduct && currentProduct.id]);
  if (!currentProduct) return React.createElement(NotFoundPage, { navigate });
  const availableSizes = getProductSizes(currentProduct);
  const selectedStock = getSizeStock(currentProduct, selectedSize);
  function addSelectedToCart() {
    if (availableSizes.length && !selectedSize) {
      setMessage("Macmiil, size-kan waxba kama yaalaan. Fadlan dooro size stock leh.");
      return;
    }
    if (qty > selectedStock) {
      setMessage(`Kaliya ${selectedStock} ayaa ka yaalla size ${selectedSize || "kan"}.`);
      return;
    }
    if (addToCart(currentProduct, selectedSize, qty)) setMessage("");
  }
  const relatedByCategory = products
    .filter((item) => String(item.id) !== String(currentProduct.id) && (String(item.category_id) === String(currentProduct.category_id) || item.category === currentProduct.category))
    .slice(0, 4);
  const related = relatedByCategory.length ? relatedByCategory : products.filter((item) => String(item.id) !== String(currentProduct.id)).slice(0, 4);
  return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: currentProduct.name, trail: `Home / Shop / ${currentProduct.name}` }), React.createElement("main", { className: "detail-page" }, React.createElement("div", { className: "detail-media" },
    React.createElement("img", { src: activeImage || images[0], alt: currentProduct.name, decoding: "async", loading: "eager", style: { objectPosition: currentProduct.crop || "center" } }),
    images.length > 1 && React.createElement("div", { className: "detail-thumbs" }, images.map((image, index) => React.createElement("button", { className: image === activeImage ? "active" : "", key: `${image}-${index}`, onClick: () => setActiveImage(image), type: "button" }, React.createElement("img", { src: image, alt: `${currentProduct.name} ${index + 1}`, decoding: "async", loading: "lazy" }))))
  ), React.createElement("div", { className: "detail-info" }, React.createElement("p", { className: "eyebrow" }, currentProduct.category), React.createElement("h2", null, currentProduct.name), React.createElement("p", null, currentProduct.description), React.createElement("div", { className: "price detail-price" }, React.createElement("strong", null, `$${Number(currentProduct.price).toFixed(2)}`), currentProduct.old_price && React.createElement("del", null, `$${Number(currentProduct.old_price).toFixed(2)}`)),
    availableSizes.length > 0 && React.createElement("div", { className: "size-picker" },
      React.createElement("div", { className: "size-picker-head" }, React.createElement("strong", null, "Choose Size"), React.createElement("span", null, selectedSize ? `${selectedStock} available` : "Select a size")),
      React.createElement("div", { className: "size-options" }, availableSizes.map((item) => React.createElement("button", { className: selectedSize === item.size ? "active" : "", key: item.size, onClick: () => { setSelectedSize(item.size); setQty(1); setMessage(""); }, type: "button" }, React.createElement("span", null, item.size), React.createElement("em", null, item.stock))))
    ),
    React.createElement("div", { className: "detail-buy-row" },
      React.createElement("label", null, React.createElement("span", null, "Qty"), React.createElement("input", { max: selectedStock || currentProduct.stock || 1, min: "1", onChange: (event) => setQty(Math.max(1, Number(event.target.value) || 1)), type: "number", value: qty })),
      React.createElement("p", null, `Stock: ${availableSizes.length ? selectedStock : currentProduct.stock}`)
    ),
    message && React.createElement("p", { className: "stock-message" }, message),
    React.createElement("button", { className: "btn primary", disabled: selectedStock <= 0, onClick: addSelectedToCart, type: "button" }, selectedStock <= 0 ? "Out of Stock" : "Add to Cart")
  )),
    related.length > 0 && React.createElement("section", { className: "section related-products" },
      React.createElement("div", { className: "section-head" }, React.createElement("div", null, React.createElement("p", { className: "eyebrow" }, "Similar style"), React.createElement("h2", null, "Products close to this"))),
      React.createElement("div", { className: "product-grid" }, related.map((item) => React.createElement(ProductCard, { key: item.id, product: item, settings, addToCart, navigate })))
    )
  );
}

function AboutPage({ settings }) {
  return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: "About Us" }), React.createElement("section", { className: "content-page split-page" }, React.createElement("div", null, React.createElement("p", { className: "eyebrow" }, settings.about_eyebrow || "ONE TEN story"), React.createElement("h2", null, settings.about_title || "Affordable men's fashion with a sharp street look."), React.createElement("p", null, settings.about_body || "ONE TEN focuses on simple, clean menswear for daily outfits. Every product stays between $1 and $10, with fast local delivery and a bold red, white, and black identity.")), React.createElement("img", { src: settings.about_image || assets.hero, alt: "ONE TEN men's fashion campaign" })));
}

function ContactPage({ settings }) {
  return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: "Contact Us" }), React.createElement("section", { className: "content-page contact-grid" }, React.createElement("div", { className: "info-card" }, React.createElement("h3", null, settings.contact_title || "Get In Touch"), React.createElement("p", null, `Phone: ${settings.phone || "+252 63 000 1010"}`), React.createElement("p", null, `Hotline: ${settings.hotline || "(+252) 63 000 1010"}`), React.createElement("p", null, `Email: ${settings.email || "support@oneten.shop"}`), React.createElement("p", null, `Location: ${settings.location || "Hargaysa"}`)), React.createElement("form", { className: "form-card", onSubmit: (event) => event.preventDefault() }, React.createElement("input", { placeholder: "Your name" }), React.createElement("input", { placeholder: "Your email" }), React.createElement("textarea", { placeholder: "Message" }), React.createElement("button", { type: "submit" }, "Send Message"))));
}

function CartPage({ cart, setCart, total, navigate }) {
  const [message, setMessage] = useState("");
  function updateQty(target, qty) {
    const requested = Math.max(1, Number(qty) || 1);
    const hasSizeInventory = getProductSizes(target).length > 0;
    const maxStock = hasSizeInventory ? Math.max(0, Number(target.sizeStock) || 0) : Math.max(0, Number(target.stock) || 0);
    if (hasSizeInventory && !target.size) {
      setMessage("Product-kan size ayaa looga baahan yahay. Ka saar cart-ka oo mar kale size dooro.");
      return;
    }
    if (maxStock <= 0) {
      setMessage(`${target.size ? `Size ${target.size}` : target.name} stock kama yaallo hadda.`);
      return;
    }
    if (requested > maxStock) {
      setMessage(`Kaliya ${maxStock} ayaa ka yaalla ${target.size ? `size ${target.size}` : target.name}.`);
      return;
    }
    setMessage("");
    setCart(cart.map((item) => cartKey(item) === cartKey(target) ? { id: item.id, size: item.size || "", qty: requested } : { id: item.id, size: item.size || "", qty: item.qty }));
  }
  function changeQty(target, delta) {
    updateQty(target, Number(target.qty) + delta);
  }
  const emptyCart = React.createElement("div", { className: "empty-state" },
    React.createElement("h2", null, "Cart is empty"),
    React.createElement("button", { className: "btn primary", onClick: () => navigate("shop") }, "Shop now")
  );
  const fullCart = React.createElement("div", { className: "cart-layout" },
    React.createElement("div", { className: "cart-list" },
      React.createElement("div", { className: "mobile-page-title" }, React.createElement("button", { onClick: () => navigate("shop"), type: "button" }, React.createElement(Icon, { name: "back" })), React.createElement("h2", null, "Cart"), React.createElement("button", { type: "button" }, React.createElement(Icon, { name: "menu" }))),
      React.createElement("div", { className: "cart-total-line" }, "Total Item", React.createElement("span", null, `(${cart.length})`)),
      message && React.createElement("p", { className: "stock-message cart-stock-message" }, message),
      cart.map((item) => React.createElement("article", { className: "cart-item", key: cartKey(item) },
        React.createElement("span", { className: "cart-check" }, React.createElement(Icon, { name: "check" })),
        React.createElement("img", { src: item.image, alt: item.name, style: { objectPosition: item.crop || "center" } }),
        React.createElement("div", null,
          React.createElement("h3", null, item.name),
          React.createElement("p", null, `$${Number(item.price).toFixed(2)}`, item.old_price && React.createElement("del", null, `$${Number(item.old_price).toFixed(2)}`)),
          item.size && React.createElement("span", { className: "cart-size-pill" }, `Size ${item.size} / ${item.sizeStock} left`)
        ),
        React.createElement("div", { className: "qty-stepper" },
          React.createElement("button", { onClick: () => changeQty(item, -1), type: "button" }, React.createElement(Icon, { name: "minus" })),
          React.createElement("input", { max: getProductSizes(item).length ? item.sizeStock || 1 : item.stock || 1, min: "1", onChange: (event) => updateQty(item, Number(event.target.value)), type: "number", value: item.qty }),
          React.createElement("button", { onClick: () => changeQty(item, 1), type: "button" }, React.createElement(Icon, { name: "plus" }))
        ),
        React.createElement("strong", { className: "cart-line-total" }, `$${Number(item.price * item.qty).toFixed(2)}`),
        React.createElement("button", { onClick: () => setCart(cart.filter((cartItem) => cartKey(cartItem) !== cartKey(item)).map((cartItem) => ({ id: cartItem.id, size: cartItem.size || "", qty: cartItem.qty }))), type: "button" }, "Remove")
      ))
    ),
    React.createElement("aside", { className: "summary" },
      React.createElement("h3", null, "Cart Total"),
      React.createElement("p", null, `Subtotal: $${total.toFixed(2)}`),
      React.createElement("p", null, "Delivery: $0.00"),
      React.createElement("strong", null, `Total: $${total.toFixed(2)}`),
      React.createElement("button", { className: "btn primary", onClick: () => navigate("checkout") }, "Checkout")
    )
  );
  return React.createElement(React.Fragment, null,
    React.createElement(Breadcrumb, { title: "Cart" }),
    React.createElement("section", { className: "content-page" }, cart.length === 0 ? emptyCart : fullCart)
  );
}

function CheckoutPage({ cart, total, customer, setCart, navigate }) {
  const [form, setForm] = useState({ phone: "", address: "" });
  const [message, setMessage] = useState("");

  if (!customer) {
    return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: "Checkout" }), React.createElement("section", { className: "content-page empty-state" }, React.createElement("h2", null, "Register or sign in before ordering"), React.createElement("p", null, "You can view all products without an account, but ordering requires registration."), React.createElement("div", { className: "home-actions" }, React.createElement("a", { className: "btn primary", href: "#/register" }, "Register"), React.createElement("a", { className: "btn ghost", href: "#/signin" }, "Sign In"))));
  }

  function submit(event) {
    event.preventDefault();
    const invalidItem = cart.find((item) => {
      const hasSizeInventory = getProductSizes(item).length > 0;
      const available = hasSizeInventory ? Number(item.sizeStock || 0) : Number(item.stock || 0);
      return (hasSizeInventory && !item.size) || available <= 0 || Number(item.qty) > available;
    });
    if (invalidItem) {
      const available = getProductSizes(invalidItem).length ? Number(invalidItem.sizeStock || 0) : Number(invalidItem.stock || 0);
      setMessage(available > 0 ? `Kaliya ${available} ayaa ka yaalla ${invalidItem.name}${invalidItem.size ? ` size ${invalidItem.size}` : ""}.` : `${invalidItem.name}${invalidItem.size ? ` size ${invalidItem.size}` : ""} stock kama yaallo hadda.`);
      return;
    }
    api("/api/orders", { method: "POST", body: JSON.stringify({ ...form, items: cart.map((item) => ({ id: item.id, size: item.size || "", qty: item.qty })) }) })
      .then((order) => {
        setCart([]);
        setMessage(`Order #${order.id} received`);
      })
      .catch((error) => setMessage(error.message));
  }

  return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: "Checkout" }), React.createElement("section", { className: "content-page checkout-grid" }, React.createElement("form", { className: "form-card", onSubmit: submit }, React.createElement("h2", null, "Billing Details"), message && React.createElement("p", { className: "form-message" }, message), React.createElement("input", { disabled: true, value: customer.name }), React.createElement("input", { placeholder: "Phone number", required: true, value: form.phone, onChange: (event) => setForm({ ...form, phone: event.target.value }) }), React.createElement("textarea", { placeholder: "Delivery address", value: form.address, onChange: (event) => setForm({ ...form, address: event.target.value }) }), React.createElement("button", { disabled: cart.length === 0, type: "submit" }, "Place Order")), React.createElement("aside", { className: "summary checkout-summary" }, React.createElement("h3", null, "Order Summary"), React.createElement("div", { className: "checkout-products-grid" }, cart.map((item) => React.createElement("div", { className: "checkout-product-mini", key: cartKey(item) }, React.createElement("img", { src: item.image, alt: item.name }), React.createElement("span", null, item.size ? `${item.name} / ${item.size}` : item.name), React.createElement("strong", null, `x${item.qty}`)))), React.createElement("p", null, `${cart.length} product lines`), React.createElement("strong", null, `$${total.toFixed(2)}`), React.createElement("button", { className: "btn ghost", onClick: () => navigate("cart") }, "Back to cart"))));
}

function ProfilePage({ customer, navigate, logout }) {
  if (!customer) {
    return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: "Profile" }), React.createElement("section", { className: "content-page empty-state" }, React.createElement("h2", null, "Sign in to see your profile"), React.createElement("button", { className: "btn primary", onClick: () => navigate("signin"), type: "button" }, "Sign In")));
  }

  return React.createElement(React.Fragment, null,
    React.createElement(Breadcrumb, { title: "Profile" }),
    React.createElement("section", { className: "content-page profile-page" },
      React.createElement("div", { className: "profile-card" },
        React.createElement("div", { className: "profile-avatar" }, customer.name ? customer.name.slice(0, 1).toUpperCase() : "U"),
        React.createElement("h2", null, customer.name),
        React.createElement("p", null, customer.email),
        React.createElement("div", { className: "profile-actions" },
          React.createElement("button", { className: "btn primary", onClick: () => navigate("order-history"), type: "button" }, "Order History"),
          React.createElement("button", { className: "btn ghost", onClick: () => navigate("checkout"), type: "button" }, "Checkout"),
          React.createElement("button", { className: "btn ghost", onClick: logout, type: "button" }, "Logout")
        )
      )
    )
  );
}

function OrderHistoryPage({ customer, navigate }) {
  const [orders, setOrders] = useState([]);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState("Delivered");

  useEffect(() => {
    if (!customer) return;
    api("/api/customer/orders")
      .then((payload) => setOrders(payload.orders || []))
      .catch((error) => setMessage(error.message));
  }, [customer && customer.id]);

  if (!customer) {
    return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: "Order History" }), React.createElement("section", { className: "content-page empty-state" }, React.createElement("h2", null, "Sign in to see orders"), React.createElement("button", { className: "btn primary", onClick: () => navigate("signin"), type: "button" }, "Sign In")));
  }

  const tabMatches = (order) => {
    const status = String(order.status || "").toLowerCase();
    if (tab === "Delivered") return status === "delivered";
    if (tab === "Cancelled") return status === "cancelled" || status === "canceled";
    return status && status !== "delivered" && status !== "cancelled" && status !== "canceled";
  };
  const filteredOrders = orders.filter(tabMatches);

  return React.createElement(React.Fragment, null,
    React.createElement(Breadcrumb, { title: "Order History" }),
    React.createElement("section", { className: "content-page order-history-page" },
      React.createElement("div", { className: "mobile-page-title" }, React.createElement("button", { onClick: () => navigate("shop"), type: "button" }, React.createElement(Icon, { name: "back" })), React.createElement("h2", null, "Order History"), React.createElement("span", null)),
      React.createElement("div", { className: "history-tabs" }, ["Delivered", "In Transit", "Cancelled"].map((item) => React.createElement("button", { className: tab === item ? "active" : "", key: item, onClick: () => setTab(item), type: "button" }, item))),
      message && React.createElement("p", { className: "form-message" }, message),
      filteredOrders.length ? filteredOrders.map((order) => React.createElement("article", { className: "history-order", key: order.id },
        React.createElement("span", { className: "cart-check" }, React.createElement(Icon, { name: "check" })),
        React.createElement("div", { className: "history-items" },
          React.createElement("div", { className: "history-meta" }, React.createElement("strong", null, `Order #${order.id}`), React.createElement("span", null, order.status || "Processing")),
          (order.order_items || []).slice(0, 3).map((item) => React.createElement("div", { className: "history-item", key: item.id },
            React.createElement("img", { src: item.product_image || assets.products, alt: item.product_name }),
            React.createElement("div", null, React.createElement("h3", null, item.product_name), React.createElement("p", null, item.size ? `$${Number(item.price).toFixed(2)} / Size ${item.size}` : `$${Number(item.price).toFixed(2)}`)),
            React.createElement("span", null, `x${item.qty}`)
          ))
        )
      )) : React.createElement("div", { className: "empty-state" }, React.createElement("h2", null, orders.length ? `No ${tab.toLowerCase()} orders` : "No orders yet"), React.createElement("button", { className: "btn primary", onClick: () => navigate("shop"), type: "button" }, "Shop Now")),
      React.createElement("button", { className: "btn primary reorder-btn", onClick: () => navigate("shop"), type: "button" }, "Re - Order")
    )
  );
}

function AuthPage({ mode, setCustomer, navigate }) {
  const register = mode === "register";
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [message, setMessage] = useState("");

  function submit(event) {
    event.preventDefault();
    api(register ? "/api/customer/register" : "/api/customer/login", { method: "POST", body: JSON.stringify(form) })
      .then((data) => {
        localStorage.setItem("customerToken", data.token);
        setCustomer(data.user);
        navigate("profile");
      })
      .catch((error) => setMessage(error.message));
  }

  return React.createElement(React.Fragment, null, React.createElement(Breadcrumb, { title: register ? "Register" : "Sign In" }), React.createElement("section", { className: "auth-wrap" }, React.createElement("form", { className: "form-card", onSubmit: submit }, React.createElement("h2", null, register ? "Create account" : "Welcome back"), message && React.createElement("p", { className: "form-message" }, message), register && React.createElement("input", { placeholder: "Full name", required: true, value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) }), React.createElement("input", { placeholder: "Email address", required: true, type: "email", value: form.email, onChange: (event) => setForm({ ...form, email: event.target.value }) }), React.createElement("input", { placeholder: "Password", required: true, type: "password", value: form.password, onChange: (event) => setForm({ ...form, password: event.target.value }) }), React.createElement("button", { type: "submit" }, register ? "Register" : "Sign In"), React.createElement("a", { href: register ? "#/signin" : "#/register" }, register ? "Already have an account?" : "Create new account"))));
}

function Pagination({ page, pageCount, setPage }) {
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
  const visiblePages = pages.length <= 4 ? pages : pages.slice(Math.max(0, Math.min(page - 2, pages.length - 4)), Math.max(4, Math.min(page + 2, pages.length)));
  return React.createElement("div", { className: "pagination", "aria-label": "Product pages" },
    visiblePages.map((item) => React.createElement("button", { className: item === page ? "active" : "", key: item, onClick: () => setPage(item), type: "button" }, item)),
    page < pageCount && React.createElement("button", { className: "next", onClick: () => setPage(page + 1), type: "button" }, "Next")
  );
}

function Newsletter() {
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");

  function submit(event) {
    event.preventDefault();
    api("/api/newsletter", { method: "POST", body: JSON.stringify({ phone }) })
      .then(() => {
        setMessage("Phone number saved. We will send ONE TEN updates.");
        setPhone("");
      })
      .catch((error) => setMessage(error.message));
  }

  return React.createElement("section", { className: "newsletter" }, React.createElement("div", null, React.createElement("h2", null, "Subscribe to our Newsletter"), React.createElement("p", null, "Get all the latest $1-$10 drops, flash sales, and ONE TEN outfit updates."), message && React.createElement("span", { className: "newsletter-message" }, message)), React.createElement("form", { onSubmit: submit }, React.createElement("input", { placeholder: "Your phone number", required: true, type: "tel", value: phone, onChange: (event) => setPhone(event.target.value) }), React.createElement("button", { type: "submit" }, "Subscribe")));
}

function Footer({ settings }) {
  const infoLinks = Array.isArray(settings.information_links) ? settings.information_links : [{ label: "About Us", href: "#/about" }, { label: "Contact Us", href: "#/contact" }, { label: "Shop Grid", href: "#/shop" }];
  const departmentLinks = Array.isArray(settings.department_links) ? settings.department_links : [{ label: "Shirts", href: "#/shop" }, { label: "Accessories", href: "#/shop" }, { label: "Admin Login", href: "/admin" }];
  return React.createElement("footer", { className: "footer" },
    React.createElement("div", { className: "footer-brand" }, React.createElement("img", { src: settings.footer_logo || settings.logo_night || settings.logo_image || assets.logoWhite, alt: "ONE TEN" }), React.createElement("p", null, settings.footer_text || "Men's fashion, clean prices, Hargaysa delivery.")),
    React.createElement("div", null, React.createElement("h3", null, settings.contact_title || "Get In Touch"), React.createElement("p", null, `Phone: ${settings.phone || "+252 63 000 1010"}`), React.createElement("p", null, settings.email || "support@oneten.shop")),
    React.createElement("div", null, React.createElement("h3", null, "Information"), infoLinks.map((link, index) => React.createElement("a", { href: link.href, key: index }, link.label))),
    React.createElement("div", null, React.createElement("h3", null, "Shop Departments"), departmentLinks.map((link, index) => React.createElement("a", { href: link.href, key: index }, link.label)))
  );
}

function NotFoundPage({ navigate }) {
  return React.createElement("section", { className: "content-page empty-state" }, React.createElement("h2", null, "Page not found"), React.createElement("button", { className: "btn primary", onClick: () => navigate("home") }, "Back home"));
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
