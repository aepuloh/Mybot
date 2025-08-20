// ===== DEPENDENCIES =====
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const express = require("express");
const path = require("path");
const app = express();

// ===== CONFIG =====
const TOKEN = process.env.TOKEN; // token bot
const ADMIN_KEY = process.env.ADMIN_KEY || "12345"; // kunci admin
const PORT = process.env.PORT || 8080;

// ===== DATABASE SEDERHANA =====
const DB_FILE = "db.json";
let db = { users: {} };

if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE));
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ===== TELEGRAM BOT =====
const bot = new TelegramBot(TOKEN, { polling: true });

// Start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!db.users[chatId]) {
    db.users[chatId] = { name: msg.from.first_name, points: 0 };
    saveDB();
  }

  bot.sendMessage(
    chatId,
    `👋 Halo ${msg.from.first_name}!\n\n` +
      `Kamu bisa nonton iklan untuk dapat poin 🎥.\n\n` +
      `Gunakan /watch untuk mulai.`
  );
});

// Nonton iklan
bot.onText(/\/watch/, (msg) => {
  const chatId = msg.chat.id;
  if (!db.users[chatId]) {
    db.users[chatId] = { name: msg.from.first_name, points: 0 };
    saveDB();
  }

  const url = `https://${process.env.RAILWAY_STATIC_URL || "mybot-production.up.railway.app"}/watch?user_id=${chatId}`;
  bot.sendMessage(chatId, `🎥 Klik link ini untuk nonton iklan:\n${url}`);
});

// ===== WEB SERVER =====
app.get("/", (req, res) => {
  res.send("Bot sedang berjalan 🚀");
});

// Halaman nonton iklan
app.get("/watch", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.send("User tidak ditemukan");

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Nonton Iklan</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: sans-serif; text-align:center; padding:20px;">
      <h2>🎥 Nonton Iklan</h2>
      <p>Tunggu iklan selesai untuk dapat reward.</p>

      <script src="https://ad.gigapub.tech/script?id=1669"></script>
      <script>
        window.showGiga()
          .then(() => {
            fetch('/reward?user_id=${userId}')
              .then(() => {
                document.body.innerHTML = "<h3>✅ Iklan selesai, poin sudah ditambahkan!</h3>";
              });
          })
          .catch(e => {
            document.body.innerHTML = "<h3>❌ Gagal memuat iklan</h3>";
          });
      </script>
    </body>
    </html>
  `);
});

// Reward setelah nonton
app.get("/reward", (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.send("User tidak ditemukan");
  if (!db.users[userId]) return res.send("User tidak valid");

  db.users[userId].points += 10; // reward 10 poin
  saveDB();
  res.send("Poin ditambahkan");
});

// Export ke CSV
app.get("/export", (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) return res.status(403).send("Unauthorized");

  let csv = "ID,Name,Points\\n";
  for (const [id, user] of Object.entries(db.users)) {
    csv += `${id},"${user.name}",${user.points}\\n`;
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=users.csv");
  res.send(csv);
});

// Admin panel
app.get("/admin", (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(403).send("Unauthorized");
  }

  let userList = "";
  for (const [id, user] of Object.entries(db.users)) {
    userList += `
      <li>
        <b>${user.name}</b> (ID: ${id}) — ${user.points} poin
        <button onclick="action('${id}','add')">➕</button>
        <button onclick="action('${id}','sub')">➖</button>
        <button onclick="action('${id}','reset')">♻ Reset</button>
      </li>`;
  }
  if (!userList) userList = "<li>Belum ada user</li>";

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Admin Panel</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: sans-serif; margin:0; padding:0; padding-bottom:70px; }
        .content { padding: 20px; }
        .tabbar {
          position: fixed;
          bottom: 0;
          left: 0; right: 0;
          display: flex;
          justify-content: space-around;
          background: #fff;
          border-top: 1px solid #ccc;
          padding: 10px 0;
          z-index: 9999;
        }
        .tab {
          text-align: center;
          flex: 1;
          font-size: 14px;
          cursor: pointer;
        }
        .tab.active { font-weight: bold; color: #2196F3; }
        .submenu {
          margin-top: 15px;
          padding: 10px;
          background: #f9f9f9;
          border: 1px solid #ddd;
          border-radius: 6px;
        }
      </style>
    </head>
    <body>
      <div class="content" id="page"></div>

      <div class="tabbar">
        <div class="tab active" onclick="showPage('home', this)">🏠 Home</div>
        <div class="tab" onclick="showPage('users', this)">👤 Users</div>
        <div class="tab" onclick="showPage('ads', this)">🎥 Ads</div>
        <div class="tab" onclick="showPage('settings', this)">⚙ Settings</div>
      </div>

      <script>
        function showPage(page, el) {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          el.classList.add('active');
          let html = '';
          if (page === 'home') {
            html = '<h2>📊 Dashboard</h2><p>Total Users: ${Object.keys(db.users).length}</p>';
          }
          if (page === 'users') {
            html = '<h2>👤 Users</h2><div class="submenu"><button onclick="window.location=\\'/export?key=${ADMIN_KEY}\\'">📥 Export CSV</button><ul>${userList}</ul></div>';
          }
          if (page === 'ads') {
            html = '<h2>🎥 Ads</h2><div class="submenu">Kelola iklan</div>';
          }
          if (page === 'settings') {
            html = '<h2>⚙ Settings</h2><div class="submenu">Pengaturan reward & admin key</div>';
          }
          document.getElementById('page').innerHTML = html;
        }

        function action(id, type) {
          fetch('/updateUser?key=${ADMIN_KEY}&id=' + id + '&action=' + type)
            .then(()=>location.reload());
        }

        window.onload = () => {
          document.querySelector('.tab.active').click();
        };
      </script>
    </body>
    </html>
  `);
});

// Update user (reset/tambah/kurang)
app.get("/updateUser", (req, res) => {
  const { key, id, action } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).send("Unauthorized");
  if (!db.users[id]) return res.send("User tidak ada");

  if (action === "reset") db.users[id].points = 0;
  if (action === "add") db.users[id].points += 1;
  if (action === "sub") db.users[id].points -= 1;

  saveDB();
  res.send("OK");
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
