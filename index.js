// ===== DEPENDENCIES =====
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const Database = require("better-sqlite3");

const app = express();

// ===== CONFIG =====
const TOKEN = process.env.TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";
const DOMAIN = process.env.DOMAIN || "http://localhost:3000";

const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Database("data.db");

// ===== INIT DB =====
db.prepare(
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, points INTEGER DEFAULT 0)"
).run();
db.prepare(
  "CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER, status TEXT DEFAULT 'pending')"
).run();

// ===== TELEGRAM BOT =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  db.prepare("INSERT OR IGNORE INTO users (id, points) VALUES (?, 0)").run(
    chatId
  );

  bot.sendMessage(chatId, "🎉 Selamat datang di Bot Nonton Iklan!", {
    reply_markup: {
      keyboard: [
        ["🎬 Nonton Iklan"],
        ["📊 Cek Poin", "💸 Withdraw"],
        ["🧾 Riwayat Withdraw"],
      ],
      resize_keyboard: true,
    },
  });
});

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "🎬 Nonton Iklan") {
    bot.sendMessage(
      chatId,
      `Klik link ini untuk nonton iklan:\n\n${DOMAIN}/watch?user_id=${chatId}`
    );
  }

  if (text === "📊 Cek Poin") {
    const row = db
      .prepare("SELECT points FROM users WHERE id = ?")
      .get(chatId);
    bot.sendMessage(chatId, `📊 Poin kamu: ${row?.points || 0}`);
  }

  if (text === "💸 Withdraw") {
    bot.sendMessage(
      chatId,
      "Masukkan jumlah withdraw (minimum 100 poin):",
      { reply_markup: { force_reply: true } }
    );
  }

  if (msg.reply_to_message?.text?.includes("jumlah withdraw")) {
    const amount = parseInt(text);
    if (isNaN(amount) || amount < 100) {
      return bot.sendMessage(chatId, "⚠️ Minimal 100 poin untuk withdraw!");
    }
    const row = db
      .prepare("SELECT points FROM users WHERE id = ?")
      .get(chatId);
    if (!row || row.points < amount) {
      return bot.sendMessage(chatId, "❌ Poin tidak cukup!");
    }

    db.prepare("UPDATE users SET points = points - ? WHERE id = ?").run(
      amount,
      chatId
    );
    db.prepare(
      "INSERT INTO withdrawals (user_id, amount, status) VALUES (?, ?, 'pending')"
    ).run(chatId, amount);

    bot.sendMessage(chatId, "✅ Withdraw diproses, tunggu konfirmasi admin!");
  }

  if (text === "🧾 Riwayat Withdraw") {
    const rows = db
      .prepare("SELECT amount, status FROM withdrawals WHERE user_id = ?")
      .all(chatId);
    if (!rows.length) return bot.sendMessage(chatId, "Belum ada riwayat.");
    let msgText = "🧾 Riwayat Withdraw:\n";
    rows.forEach((r) => {
      msgText += `- ${r.amount} poin [${r.status}]\n`;
    });
    bot.sendMessage(chatId, msgText);
  }
});

// ===== WEBSITE WATCH ADS =====
app.get("/watch", (req, res) => {
  const userId = req.query.user_id;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Nonton Iklan</title></head>
    <body style="text-align:center;font-family:sans-serif;">
      <h2>🎬 Nonton iklan untuk dapat poin</h2>
      <script src="https://ad.gigapub.tech/script?id=1669"></script>
      <script>
        window.showGiga()
          .then(() => {
            fetch("/reward?user_id=${userId}");
            document.body.innerHTML = "<h3>✅ Selesai! Poin sudah ditambahkan</h3>";
          })
          .catch(e => {
            document.body.innerHTML = "<h3>❌ Gagal menampilkan iklan</h3>";
          });
      </script>
    </body>
    </html>
  `);
});

app.get("/reward", (req, res) => {
  const userId = req.query.user_id;
  db.prepare("UPDATE users SET points = points + 10 WHERE id = ?").run(userId);
  res.send("Reward diberikan!");
});

// ===== ADMIN PANEL =====
app.get("/admin", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.send("Unauthorized!");

  const users = db.prepare("SELECT * FROM users").all();
  const withdraws = db.prepare("SELECT * FROM withdrawals").all();

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Admin Panel</title>
      <style>
        body { font-family: sans-serif; margin: 0; }
        .tabbar { position: fixed; bottom: 0; left: 0; right:0; display:flex; background:#333; }
        .tabbar a { flex:1; padding:10px; color:#fff; text-align:center; text-decoration:none; }
        .content { padding:20px; margin-bottom:60px; }
      </style>
    </head>
    <body>
      <div class="content">
        <h2>👤 Users</h2>
        <ul>
          ${users.map((u) => `<li>ID: ${u.id} | Poin: ${u.points}</li>`).join("")}
        </ul>
        <h2>💸 Withdrawals</h2>
        <ul>
          ${withdraws
            .map(
              (w) =>
                `<li>User: ${w.user_id} | Amount: ${w.amount} | Status: ${w.status}</li>`
            )
            .join("")}
        </ul>
      </div>
      <div class="tabbar">
        <a href="#users">Users</a>
        <a href="#withdraw">Withdrawals</a>
        <a href="#settings">Settings</a>
      </div>
    </body>
    </html>
  `);
});

// ===== RUN SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
