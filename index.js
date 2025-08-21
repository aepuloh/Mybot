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
const BASE_HOST = process.env.RAILWAY_STATIC_URL || "localhost:" + PORT;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_ID = process.env.ADMIN_ID; // optional (untuk notif withdraw)

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
      -- status kolom untuk menandai iklan aktif / nonaktif
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
})();

// ===== Helper DB
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

// ====== State sederhana untuk withdraw
const waitingWithdraw = new Map(); // key: user_id, value: true

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

  bot.sendMessage(
    chatId,
    "👋 Selamat datang di Bot Nonton Iklan!\nPilih menu:",
    opts
  );
});

// Handler umum pesan
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Jika sedang menunggu nomor DANA
  if (waitingWithdraw.get(chatId)) {
    const user = await getUser(chatId);
    const danaNumber = text;

    await pool.query(
      "INSERT INTO withdraw_requests (user_id, amount, dana_number, status) VALUES ($1, $2, $3, $4)",
      [chatId, user?.points || 0, danaNumber, "pending"]
    );

    waitingWithdraw.delete(chatId);

    // kirim ke user
    bot.sendMessage(
      chatId,
      `✅ Permintaan withdraw sebesar ${user.points} poin (≈Rp${user.points}) telah dikirim.\nNomor DANA: ${danaNumber}\n\nSilakan tunggu admin memproses.`
    );

    // notifikasi admin (jika ada)
    if (ADMIN_ID) {
      bot.sendMessage(
        ADMIN_ID,
        `📥 Request Withdraw Baru:\n\n👤 User: ${chatId}\n💰 Jumlah: ${user.points} poin\n💳 DANA: ${danaNumber}`
      );
    }

    // kosongkan saldo user
    await pool.query("UPDATE users SET points = 0 WHERE user_id=$1", [chatId]);
    return; // stop di sini
  }

  // Menu biasa
  const user = await getUser(chatId);
  if (!user) return;

  if (text === "💰 Cek Poin") {
    bot.sendMessage(chatId, `💎 Saldo poin kamu: ${user.points}`);
    return;
  }

  if (text === "🎬 Nonton Iklan") {
    bot.sendMessage(
      chatId,
      `🎥 Klik link berikut untuk menonton iklan:\nhttps://${BASE_HOST}/watch?user_id=${chatId}`
    );
    return;
  }

  if (text === "💵 Withdraw") {
    if (!user || user.points < 10000) {
      bot.sendMessage(
        chatId,
        "⚠️ Saldo kamu belum cukup untuk withdraw.\nMinimal 10.000 poin."
      );
    } else {
      bot.sendMessage(chatId, "💳 Masukkan nomor DANA kamu untuk withdraw:");
      waitingWithdraw.set(chatId, true);
    }
    return;
  }

  if (text === "📜 Riwayat") {
    if (!user.history || user.history.length === 0) {
      bot.sendMessage(chatId, "📭 Belum ada riwayat transaksi.");
    } else {
      bot.sendMessage(chatId, "📜 Riwayat:\n" + user.history.join("\n"));
    }
    return;
  }
});

// ====================== WEB: IKLAN ======================
// halaman nonton
app.get("/watch", async (req, res) => {
  const { user_id } = req.query;
  const user = await getUser(user_id);
  if (!user) return res.send("User tidak ditemukan");

  // ambil satu iklan aktif terbaru
  const adRes = await pool.query(
    "SELECT * FROM ads WHERE status='active' ORDER BY id DESC LIMIT 1"
  );
  const ad = adRes.rows[0];

  // fallback (kalau belum ada di DB)
  const scriptUrl =
    ad?.url || "https://ad.gigapub.tech/script?id=1669";
  const reward = ad?.reward || 10;

  res.type("html").send(`<!DOCTYPE html>
<html>
  <head>
    <title>Nonton Iklan</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <script src="${scriptUrl}"></script>
  </head>
  <body style="text-align:center;font-family:sans-serif;">
    <h2>🎬 Tonton Iklan Berikut</h2>
    <p id="status">⏳ Tunggu 5 detik...</p>

    <script>
      document.addEventListener("DOMContentLoaded", function() {
        // Jika script iklan expose fungsi showGiga()
        if (typeof window.showGiga === "function") {
          window.showGiga().then(() => {
            let countdown = 5;
            const statusEl = document.getElementById("status");

            const interval = setInterval(() => {
              countdown--;
              if (countdown > 0) {
                statusEl.textContent = "⏳ Tunggu " + countdown + " detik...";
              } else {
                clearInterval(interval);
                fetch("/reward?user_id=${user_id}&reward=${reward}")
                  .then(() => {
                    statusEl.textContent = "✅ Kamu mendapat ${reward} poin!";
                    setTimeout(() => {
                      window.location.href = "https://t.me/Addsstargaze_bot";
                    }, 1500);
                  });
              }
            }, 1000);
          }).catch(() => {
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
  const reward = parseInt(req.query.reward || "10", 10);
  const user = await getUser(user_id);
  if (!user) return res.send("User tidak ditemukan");

  await updatePoints(
    user_id,
    reward,
    `+${reward} poin dari iklan (${new Date().toLocaleString()})`
  );
  res.send("Reward diberikan");
});

// ====================== ADMIN PANEL (HTML) ======================
app.get("/admin", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("❌ Unauthorized");

  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin Panel</title>
  <style>
    body { font-family: sans-serif; margin:0; padding:0; }
    .tabbar { position: fixed; bottom:0; left:0; right:0; display:flex; border-top:1px solid #ccc; background:#f9f9f9; }
    .tab { flex:1; text-align:center; padding:12px; cursor:pointer; user-select:none; }
    .tab:hover { background:#eee; }
    .content { padding:20px; margin-bottom:70px; }
    table { border-collapse: collapse; width:100%; }
    th, td { border:1px solid #ddd; padding:8px; }
    th { background:#fafafa; text-align:left; }
    form input, form select, form button { margin:4px 6px 4px 0; padding:6px 8px; }
    .muted { color:#666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="content" id="content">📊 Memuat...</div>

  <div class="tabbar">
    <div class="tab" onclick="loadTab('users')">👤 Users</div>
    <div class="tab" onclick="loadTab('ads')">🎬 Ads</div>
    <div class="tab" onclick="loadTab('finance')">💰 Finance</div>
    <div class="tab" onclick="loadTab('settings')">⚙️ Settings</div>
  </div>

  <script>
    function getAdminKey() {
      const p = new URLSearchParams(location.search);
      return p.get('key') || '';
    }

    function loadTab(tab){
      if (tab === 'users') renderUsers();
      if (tab === 'ads') renderAds();
      if (tab === 'finance') renderFinance();
      if (tab === 'settings') renderSettings();
    }

    async function renderUsers(){
      const key = getAdminKey();
      const res = await fetch('/api/users?key=' + encodeURIComponent(key));
      const users = await res.json().catch(() => []);
      let rows = users.map(u => 
        '<tr><td>' + u.user_id + '</td><td>' + u.points + '</td><td>' + (u.history || []).length + '</td></tr>'
      ).join('');
      if (!rows) rows = '<tr><td colspan="3" class="muted">Kosong</td></tr>';

      document.getElementById('content').innerHTML =
        '<h3>👤 Kelola Users</h3>' +
        '<p><a id="export-link" href="#">⬇️ Export CSV</a></p>' +
        '<table><thead><tr><th>User ID</th><th>Points</th><th>Riwayat (count)</th></tr></thead><tbody>' + rows + '</tbody></table>';
      document.getElementById('export-link').href = '/export?key=' + encodeURIComponent(key);
    }

    async function renderAds(){
      document.getElementById('content').innerHTML =
        '<h3>🎬 Kelola Ads</h3>' +
        '<form id="ad-form">' +
          '<input type="hidden" id="ad-id" />' +
          '<input type="text" id="ad-title" placeholder="Judul iklan" required />' +
          '<input type="url" id="ad-url" placeholder="URL script iklan" required />' +
          '<input type="number" id="ad-reward" placeholder="Reward" required />' +
          '<select id="ad-status"><option value="active">Active</option><option value="inactive">Inactive</option></select>' +
          '<button type="submit">Simpan</button>' +
        '</form>' +
        '<p class="muted">Tips: URL script berisi JS yang memanggil window.showGiga() atau serupa.</p>' +
        '<br />' +
        '<table><thead><tr><th>ID</th><th>Judul</th><th>URL</th><th>Reward</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="ads-table-body"><tr><td colspan="6">Memuat...</td></tr></tbody></table>' +
        '<p><button id="set-active-btn">Set Aktif (by ID)</button> <input id="active-id" type="number" placeholder="ID"/></p>';

      document.getElementById("ad-form").addEventListener("submit", onSubmitAdForm);
      document.getElementById("set-active-btn").addEventListener("click", async () => {
        const id = document.getElementById("active-id").value;
        if (!id) return alert("Masukkan ID iklan");
        await fetch('/api/adcur/' + encodeURIComponent(id), { method: 'POST', headers: { "Content-Type": "application/json" }});
        loadAds();
      });

      loadAds();
    }

    async function renderFinance(){
      const key = getAdminKey();
      const res = await fetch('/api/withdraws?key=' + encodeURIComponent(key));
      const rows = (await res.json().catch(() => [])).map(w =>
        '<tr>' +
          '<td>' + w.id + '</td>' +
          '<td>' + w.user_id + '</td>' +
          '<td>' + w.amount + '</td>' +
          '<td>' + (w.dana_number || '-') + '</td>' +
          '<td>' + w.status + '</td>' +
          '<td><button onclick="markPaid(' + w.id + ')">Tandai Paid</button></td>' +
        '</tr>'
      ).join('') || '<tr><td colspan="6" class="muted">Kosong</td></tr>';

      document.getElementById('content').innerHTML =
        '<h3>💰 Finance</h3>' +
        '<table><thead><tr><th>ID</th><th>User</th><th>Amount</th><th>DANA</th><th>Status</th><th>Aksi</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    async function renderSettings(){
      document.getElementById('content').innerHTML =
        '<h3>⚙️ Settings</h3>' +
        '<p class="muted">Tidak ada pengaturan khusus saat ini.</p>';
    }

    async function loadAds() {
      const res = await fetch("/api/ads");
      const ads = await res.json().catch(() => []);
      const tbody = document.getElementById("ads-table-body");
      if (!tbody) return;
      tbody.innerHTML = "";

      ads.forEach(function(ad){
        tbody.innerHTML +=
          '<tr>' +
            '<td>' + ad.id + '</td>' +
            '<td>' + escapeHtml(ad.title) + '</td>' +
            '<td><a href="' + escapeAttr(ad.url) + '" target="_blank">' + escapeHtml(ad.url) + '</a></td>' +
            '<td>' + ad.reward + '</td>' +
            '<td>' + escapeHtml(ad.status) + '</td>' +
            '<td>' +
              '<button onclick="editAd(' + Number(ad.id) + ', \'' + jsQuote(ad.title) + '\', \'' + jsQuote(ad.url) + '\',' + Number(ad.reward) + ', \'' + jsQuote(ad.status) + '\')">✏️</button> ' +
              '<button onclick="deleteAd(' + Number(ad.id) + ')">🗑️</button>' +
            '</td>' +
          '</tr>';
      });
    }

    function editAd(id, title, url, reward, status) {
      document.getElementById("ad-id").value = id;
      document.getElementById("ad-title").value = title;
      document.getElementById("ad-url").value = url;
      document.getElementById("ad-reward").value = reward;
      document.getElementById("ad-status").value = status;
      document.getElementById("ad-form").scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function deleteAd(id) {
      if (!confirm("Yakin hapus iklan ini?")) return;
      await fetch('/api/ads/' + encodeURIComponent(id), { method: 'DELETE' });
      loadAds();
    }

    async function markPaid(id) {
      if (!confirm("Tandai request #" + id + " sebagai paid?")) return;
      await fetch('/api/withdraws/' + encodeURIComponent(id) + '/paid', { method: 'POST' });
      renderFinance();
    }

    async function onSubmitAdForm(e) {
      e.preventDefault();
      const id = document.getElementById("ad-id").value.trim();
      const title = document.getElementById("ad-title").value.trim();
      const url = document.getElementById("ad-url").value.trim();
      const reward = Number(document.getElementById("ad-reward").value.trim());
      const status = document.getElementById("ad-status").value;

      const method = id ? "PUT" : "POST";
      const endpoint = id ? ('/api/ads/' + encodeURIComponent(id)) : '/api/ads';

      await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, url, reward, status })
      });

      document.getElementById("ad-form").reset();
      loadAds();
    }

    // Utilities escape
    function escapeHtml(s) {
      return String(s)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'","&#39;");
    }
    function escapeAttr(s) {
      return escapeHtml(s);
    }
    function jsQuote(s) {
      return String(s).replaceAll("\\\\","\\\\\\\\").replaceAll("'","\\\\'");
    }

    // default buka tab Ads
    window.addEventListener('load', function(){ loadTab('ads'); });
  </script>
</body>
</html>`);
});

// ====================== ADMIN DATA APIs ======================
// Users list (for Users tab)
app.get("/api/users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  const result = await pool.query("SELECT user_id, points, history FROM users ORDER BY user_id DESC");
  res.json(result.rows);
});

// Withdraws list + mark paid
app.get("/api/withdraws", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  const r = await pool.query("SELECT * FROM withdraw_requests ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/withdraws/:id/paid", async (req, res) => {
  // bisa tambahkan key kalau mau proteksi lebih: ?key=
  await pool.query("UPDATE withdraw_requests SET status='paid' WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ====================== ADS MANAGEMENT API ======================
app.get("/api/ads", async (req, res) => {
  try {
    const ads = await pool.query("SELECT * FROM ads ORDER BY id DESC");
    res.json(ads.rows);
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil data iklan" });
  }
});

app.post("/api/ads", async (req, res) => {
  const { title, url, reward, status } = req.body || {};
  try {
    const result = await pool.query(
      "INSERT INTO ads (title, url, reward, status) VALUES ($1,$2,$3,$4) RETURNING *",
      [title, url, reward || 10, status || "active"]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Gagal menambah iklan" });
  }
});

app.put("/api/ads/:id", async (req, res) => {
  const { id } = req.params;
  const { title, url, reward, status } = req.body || {};
  try {
    const result = await pool.query(
      "UPDATE ads SET title=$1, url=$2, reward=$3, status=$4 WHERE id=$5 RETURNING *",
      [title, url, reward || 10, status || "active", id]
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

// ====== "adcur" (current ad) ======
// Dapatkan iklan aktif terkini
app.get("/api/adcur", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM ads WHERE status='active' ORDER BY id DESC LIMIT 1");
    res.json(r.rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: "Gagal ambil ad aktif" });
  }
});
// Jadikan ID tertentu sebagai active (opsional)
app.post("/api/adcur/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE ads SET status='inactive' WHERE status='active'");
    await pool.query("UPDATE ads SET status='active' WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Gagal set ad aktif" });
  }
});

// ====================== EXPORT USERS CSV ======================
app.get("/export", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("❌ Unauthorized");

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

// ====================== START SERVER ======================
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
