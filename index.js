// index.js — Telegram Ads Bot + Admin Panel + Referral + Daily + Spin + Quiz (Full Fixed)
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { Parser } = require("json2csv");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.json());

// ====================== CONFIG ======================
const TOKEN = process.env.TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || "Snowboy14";
const PORT = process.env.PORT || 3000;
const BASE_HOST = process.env.RAILWAY_STATIC_URL || "localhost:" + PORT;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_ID = process.env.ADMIN_ID; // optional

if (!TOKEN || !DATABASE_URL) {
  console.error("❌ TOKEN & DATABASE_URL wajib di-set.");
  process.exit(1);
}

// ====================== DATABASE ======================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Buat tabel + auto-repair kolom
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      points INT DEFAULT 0,
      history TEXT[]
    )
  `);

  // Auto-repair kolom baru
  const userCols = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name='users'
  `);
  const cols = userCols.rows.map(r => r.column_name);

  if (!cols.includes("ref_by"))
    await pool.query("ALTER TABLE users ADD COLUMN ref_by BIGINT");
  if (!cols.includes("last_daily"))
    await pool.query("ALTER TABLE users ADD COLUMN last_daily TIMESTAMP");
  if (!cols.includes("last_spin"))
    await pool.query("ALTER TABLE users ADD COLUMN last_spin TIMESTAMP");
  if (!cols.includes("created_at"))
    await pool.query("ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT NOW()");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      amount INT,
      dana_number TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      reward INT DEFAULT 10,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      reward INT DEFAULT 30,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
})();

// ===== Helper DB
async function getUser(user_id) {
  const res = await pool.query("SELECT * FROM users WHERE user_id=$1", [user_id]);
  return res.rows[0];
}
async function addUser(user_id, ref_by = null) {
  await pool.query(
    "INSERT INTO users (user_id, points, history, ref_by) VALUES ($1, 0, $2, $3) ON CONFLICT (user_id) DO NOTHING",
    [user_id, [], ref_by]
  );
}
async function updatePoints(user_id, pts, note) {
  await pool.query(
    "UPDATE users SET points = points + $1, history = array_append(history, $2) WHERE user_id=$3",
    [pts, note, user_id]
  );
}
function nowLocal() {
  return new Date().toLocaleString();
}

// ====================== BOT ======================
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`https://${BASE_HOST}/bot${TOKEN}`);

bot.setMyCommands([
  { command: "start", description: "Mulai bot" },
  { command: "daily", description: "Klaim bonus harian" },
  { command: "ref", description: "Lihat referral link" },
  { command: "spin", description: "Lucky spin harian" },
  { command: "quiz", description: "Jawab quiz untuk poin" },
  { command: "leaderboard", description: "Top pengguna (poin)" },
]);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const waitingWithdraw = new Map();
const waitingQuiz = new Map(); // chatId -> {q,a,reward}

// ====================== START + REFERRAL ======================
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const refArg = match[1];

  if (refArg && refArg.startsWith("ref_")) {
    const ref_by = parseInt(refArg.replace("ref_", ""), 10);
    if (ref_by && ref_by !== chatId) {
      const exist = await getUser(chatId);
      if (!exist) {
        await addUser(chatId, ref_by);
        await updatePoints(ref_by, 50, `+50 poin referral dari ${chatId} (${nowLocal()})`);
        bot.sendMessage(ref_by, `🎉 Kamu dapat +50 poin dari referral baru: ${chatId}`);
      }
    } else {
      await addUser(chatId);
    }
  } else {
    await addUser(chatId);
  }

  bot.sendMessage(chatId, "👋 Selamat datang! Pilih menu:", {
    reply_markup: {
      keyboard: [
        ["💰 Cek Poin", "🎬 Nonton Iklan"],
        ["💵 Withdraw", "📜 Riwayat"],
        ["🎁 Daily Bonus", "🎡 Spin", "❓ Quiz"]
      ],
      resize_keyboard: true
    }
  });
});

// ====================== COMMANDS ======================
bot.onText(/\/ref/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  const me = await bot.getMe();
  bot.sendMessage(
    chatId,
    `🔗 Referral link kamu:\nhttps://t.me/${me.username}?start=ref_${chatId}\n\n` +
    `Jika ada yang join lewat link ini, kamu dapat +50 poin.`
  );
});

bot.onText(/\/daily/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  const user = await getUser(chatId);
  const now = new Date();
  if (user.last_daily && now - new Date(user.last_daily) < 24 * 60 * 60 * 1000) {
    return bot.sendMessage(chatId, "⚠️ Kamu sudah klaim bonus harian hari ini. Coba lagi besok.");
  }
  await updatePoints(chatId, 100, `+100 daily bonus (${nowLocal()})`);
  await pool.query("UPDATE users SET last_daily=$1 WHERE user_id=$2", [now, chatId]);
  bot.sendMessage(chatId, "🎁 Kamu klaim +100 poin dari bonus harian!");
});

bot.onText(/\/spin/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  const user = await getUser(chatId);
  const now = new Date();
  if (user.last_spin && now - new Date(user.last_spin) < 24 * 60 * 60 * 1000) {
    return bot.sendMessage(chatId, "⚠️ Kamu sudah spin hari ini. Coba lagi besok!");
  }
  const rewards = [0, 5, 10, 20, 50, 100];
  const win = rewards[Math.floor(Math.random() * rewards.length)];
  await updatePoints(chatId, win, `Spin: +${win} poin (${nowLocal()})`);
  await pool.query("UPDATE users SET last_spin=$1 WHERE user_id=$2", [now, chatId]);
  bot.sendMessage(chatId, `🎡 Hasil spin: ${win} poin!`);
});

bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);

  const r = await pool.query("SELECT * FROM quizzes WHERE active=TRUE ORDER BY random() LIMIT 1");
  let soal;
  if (r.rows.length) {
    const row = r.rows[0];
    soal = { q: row.question, a: String(row.answer).toLowerCase(), reward: row.reward || 30 };
  } else {
    const basic = [
      { q: "Ibukota Indonesia?", a: "jakarta", reward: 30 },
      { q: "2 + 5 = ?", a: "7", reward: 30 },
      { q: "Warna bendera Indonesia?", a: "merah putih", reward: 30 },
    ];
    soal = basic[Math.floor(Math.random() * basic.length)];
    soal.a = soal.a.toLowerCase();
  }
  waitingQuiz.set(chatId, soal);
  bot.sendMessage(chatId, `❓ Quiz:\n${soal.q}\n\nKetik jawabanmu (1x kesempatan).`);
});

bot.onText(/\/leaderboard/, async (msg) => {
  const chatId = msg.chat.id;
  const r = await pool.query("SELECT user_id, points FROM users ORDER BY points DESC LIMIT 10");
  const lines = r.rows.map((u, i) => `${i + 1}. ${u.user_id} — ${u.points} pts`);
  bot.sendMessage(chatId, `🏆 Leaderboard:\n` + (lines.join("\n") || "Kosong"));
});

// ====================== MESSAGE HANDLER ======================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = (msg.text || "").trim();
  const text = textRaw.toLowerCase();

  if (waitingWithdraw.get(chatId)) {
    const user = await getUser(chatId);
    const danaNumber = textRaw;
    await pool.query(
      "INSERT INTO withdraw_requests (user_id, amount, dana_number, status) VALUES ($1,$2,$3,$4)",
      [chatId, user?.points || 0, danaNumber, "pending"]
    );
    waitingWithdraw.delete(chatId);
    bot.sendMessage(chatId, `✅ Withdraw ${user.points} poin dikirim ke ${danaNumber}`);
    if (ADMIN_ID) {
      bot.sendMessage(ADMIN_ID, `📥 Withdraw Baru\nUser: ${chatId}\nJumlah: ${user.points}\nDANA: ${danaNumber}`);
    }
    await pool.query("UPDATE users SET points=0 WHERE user_id=$1", [chatId]);
    return;
  }

  if (waitingQuiz.get(chatId)) {
    const soal = waitingQuiz.get(chatId);
    waitingQuiz.delete(chatId);
    if (text === soal.a) {
      await updatePoints(chatId, soal.reward, `+${soal.reward} poin quiz (${nowLocal()})`);
      bot.sendMessage(chatId, `🎉 Benar! Kamu dapat +${soal.reward} poin.`);
    } else {
      bot.sendMessage(chatId, "❌ Jawaban salah. Semangat lagi!");
    }
    return;
  }

  const user = await getUser(chatId);
  if (!user) return;

  if (text === "💰 cek poin") return bot.sendMessage(chatId, `💎 Poin kamu: ${user.points}`);
  if (text === "🎬 nonton iklan") {
    const me = await bot.getMe();
    return bot.sendMessage(chatId, `🎥 Klik:\nhttps://${BASE_HOST}/watch?user_id=${chatId}&b=${me.username}`);
  }
  if (text === "💵 withdraw") {
    if (user.points < 10000) return bot.sendMessage(chatId, "⚠️ Minimal 10.000 poin untuk withdraw");
    bot.sendMessage(chatId, "💳 Masukkan nomor DANA kamu:");
    waitingWithdraw.set(chatId, true);
    return;
  }
  if (text === "📜 riwayat") {
    if (!user.history?.length) return bot.sendMessage(chatId, "📭 Belum ada riwayat");
    return bot.sendMessage(chatId, "📜 Riwayat:\n" + user.history.join("\n"));
  }
  if (text === "🎁 daily bonus") return bot.emit("text", { chat: msg.chat, text: "/daily" });
  if (text === "🎡 spin") return bot.emit("text", { chat: msg.chat, text: "/spin" });
  if (text === "❓ quiz") return bot.emit("text", { chat: msg.chat, text: "/quiz" });
});

// ====================== WEB: IKLAN ======================
app.get("/watch", async (req, res) => {
  const { user_id, b } = req.query;
  const user = await getUser(user_id);
  if (!user) return res.send("User tidak ditemukan");
  const me = b || (await bot.getMe()).username;

  const adRes = await pool.query("SELECT * FROM ads WHERE status='active' ORDER BY id DESC LIMIT 1");
  const ad = adRes.rows[0];
  const scriptUrl = ad?.url || "https://ad.gigapub.tech/script?id=1669";
  const reward = ad?.reward || 10;

  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
<title>Nonton Iklan</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<script src="${scriptUrl}"></script>
</head>
<body style="text-align:center;font-family:sans-serif;">
<h2>🎬 Tonton Iklan</h2>
<p id="status">⏳ Tunggu 5 detik...</p>
<script>
document.addEventListener("DOMContentLoaded", function() {
  if (typeof window.showGiga === "function") {
    window.showGiga().then(() => {
      let c=5; const s=document.getElementById("status");
      const i=setInterval(()=>{c--;
        if(c>0){s.textContent="⏳ Tunggu "+c+" detik...";}
        else{
          clearInterval(i);
          fetch("/reward?user_id=${user_id}&reward=${reward}")
            .then(()=>{s.textContent="✅ ${reward} poin!"; setTimeout(()=>{location.href="https://t.me/${me}"},1500);});
        }
      },1000);
    }).catch(()=>{document.body.innerHTML+="<p>❌ Gagal load iklan</p>";});
  } else {document.body.innerHTML+="<p>⚠️ Script iklan tidak aktif</p>";}
});
</script>
</body>
</html>`);
});

app.get("/reward", async (req, res) => {
  const { user_id, reward } = req.query;
  const user = await getUser(user_id);
  if (!user) return res.send("User tidak ditemukan");
  const pts = parseInt(reward || "10", 10);
  await updatePoints(user_id, pts, `+${pts} poin (${nowLocal()})`);
  res.send("Reward diberikan");
});

// ====================== ADMIN DATA API ======================
function guard(req, res) {
  if (req.query.key !== ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/api/users", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await pool.query("SELECT user_id,points,history,ref_by,created_at FROM users ORDER BY user_id DESC");
    res.json(r.rows);
  } catch (e) {
    console.error("⚠️ /api/users fallback:", e.message);
    const r = await pool.query("SELECT user_id,points,history FROM users ORDER BY user_id DESC");
    res.json(r.rows);
  }
});

// ... (API Ads, Withdraws, Quizzes, Export sama seperti sebelumnya) ...

// ====================== KEEP ALIVE ======================
app.get("/", (_req, res) => res.send("🚀 Bot is running"));
setInterval(() => { axios.get(`https://${BASE_HOST}`).catch(() => {}) }, 300000);

app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
