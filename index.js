// index.js — Telegram Ads Bot + Admin Panel (Railway + PostgreSQL + Webhook)
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
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";
const PORT = process.env.PORT || 3000;
const BASE_HOST =
  process.env.RAILWAY_STATIC_URL || "mybot-production-2f94.up.railway.app";
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN) {
  console.error("❌ TOKEN belum di-set. Tambahkan env TOKEN di Railway.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL belum di-set di Railway.");
  process.exit(1);
}

// ====================== DATABASE ======================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Buat table kalau belum ada
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      points INT DEFAULT 0,
      history TEXT[]
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      amount INT,
      dana_number TEXT,
      status TEXT DEFAULT 'pending'
    )
  `);
})();

// helper db
async function getUser(user_id) {
  const res = await pool.query("SELECT * FROM users WHERE user_id=$1", [user_id]);
  return res.rows[0];
}

async function addUser(user_id) {
  await pool.query(
    "INSERT INTO users (user_id, points, history) VALUES ($1, 0, $2) ON CONFLICT (user_id) DO NOTHING",
    [user_id, []]
  );
}

async function updatePoints(user_id, pts, note) {
  await pool.query(
    "UPDATE users SET points = points + $1, history = array_append(history, $2) WHERE user_id=$3",
    [pts, note, user_id]
  );
}
// ====================== BOT (Webhook Mode) ======================
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`https://${BASE_HOST}/bot${TOKEN}`);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ====================== TELEGRAM BOT ======================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);

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
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  let user = await getUser(chatId);
  if (!user) return;

  if (text === "💰 Cek Poin") {
    bot.sendMessage(chatId, `💎 Saldo poin kamu: ${user.points}`);
  }

  if (text === "🎬 Nonton Iklan") {
    bot.sendMessage(
      chatId,
      `🎥 Klik link berikut untuk menonton iklan:\nhttps://${BASE_HOST}/watch?user_id=${chatId}`
    );
  }

  // ===== WITHDRAW =====
if (text === "💵 Withdraw") {
  const user = await getUser(chatId);
  if (!user || user.points < 10000) { // minimal 10000 poin (contoh)
    bot.sendMessage(chatId, "⚠️ Saldo kamu belum cukup untuk withdraw.\nMinimal 10.000 poin.");
  } else {
    bot.sendMessage(chatId, "💳 Masukkan nomor DANA kamu untuk withdraw:");
    // simpan state user sementara
    if (!global.waitingWithdraw) global.waitingWithdraw = {};
    global.waitingWithdraw[chatId] = true;
  }
}

// menangkap nomor DANA setelah user diminta
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (global.waitingWithdraw && global.waitingWithdraw[chatId]) {
    const user = await getUser(chatId);
    const danaNumber = text;

    // simpan request withdraw ke database (atau bisa langsung kirim ke admin)
    await pool.query(
      "INSERT INTO withdraw_requests (user_id, amount, dana_number, status) VALUES ($1, $2, $3, $4)",
      [chatId, user.points, danaNumber, "pending"]
    );

    // reset state
    delete global.waitingWithdraw[chatId];

    // kirim ke user
    bot.sendMessage(
      chatId,
      `✅ Permintaan withdraw sebesar ${user.points} poin (≈Rp${user.points}) telah dikirim.\nNomor DANA: ${danaNumber}\n\nSilakan tunggu admin memproses.`
    );

    // kirim notifikasi ke admin
    bot.sendMessage(
      process.env.ADMIN_ID,
      `📥 Request Withdraw Baru:\n\n👤 User: ${chatId}\n💰 Jumlah: ${user.points} poin\n💳 DANA: ${danaNumber}`
    );

    // kosongkan saldo user
    await pool.query("UPDATE users SET points = 0 WHERE user_id=$1", [chatId]);
  }
});

  if (text === "📜 Riwayat") {
    if (!user.history || user.history.length === 0) {
      bot.sendMessage(chatId, "📭 Belum ada riwayat transaksi.");
    } else {
      bot.sendMessage(chatId, "📜 Riwayat:\n" + user.history.join("\n"));
    }
  }
});

// ====================== WEB: IKLAN ======================
const ads = [
  "https://ad.gigapub.tech/script?id=1669",
];
app.get("/watch", async (req, res) => {
  const { user_id } = req.query;
  const user = await getUser(user_id);
  if (!user) return res.send("User tidak ditemukan");
  const randomAd = ads[Math.floor(Math.random() * ads.length)];

  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>Nonton Iklan</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <script src="https://ad.gigapub.tech/script?id=1669"></script>
  </head>
  <body style="text-align:center;font-family:sans-serif;">
    <h2>🎬 Tonton Iklan Berikut</h2>
    <p id="status">⏳ Tunggu 5 detik...</p>

    <script>
      document.addEventListener("DOMContentLoaded", function() {
        if (typeof window.showGiga === "function") {
          window.showGiga().then(() => {
            let countdown = 5; // detik nonton
            const statusEl = document.getElementById("status");

            const interval = setInterval(() => {
              countdown--;
              if (countdown > 0) {
                statusEl.textContent = "⏳ Tunggu " + countdown + " detik...";
              } else {
                clearInterval(interval);
                fetch("/reward?user_id=${user_id}")
                  .then(() => {
                    statusEl.textContent = "✅ Kamu mendapat 10 poin!";
                    // tunggu 2 detik lalu auto balik ke Telegram
                    setTimeout(() => {
                      window.location.href = "https://t.me/Addsstargaze_bot";
                      // atau pakai schema langsung ke app:
                      // window.location.href = "tg://resolve?domain=Addsstargaze_bot";
                    }, 2000);
                  });
              }
            }, 1000);
          }).catch(e => {
            document.body.innerHTML += "<p>❌ Gagal memuat iklan.</p>";
          });
        } else {
          document.body.innerHTML += "<p>⚠️ Script iklan tidak aktif.</p>";
        }
      });
    </script>
  </body>
</html>`);
});

// reward setelah nonton
app.get("/reward", async (req, res) => {
  const { user_id } = req.query;
  const user = await getUser(user_id);
  if (!user) return res.send("User tidak ditemukan");

  await updatePoints(user_id, 10, `+10 poin dari iklan (${new Date().toLocaleString()})`);
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
              document.getElementById('content').innerHTML = '<h3>🎬 Kelola Ads</h3><table border="1" cellpadding="5"><thead><tr><th>ID</th><th>Title</th><th>URL</th><th>Reward</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="ads-table-body"></tbody></table>';
              loadAds();
            }
            if(tab==='finance'){
              document.getElementById('content').innerHTML = '<h3>💰 Kelola Finance</h3>';
            }
            if(tab==='settings'){
              document.getElementById('content').innerHTML = '<h3>⚙️ Settings</h3>';
            }
          }

          async function loadAds() {
            const res = await fetch("/api/ads");
            const ads = await res.json();
            const tbody = document.getElementById("ads-table-body");
            tbody.innerHTML = "";

            ads.forEach(ad => {
              tbody.innerHTML += 
                '<tr>' +
                  '<td>' + ad.id + '</td>' +
                  '<td>' + ad.title + '</td>' +
                  '<td><a href="' + ad.url + '" target="_blank">' + ad.url + '</a></td>' +
                  '<td>' + ad.reward + '</td>' +
                  '<td>' + ad.status + '</td>' +
                  '<td>' +
                    '<button onclick="editAd(' + ad.id + ', \\' ' + ad.title + ' \\' , \\' ' + ad.url + ' \\' ,' + ad.reward + ', \\' ' + ad.status + ' \\')">✏️</button>' +
                    '<button onclick="deleteAd(' + ad.id + ')">🗑️</button>' +
                  '</td>' +
                '</tr>';
            });
          }

          function editAd(id, title, url, reward, status){
            alert("Edit belum dibuat: " + id);
          }
          function deleteAd(id){
            alert("Delete belum dibuat: " + id);
          }
        </script>
      </body>
    </html>
  `);
});

// Tambah/Edit Iklan
document.getElementById("ad-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("ad-id").value;
  const title = document.getElementById("ad-title").value;
  const url = document.getElementById("ad-url").value;
  const reward = document.getElementById("ad-reward").value;
  const status = document.getElementById("ad-status").value;

  const method = id ? "PUT" : "POST";
  const endpoint = id ? `/api/ads/${id}` : "/api/ads";

  await fetch(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, url, reward, status })
  });

  document.getElementById("ad-form").reset();
  loadAds();
});

// Edit Iklan
function editAd(id, title, url, reward, status) {
  document.getElementById("ad-id").value = id;
  document.getElementById("ad-title").value = title;
  document.getElementById("ad-url").value = url;
  document.getElementById("ad-reward").value = reward;
  document.getElementById("ad-status").value = status;
}

// Hapus Iklan
async function deleteAd(id) {
  if (confirm("Yakin hapus iklan ini?")) {
    await fetch(`/api/ads/${id}`, { method: "DELETE" });
    loadAds();
  }
}

// Auto load iklan saat panel dibuka
window.onload = loadAds;
</script>
      </body>
      <div id="ads-section">
  <h2>📺 Kelola Iklan</h2>

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

        <div id="ads-section">
          <h2>📺 Kelola Iklan</h2>
          <!-- Form Tambah/Edit -->
          <form id="ad-form">
            <input type="hidden" id="ad-id" />
            <input type="text" id="ad-title" placeholder="Judul iklan" required />
            <input type="url" id="ad-url" placeholder="URL iklan" required />
            <input type="number" id="ad-reward" placeholder="Reward" required />
            <select id="ad-status">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <button type="submit">Simpan</button>
          </form>
          <br />
          <!-- Tabel Ads -->
          <table border="1" cellpadding="8" cellspacing="0">
            <thead>
              <tr>
                <th>ID</th>
                <th>Judul</th>
                <th>URL</th>
                <th>Reward</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody id="ads-table-body"></tbody>
          </table>
        </div>

        <div class="tabbar">
          <div class="tab" onclick="load('users')">👤 Users</div>
          <div class="tab" onclick="load('ads')">🎬 Ads</div>
          <div class="tab" onclick="load('finance')">💰 Finance</div>
          <div class="tab" onclick="load('settings')">⚙️ Settings</div>
        </div>

        <script>
          function load(tab){
            if(tab==='users'){
              document.getElementById('content').innerHTML =
                '<h3>👤 Kelola Users</h3><a href="/export?key=\\${ADMIN_KEY}">⬇️ Export CSV</a>';
            }
            if(tab==='ads'){
              document.getElementById('content').innerHTML = document.getElementById("ads-section").outerHTML;
              loadAds();
            }
            if(tab==='finance'){
              document.getElementById('content').innerHTML = '<h3>💰 Kelola Finance</h3>';
            }
            if(tab==='settings'){
              document.getElementById('content').innerHTML = '<h3>⚙️ Settings</h3>';
            }
          }

          async function loadAds() {
            const res = await fetch("/api/ads");
            const ads = await res.json();
            const tbody = document.getElementById("ads-table-body");
            tbody.innerHTML = "";
            ads.forEach(ad => {
              tbody.innerHTML += \`
                <tr>
                  <td>\${ad.id}</td>
                  <td>\${ad.title}</td>
                  <td><a href="\${ad.url}" target="_blank">\${ad.url}</a></td>
                  <td>\${ad.reward}</td>
                  <td>\${ad.status}</td>
                  <td>
                    <button onclick="editAd(\${ad.id}, '\${ad.title}', '\${ad.url}', \${ad.reward}, '\${ad.status}')">✏️</button>
                    <button onclick="deleteAd(\${ad.id})">🗑️</button>
                  </td>
                </tr>
              \`;
            });
          }

          document.getElementById("ad-form").addEventListener("submit", async (e) => {
            e.preventDefault();
            const id = document.getElementById("ad-id").value;
            const title = document.getElementById("ad-title").value;
            const url = document.getElementById("ad-url").value;
            const reward = document.getElementById("ad-reward").value;
            const status = document.getElementById("ad-status").value;

            const method = id ? "PUT" : "POST";
            const endpoint = id ? \`/api/ads/\${id}\` : "/api/ads";

            await fetch(endpoint, {
              method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, url, reward, status })
            });

            document.getElementById("ad-form").reset();
            loadAds();
          });

          function editAd(id, title, url, reward, status) {
            document.getElementById("ad-id").value = id;
            document.getElementById("ad-title").value = title;
            document.getElementById("ad-url").value = url;
            document.getElementById("ad-reward").value = reward;
            document.getElementById("ad-status").value = status;
          }

          async function deleteAd(id) {
            if (confirm("Yakin hapus iklan ini?")) {
              await fetch(\`/api/ads/\${id}\`, { method: "DELETE" });
              loadAds();
            }
          }

          window.onload = loadAds;
        </script>
      </body>
    </html>
  `);
});

// export user ke CSV
app.get("/export", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.send("❌ Unauthorized");

  const result = await pool.query("SELECT * FROM users");
  const data = result.rows.map((u) => ({
    user_id: u.user_id,
    points: u.points,
    history: (u.history || []).join("; ")
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
    .get(`https://${BASE_HOST}`)
    .then(() => console.log("🔄 Keep alive ping sent"))
    .catch(() => console.log("⚠️ Ping failed"));
}, 5 * 60 * 1000);

// === ADS MANAGEMENT API ===
app.get("/api/ads", async (req, res) => {
  try {
    const ads = await pool.query("SELECT * FROM ads ORDER BY id DESC");
    res.json(ads.rows);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil data iklan" });
  }
});

app.post("/api/ads", async (req, res) => {
  const { title, url, reward, status } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO ads (title, url, reward, status) VALUES ($1,$2,$3,$4) RETURNING *",
      [title, url, reward, status || 'active']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Gagal menambah iklan" });
  }
});

app.put("/api/ads/:id", async (req, res) => {
  const { id } = req.params;
  const { title, url, reward, status } = req.body;
  try {
    const result = await pool.query(
      "UPDATE ads SET title=$1, url=$2, reward=$3, status=$4 WHERE id=$5 RETURNING *",
      [title, url, reward, status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Gagal update iklan" });
  }
});

app.delete("/api/ads/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM ads WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Gagal hapus iklan" });
  }
});

// ====================== START SERVER ======================
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
