/**
 * BookTG — бэкенд мини-аппа «личная библиотека + подписка».
 * Один файл: авторизация через Telegram, загрузка книг, библиотека,
 * подписка через Telegram Stars (XTR) и вебхук для оплаты.
 *
 * Запуск: задай переменные окружения (см. .env.example) и `npm start`.
 */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// ---------- Конфиг ----------
const BOT_TOKEN = process.env.BOT_TOKEN || "";          // токен от @BotFather (обязательно)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "hook"; // секрет в пути вебхука
const STAR_PRICE = parseInt(process.env.STAR_PRICE || "150", 10); // цена подписки в Stars / мес
const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || "3", 10);   // сколько книг бесплатно
// Telegram ID владельцев, которые могут наполнять каталог (через запятую). Узнать свой ID: @userinfobot
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const SUB_PERIOD = 2592000; // 30 дней в секундах — требование Telegram для star-подписок

if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан — авторизация и оплата работать не будут.");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- База данных (простое JSON-хранилище) ----------
// Для MVP этого достаточно. Для роста замените на PostgreSQL (см. README).
const DB_FILE = path.join(DATA_DIR, "db.json");
let store = { users: {}, books: [], bookSeq: 1, catalog: [], catalogSeq: 1 };
try {
  store = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch { /* первый запуск */ }
// миграция: на случай старого файла без каталога
if (!store.catalog) store.catalog = [];
if (!store.catalogSeq) store.catalogSeq = 1;
let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    try { fs.writeFileSync(DB_FILE, JSON.stringify(store)); }
    catch (e) { console.error("db write error", e); }
  });
}

const now = () => Math.floor(Date.now() / 1000);
const isPremium = (u) => u && (u.premium_until || 0) > now();
const isAdmin = (u) => u && ADMIN_IDS.includes(u.id);

// ---------- Авторизация через Telegram initData ----------
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (calc !== hash) return null;
  // свежесть подписи — не старше 24 часов
  const authDate = Number(params.get("auth_date") || 0);
  if (now() - authDate > 86400) return null;
  try {
    return JSON.parse(params.get("user"));
  } catch {
    return null;
  }
}

function upsertUser(tgUser) {
  let u = store.users[tgUser.id];
  if (!u) {
    u = { id: tgUser.id, first_name: tgUser.first_name || "", username: tgUser.username || "", premium_until: 0, created: now() };
    store.users[tgUser.id] = u;
  } else {
    u.first_name = tgUser.first_name || "";
    u.username = tgUser.username || "";
  }
  persist();
  return u;
}

// middleware: достаёт пользователя из заголовка X-Init-Data
function auth(req, res, next) {
  const initData = req.get("X-Init-Data") || req.body?.initData || "";
  const tgUser = verifyInitData(initData);
  if (!tgUser) return res.status(401).json({ error: "unauthorized" });
  req.user = upsertUser(tgUser);
  next();
}

// ---------- Telegram Bot API ----------
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

// ---------- Загрузка файлов ----------
const ALLOWED = new Set([".txt", ".epub", ".pdf"]);
function mimeFor(ext) {
  if (ext === ".epub") return "application/epub+zip";
  if (ext === ".pdf") return "application/pdf";
  return "text/plain";
}
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024 }, // 40 МБ (с запасом под PDF)
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED.has(ext));
  },
});

// ---------- Сервер ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// профиль + библиотека
app.post("/api/me", auth, (req, res) => {
  const books = store.books
    .filter((b) => b.user_id === req.user.id)
    .sort((a, b) => b.created - a.created)
    .map(({ id, title, author, mime, size, progress, created }) => ({ id, title, author, mime, size, progress, created }));
  res.json({
    user: { id: req.user.id, name: req.user.first_name, username: req.user.username },
    premium: isPremium(req.user),
    premiumUntil: req.user.premium_until,
    isAdmin: isAdmin(req.user),
    freeLimit: FREE_LIMIT,
    starPrice: STAR_PRICE,
    books,
    catalog: store.catalog
      .slice()
      .sort((a, b) => b.created - a.created)
      .map(({ id, title, author, mime, size, free, created }) => ({ id, title, author, mime, size, free: !!free, created })),
  });
});

// загрузка книги
app.post("/api/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Поддерживаются .txt, .epub и .pdf до 40 МБ" });
  const count = store.books.filter((b) => b.user_id === req.user.id).length;
  if (!isPremium(req.user) && count >= FREE_LIMIT) {
    fs.unlink(req.file.path, () => {});
    return res.status(402).json({ error: "limit", message: `Бесплатно можно хранить ${FREE_LIMIT} книги. Оформите премиум для безлимита.` });
  }
  const title = (req.body.title || req.file.originalname.replace(/\.[^.]+$/, "")).slice(0, 200);
  const author = (req.body.author || "").slice(0, 120);
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mime = mimeFor(ext);
  const book = {
    id: store.bookSeq++, user_id: req.user.id, title, author,
    filename: req.file.filename, mime, size: req.file.size, progress: 0, created: now(),
  };
  store.books.push(book);
  persist();
  res.json({ id: book.id, title, author, mime, size: req.file.size, progress: 0 });
});

// содержимое книги (стрим файла, проверка владельца)
app.post("/api/file/:id", auth, (req, res) => {
  const book = store.books.find((b) => b.id === +req.params.id && b.user_id === req.user.id);
  if (!book) return res.status(404).json({ error: "not found" });
  const fp = path.join(UPLOAD_DIR, book.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "file missing" });
  res.setHeader("Content-Type", book.mime);
  fs.createReadStream(fp).pipe(res);
});

// сохранить прогресс чтения
app.post("/api/progress/:id", auth, (req, res) => {
  const p = Math.max(0, Math.min(1, Number(req.body.progress) || 0));
  const book = store.books.find((b) => b.id === +req.params.id && b.user_id === req.user.id);
  if (book) { book.progress = p; persist(); }
  res.json({ ok: true });
});

// удалить книгу
app.post("/api/delete/:id", auth, (req, res) => {
  const i = store.books.findIndex((b) => b.id === +req.params.id && b.user_id === req.user.id);
  if (i >= 0) {
    fs.unlink(path.join(UPLOAD_DIR, store.books[i].filename), () => {});
    store.books.splice(i, 1);
    persist();
  }
  res.json({ ok: true });
});

// ---------- Каталог (общие книги, наполняет только админ) ----------
// добавить книгу в каталог
app.post("/api/catalog/upload", auth, upload.single("file"), (req, res) => {
  if (!isAdmin(req.user)) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: "forbidden" }); }
  if (!req.file) return res.status(400).json({ error: "Поддерживаются .txt, .epub и .pdf до 40 МБ" });
  const title = (req.body.title || req.file.originalname.replace(/\.[^.]+$/, "")).slice(0, 200);
  const author = (req.body.author || "").slice(0, 120);
  const free = req.body.free === "1" || req.body.free === "true"; // бесплатный ли (доступен без подписки)
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mime = mimeFor(ext);
  const book = { id: store.catalogSeq++, title, author, filename: req.file.filename, mime, size: req.file.size, free, created: now() };
  store.catalog.push(book);
  persist();
  res.json({ id: book.id, title, author, mime, size: req.file.size, free });
});

// содержимое книги из каталога — нужна подписка (кроме помеченных free)
app.post("/api/catalog/file/:id", auth, (req, res) => {
  const book = store.catalog.find((b) => b.id === +req.params.id);
  if (!book) return res.status(404).json({ error: "not found" });
  if (!book.free && !isPremium(req.user) && !isAdmin(req.user)) {
    return res.status(402).json({ error: "premium_required" });
  }
  const fp = path.join(UPLOAD_DIR, book.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "file missing" });
  res.setHeader("Content-Type", book.mime);
  fs.createReadStream(fp).pipe(res);
});

// удалить книгу из каталога (только админ)
app.post("/api/catalog/delete/:id", auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "forbidden" });
  const i = store.catalog.findIndex((b) => b.id === +req.params.id);
  if (i >= 0) {
    fs.unlink(path.join(UPLOAD_DIR, store.catalog[i].filename), () => {});
    store.catalog.splice(i, 1);
    persist();
  }
  res.json({ ok: true });
});
app.post("/api/subscribe", auth, async (req, res) => {
  const resp = await tg("createInvoiceLink", {
    title: "Премиум-подписка",
    description: "Безлимит книг, синхронизация и премиум-функции на месяц.",
    payload: `sub_${req.user.id}_${now()}`,
    currency: "XTR",
    prices: [{ label: "Премиум на 1 месяц", amount: STAR_PRICE }],
    subscription_period: SUB_PERIOD, // рекуррентная подписка раз в 30 дней
  });
  if (!resp.ok) return res.status(500).json({ error: "invoice_failed", detail: resp.description });
  res.json({ link: resp.result });
});

// вебхук Telegram (оплата). В @BotFather/коде нужно вызвать setWebhook на этот URL.
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  const update = req.body;
  try {
    // подтверждаем готовность к оплате
    if (update.pre_checkout_query) {
      await tg("answerPreCheckoutQuery", { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
    }
    // успешная оплата (в т.ч. ежемесячное продление) — продлеваем премиум
    const sp = update.message?.successful_payment;
    if (sp) {
      const uid = update.message.from.id;
      let u = store.users[uid];
      if (!u) { u = { id: uid, first_name: "", username: "", premium_until: 0, created: now() }; store.users[uid] = u; }
      const base = u.premium_until > now() ? u.premium_until : now();
      u.premium_until = base + SUB_PERIOD;
      persist();
      await tg("sendMessage", { chat_id: uid, text: "✅ Премиум активирован. Спасибо за подписку!" });
    }
  } catch (e) {
    console.error("webhook error", e);
  }
  res.json({ ok: true });
});

// health-check
app.get("/api/health", (req, res) => res.json({ ok: true, time: now() }));

app.listen(PORT, () => console.log(`BookTG слушает порт ${PORT}`));
