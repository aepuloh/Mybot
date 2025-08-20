// index.js — Telegram Ads Bot + Admin Panel (Railway + PostgreSQL + Webhook)
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { Parser } = require("json2csv");
const { Pool } = require("pg");
const crypto = global.crypto || require("crypto").webcrypto;

const app = express();
app.use(bodyParser.json());

// ====================== CONFIG ======================
const TOKEN = process.env.TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";
const PORT = process.env.PORT || 3000;
const BASE_HOST =
  process.env.RAILWAY_STATIC_URL || "mybot-production-2f94.up.railway.app";

if (!TOKEN) {
  console.error("❌ TOKEN belum di-set. Tambahkan env TOKEN di Railway.");
  process.exit(1);
}

// ====================== BOT (Webhook Mode) ======================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`https://${BASE_HOST}/bot${TOKEN}`);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
// ====================== DATABASE (JSON File) ======================
const dbFile = path.join(__dirname, "users.json");
let users = {};
if (fs.existsSync(dbFile)) {
  users = JSON.parse(fs.readFileSync(dbFile));
}
function saveDB() {
  fs.writeFileSync(dbFile, JSON.stringify(users, null, 2));
}

// ====================== TELEGRAM BOT ======================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!users[chatId]) {
    users[chatId] = { points: 0, history: [] };
    saveDB();
  }

  const opts = {
    reply_markup: {
      keyboard: [
        ["💰 Cek Poin", "🎬 Nonton Iklan"],
        ["💵 Withdraw", "📜 Riwayat"]
      ],
      resize_keyboard: true
    }
  };

  bot.sendMessage(chatId, "👋 Selamat datang di Bot Nonton Iklan!\nPilih menu:", opts);
});

// handler tombol menu
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!users[chatId]) return;

  if (text === "💰 Cek Poin") {
    bot.sendMessage(chatId, `💎 Saldo poin kamu: ${users[chatId].points}`);
  }

  if (text === "🎬 Nonton Iklan") {
    bot.sendMessage(
      chatId,
      `🎥 Klik link berikut untuk menonton iklan:\nhttps://${process.env.RAILWAY_STATIC_URL || "mybot-production-e6ef.up.railway.app"}/watch?user_id=${chatId}`
    );
  }

  if (text === "💵 Withdraw") {
    bot.sendMessage(chatId, "💸 Fitur withdraw masih dalam pengembangan.");
  }

  if (text === "📜 Riwayat") {
    if (users[chatId].history.length === 0) {
      bot.sendMessage(chatId, "📭 Belum ada riwayat transaksi.");
    } else {
      bot.sendMessage(chatId, "📜 Riwayat:\n" + users[chatId].history.join("\n"));
    }
  }
});

// ====================== WEB: IKLAN ======================
app.get("/watch", (req, res) => {
  const { user_id } = req.query;
  if (!user_id || !users[user_id]) return res.send("User tidak ditemukan");

  res.send(`
    <html>
      <head><title>Nonton Iklan</title></head>
      <body style="text-align:center;font-family:sans-serif;">
        <h2>🎬 Tonton Iklan Berikut</h2>
        <script src="https://ad.gigapub.tech/script?id=1669"></script>
        <script>
          window.showGiga()
            .then(() => {
              fetch('/reward?user_id=${user_id}');
              document.body.innerHTML += "<p>✅ Kamu mendapat 10 poin!</p>";
            })
            .catch(e => {
              document.body.innerHTML += "<p>❌ Gagal menampilkan iklan.</p>";
            });
        </script>
      </body>
    </html>
  `);
});

// reward setelah nonton
app.get("/reward", (req, res) => {
  const { user_id } = req.query;
  if (!user_id || !users[user_id]) return res.send("User tidak ditemukan");
  users[user_id].points += 10;
  users[user_id].history.push(`+10 poin dari iklan (${new Date().toLocaleString()})`);
  saveDB();
  res.send("Reward diberikan");
});

// ====================== ADMIN PANEL ======================
app.get("/admin", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.send("❌ Unauthorized");

  res.send(`
    <html>
      <head>
        <title>Admin Panel</title>
        <style>
          body { font-family: sans-serif; margin:0; padding:0; }
          .tabbar { position: fixed; bottom:0; left:0; right:0; display:flex; border-top:1px solid #ccc; }
          .tab { flex:1; text-align:center; padding:10px; background:#f9f9f9; cursor:pointer; }
          .content { padding:20px; margin-bottom:60px; }
        </style>
      </head>
      <body>
        <div class="content" id="content">📊 Pilih menu admin di bawah</div>
        <div class="tabbar">
          <div class="tab" onclick="load('users')">👤 Users</div>
          <div class="tab" onclick="load('ads')">🎬 Ads</div>
          <div class="tab" onclick="load('finance')">💰 Finance</div>
          <div class="tab" onclick="load('settings')">⚙️ Settings</div>
        </div>
        <script>
          function load(tab){
            if(tab==='users'){
              document.getElementById('content').innerHTML = '<h3>👤 Kelola Users</h3><a href="/export?key=${ADMIN_KEY}">⬇️ Export CSV</a>';
            }
            if(tab==='ads'){
              document.getElementById('content').innerHTML = '<h3>🎬 Kelola Ads</h3>';
            }
            if(tab==='finance'){
              document.getElementById('content').innerHTML = '<h3>💰 Kelola Finance</h3>';
            }
            if(tab==='settings'){
              document.getElementById('content').innerHTML = '<h3>⚙️ Settings</h3>';
            }
          }
        </script>
      </body>
    </html>
  `);
});

// export user ke CSV
app.get("/export", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.send("❌ Unauthorized");

  const data = Object.keys(users).map((id) => ({
    user_id: id,
    points: users[id].points,
    history: users[id].history.join("; ")
  }));

  const parser = new Parser({ fields: ["user_id", "points", "history"] });
  const csv = parser.parse(data);

  res.header("Content-Type", "text/csv");
  res.attachment("users.csv");
  res.send(csv);
});

// ====================== KEEP ALIVE ======================
app.get("/", (req, res) => res.send("🚀 Bot is running on Railway!"));
setInterval(() => {
  axios
    .get(`https://${process.env.RAILWAY_STATIC_URL || "mybot-production-e6ef.up.railway.app"}`)
    .then(() => console.log("🔄 Keep alive ping sent"))
    .catch(() => console.log("⚠️ Ping failed"));
}, 5 * 60 * 1000);

// ====================== START SERVER ======================
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
