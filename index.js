// index.js — Telegram Ads Bot + Admin Panel + Referral + Daily + Spin + Quiz (Stable)
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
const BASE_HOST =
  process.env.PUBLIC_HOST ||
  process.env.RAILWAY_STATIC_URL ||
  ("localhost:" + PORT);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_ID = process.env.ADMIN_ID; // optional

if (!TOKEN) {
  console.error("❌ TOKEN belum di-set.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL belum di-set.");
  process.exit(1);
}

// ====================== DATABASE ======================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Buat tabel & auto-repair kolom yang dibutuhkan
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      points INT DEFAULT 0,
      history TEXT[]
    )
  `);

  // Tambah kolom opsional bila belum ada
  const userCols = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name='users'
  `);
  const cols = userCols.rows.map((r) => r.column_name);
  if (!cols.includes("ref_by"))
    await pool.query("ALTER TABLE users ADD COLUMN ref_by BIGINT");
  if (!cols.includes("last_daily"))
    await pool.query("ALTER TABLE users ADD COLUMN last_daily TIMESTAMP");
  if (!cols.includes("last_spin"))
    await pool.query("ALTER TABLE users ADD COLUMN last_spin TIMESTAMP");
  if (!cols.includes("created_at"))
    await pool.query(
      "ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT NOW()"
    );

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
  const res = await pool.query("SELECT * FROM users WHERE user_id=$1", [
    user_id,
  ]);
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
const DAY = 24 * 60 * 60 * 1000;
function nowLocal() {
  return new Date().toLocaleString();
}

// ====================== BOT (Webhook) ======================
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
        await updatePoints(
          ref_by,
          50,
          `+50 poin referral dari ${chatId} (${nowLocal()})`
        );
        bot.sendMessage(
          ref_by,
          `🎉 Kamu dapat +50 poin dari referral baru: ${chatId}`
        );
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
        ["🎁 Daily Bonus", "🎡 Spin", "❓ Quiz"],
      ],
      resize_keyboard: true,
    },
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
  if (user.last_daily && now - new Date(user.last_daily) < DAY) {
    return bot.sendMessage(
      chatId,
      "⚠️ Kamu sudah klaim bonus harian hari ini. Coba lagi besok."
    );
    }
  await updatePoints(chatId, 100, `+100 daily bonus (${nowLocal()})`);
  await pool.query("UPDATE users SET last_daily=$1 WHERE user_id=$2", [
    now,
    chatId,
  ]);
  bot.sendMessage(chatId, "🎁 Kamu klaim +100 poin dari bonus harian!");
});

bot.onText(/\/spin/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  const user = await getUser(chatId);
  const now = new Date();
  if (user.last_spin && now - new Date(user.last_spin) < DAY) {
    return bot.sendMessage(chatId, "⚠️ Kamu sudah spin hari ini. Coba lagi besok!");
  }
  const rewards = [0, 5, 10, 20, 50, 100];
  const win = rewards[Math.floor(Math.random() * rewards.length)];
  await updatePoints(chatId, win, `Spin: +${win} poin (${nowLocal()})`);
  await pool.query("UPDATE users SET last_spin=$1 WHERE user_id=$2", [
    now,
    chatId,
  ]);
  bot.sendMessage(chatId, `🎡 Hasil spin: ${win} poin!`);
});

bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);

  // Ambil soal aktif random dari DB; fallback ke hardcoded jika kosong
  const r = await pool.query(
    "SELECT * FROM quizzes WHERE active=TRUE ORDER BY random() LIMIT 1"
  );
  let soal;
  if (r.rows.length) {
    const row = r.rows[0];
    soal = {
      q: row.question,
      a: String(row.answer).toLowerCase(),
      reward: row.reward || 30,
    };
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
  bot.sendMessage(
    chatId,
    `❓ Quiz:\n${soal.q}\n\nKetik jawabanmu (1x kesempatan).`
  );
});

bot.onText(/\/leaderboard/, async (msg) => {
  const chatId = msg.chat.id;
  const r = await pool.query(
    "SELECT user_id, points FROM users ORDER BY points DESC LIMIT 10"
  );
  const lines = r.rows.map((u, i) => `${i + 1}. ${u.user_id} — ${u.points} pts`);
  bot.sendMessage(chatId, `🏆 Leaderboard:\n` + (lines.join("\n") || "Kosong"));
});

// ====================== MESSAGE HANDLER ======================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = (msg.text || "").trim();
  const text = textRaw.toLowerCase();

  // Withdraw flow
  if (waitingWithdraw.get(chatId)) {
    const user = await getUser(chatId);
    const danaNumber = textRaw;
    await pool.query(
      "INSERT INTO withdraw_requests (user_id, amount, dana_number, status) VALUES ($1,$2,$3,$4)",
      [chatId, user?.points || 0, danaNumber, "pending"]
    );
    waitingWithdraw.delete(chatId);
    bot.sendMessage(
      chatId,
      `✅ Withdraw ${user.points} poin dikirim ke ${danaNumber}`
    );
    if (ADMIN_ID) {
      bot.sendMessage(
        ADMIN_ID,
        `📥 Withdraw Baru\nUser: ${chatId}\nJumlah: ${user.points}\nDANA: ${danaNumber}`
      );
    }
    await pool.query("UPDATE users SET points=0 WHERE user_id=$1", [chatId]);
    return;
  }

  // Quiz flow
  if (waitingQuiz.get(chatId)) {
    const soal = waitingQuiz.get(chatId);
    waitingQuiz.delete(chatId);
    if (text === soal.a) {
      await updatePoints(
        chatId,
        soal.reward,
        `+${soal.reward} poin quiz (${nowLocal()})`
      );
      bot.sendMessage(
        chatId,
        `🎉 Benar! Kamu dapat +${soal.reward} poin.`
      );
    } else {
      bot.sendMessage(chatId, "❌ Jawaban salah. Semangat lagi!");
    }
    return;
  }

  // Keyboard menu
  const user = await getUser(chatId);
  if (!user) return;

  if (text === "💰 cek poin")
    return bot.sendMessage(chatId, `💎 Poin kamu: ${user.points}`);

  if (text === "🎬 nonton iklan") {
    const me = await bot.getMe();
    return bot.sendMessage(
      chatId,
      `🎥 Klik:\nhttps://${BASE_HOST}/watch?user_id=${chatId}&b=${me.username}`
    );
  }

  if (text === "💵 withdraw") {
    if (user.points < 10000)
      return bot.sendMessage(
        chatId,
        "⚠️ Minimal 10.000 poin untuk withdraw"
      );
    bot.sendMessage(chatId, "💳 Masukkan nomor DANA kamu:");
    waitingWithdraw.set(chatId, true);
    return;
  }

  if (text === "📜 riwayat") {
    if (!user.history?.length)
      return bot.sendMessage(chatId, "📭 Belum ada riwayat");
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

  const adRes = await pool.query(
    "SELECT * FROM ads WHERE status='active' ORDER BY id DESC LIMIT 1"
  );
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

// Users list (fallback aman kalau kolom opsional belum ada)
app.get("/api/users", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const r = await pool.query(
      "SELECT user_id,points,history,ref_by,created_at FROM users ORDER BY user_id DESC"
    );
    res.json(r.rows);
  } catch (_e) {
    const r = await pool.query(
      "SELECT user_id,points,history FROM users ORDER BY user_id DESC"
    );
    res.json(r.rows);
  }
});

// Adjust points (+/-)
app.post("/api/user/:id/points", async (req, res) => {
  if (!guard(req, res)) return;
  const user_id = parseInt(req.params.id, 10);
  const delta = parseInt(req.body?.delta || 0, 10);
  if (!user_id || !delta) return res.status(400).json({ error: "Bad params" });
  await updatePoints(
    user_id,
    delta,
    `${delta >= 0 ? "+" : ""}${delta} by admin (${nowLocal()})`
  );
  res.json({ success: true });
});

// Reset points to 0
app.post("/api/user/:id/reset", async (req, res) => {
  if (!guard(req, res)) return;
  const user_id = parseInt(req.params.id, 10);
  await pool.query("UPDATE users SET points=0 WHERE user_id=$1", [user_id]);
  await updatePoints(user_id, 0, `reset by admin (${nowLocal()})`);
  res.json({ success: true });
});

// Withdraws
app.get("/api/withdraws", async (req, res) => {
  if (!guard(req, res)) return;
  const r = await pool.query(
    "SELECT * FROM withdraw_requests ORDER BY id DESC"
  );
  res.json(r.rows);
});
app.post("/api/withdraws/:id", async (req, res) => {
  if (!guard(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const st = (req.body?.status || "").toLowerCase();
  if (!["approved", "rejected", "pending"].includes(st))
    return res.status(400).json({ error: "Bad status" });
  await pool.query("UPDATE withdraw_requests SET status=$1 WHERE id=$2", [
    st,
    id,
  ]);
  res.json({ success: true });
});

// Ads CRUD (biar simpel tanpa key; kalau mau kunci, tambah guard di bawah)
app.get("/api/ads", async (_req, res) => {
  const r = await pool.query("SELECT * FROM ads ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/ads", async (req, res) => {
  const { title, url, reward, status } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: "Bad params" });
  const r = await pool.query(
    "INSERT INTO ads (title,url,reward,status) VALUES ($1,$2,$3,$4) RETURNING *",
    [title, url, reward || 10, status || "active"]
  );
  res.json(r.rows[0]);
});
app.put("/api/ads/:id", async (req, res) => {
  const { id } = req.params;
  const { title, url, reward, status } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: "Bad params" });
  const r = await pool.query(
    "UPDATE ads SET title=$1,url=$2,reward=$3,status=$4 WHERE id=$5 RETURNING *",
    [title, url, reward || 10, status || "active", id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/ads/:id", async (req, res) => {
  await pool.query("DELETE FROM ads WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// Quiz CRUD (dijaga dengan key)
app.get("/api/quizzes", async (req, res) => {
  if (!guard(req, res)) return;
  const r = await pool.query("SELECT * FROM quizzes ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/quizzes", async (req, res) => {
  if (!guard(req, res)) return;
  const { question, answer, reward, active } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: "Bad params" });
  const r = await pool.query(
    "INSERT INTO quizzes (question,answer,reward,active) VALUES ($1,$2,$3,$4) RETURNING *",
    [question, answer, reward || 30, active !== false]
  );
  res.json(r.rows[0]);
});
app.put("/api/quizzes/:id", async (req, res) => {
  if (!guard(req, res)) return;
  const { id } = req.params;
  const { question, answer, reward, active } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: "Bad params" });
  const r = await pool.query(
    "UPDATE quizzes SET question=$1, answer=$2, reward=$3, active=$4 WHERE id=$5 RETURNING *",
    [question, answer, reward || 30, !!active, id]
  );
  res.json(r.rows[0]);
});
app.delete("/api/quizzes/:id", async (req, res) => {
  if (!guard(req, res)) return;
  await pool.query("DELETE FROM quizzes WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// Export CSV
app.get("/export", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("❌ Unauthorized");
  const r = await pool.query("SELECT * FROM users");
  const data = r.rows.map((u) => ({
    user_id: u.user_id,
    points: u.points,
    ref_by: u.ref_by || "",
    created_at: u.created_at,
    history: (u.history || []).join("; "),
  }));
  const parser = new Parser({
    fields: ["user_id", "points", "ref_by", "created_at", "history"],
  });
  const csv = parser.parse(data);
  res.header("Content-Type", "text/csv");
  res.attachment("users.csv");
  res.send(csv);
});

// ====================== ADMIN PANEL (HTML) ======================
app.get("/admin", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("❌ Unauthorized");
  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Admin Panel</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root{--pad:14px}
  body{font-family:sans-serif;margin:0}
  .top{padding:var(--pad);display:flex;gap:8px;align-items:center;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:1}
  .tabbar{position:fixed;bottom:0;left:0;right:0;display:flex;border-top:1px solid #ccc;background:#f9f9f9}
  .tab{flex:1;text-align:center;padding:12px;cursor:pointer}
  .tab.active{background:#eaeaea;font-weight:bold}
  .content{padding:var(--pad);margin-bottom:70px}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #ddd;padding:8px}
  th{background:#fafafa;text-align:left}
  .muted{color:#666;font-size:12px}
  .error{color:#c00;font-weight:bold}
  input,select,button{padding:8px;margin:4px}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .card{border:1px solid #eee;border-radius:10px;padding:12px;margin:8px 0}
</style>
</head><body>
<div class="top">
  <strong>Admin Panel</strong>
  <span class="muted">Key OK</span>
</div>
<div class="content" id="content">📊 Memuat...</div>
<div class="tabbar">
  <div id="tab-users" class="tab" onclick="loadTab('users')">👤 Users</div>
  <div id="tab-ads" class="tab" onclick="loadTab('ads')">🎬 Ads</div>
  <div id="tab-fin" class="tab" onclick="loadTab('finance')">💰 Finance</div>
  <div id="tab-quiz" class="tab" onclick="loadTab('quiz')">❓ Quiz</div>
  <div id="tab-settings" class="tab" onclick="loadTab('settings')">⚙️ Settings</div>
</div>
<script>
// fungsi getKey(), setActive(), loadTab() dst...
function getKey(){return new URLSearchParams(location.search).get('key')||''}
function setActive(t){
  ['users','ads','finance','settings','quiz'].forEach(x=>{
    const el = document.getElementById('tab-'+x);
    if(el) el.classList.remove('active');
  });
  const cur = document.getElementById('tab-'+t);
  if(cur) cur.classList.add('active');
}
function loadTab(t){setActive(t); if(t==='users')renderUsers(); if(t==='ads')renderAds(); if(t==='finance')renderFinance(); if(t==='settings')renderSettings(); if(t==='quiz')renderQuiz();}

async function renderUsers(){
async function renderUsers(){
  try{
    const r = await fetch('/api/users?key='+encodeURIComponent(getKey()));
    if(!r.ok) throw new Error('API /api/users gagal: '+r.status);
    const u = await r.json();

    // DEBUG: tampilkan JSON langsung di halaman
    document.getElementById('content').innerHTML =
      '<pre style="text-align:left;white-space:pre-wrap">'+JSON.stringify(u,null,2)+'</pre>';

  }catch(e){
    document.getElementById('content').innerHTML =
      '<div class="error">⚠️ Gagal memuat users: '+e.message+'</div>';
  }
}

// ---- Ads
async function renderAds(){
  document.getElementById('content').innerHTML=
    '<div class="card"><form id="ad-form" class="row">'+
    '<input type="hidden" id="ad-id">'+
    '<input type="text" id="ad-title" placeholder="Judul" required>'+
    '<input type="url" id="ad-url" placeholder="URL script" required>'+
    '<input type="number" id="ad-reward" placeholder="Reward" required>'+
    '<select id="ad-status"><option value="active">Active</option><option value="inactive">Inactive</option></select>'+
    '<button type="submit">Simpan</button></form></div>'+
    '<table><thead><tr><th>ID</th><th>Judul</th><th>URL</th><th>Reward</th><th>Status</th><th>Aksi</th></tr></thead><tbody id="ads-body"><tr><td colspan=6>Memuat...</td></tr></tbody></table>';
  document.getElementById('ad-form').addEventListener('submit',onSubmitAdForm);
  loadAds();
}
async function loadAds(){
  try{
    const r=await fetch('/api/ads'); if(!r.ok) throw new Error('API /api/ads gagal: '+r.status);
    const ads=await r.json();
    const tb=document.getElementById('ads-body'); tb.innerHTML='';
    ads.forEach(a=>{
      tb.innerHTML+= '<tr>'+
        '<td>'+a.id+'</td>'+
        '<td>'+a.title+'</td>'+
        '<td><a href="'+a.url+'" target="_blank">'+a.url+'</a></td>'+
        '<td>'+a.reward+'</td>'+
        '<td>'+a.status+'</td>'+
        '<td><button onclick="editAd('+a.id+',\\''+a.title.replace(/'/g,"\\'")+'\\',\\''+a.url.replace(/'/g,"\\'")+'\\','+a.reward+',\\''+a.status+'\\')">✏️</button>'+
        '<button onclick="deleteAd('+a.id+')">🗑️</button></td></tr>';
    });
  }catch(e){
    document.getElementById('content').innerHTML='<div class="error">⚠️ '+e.message+'</div>';
  }
}
function editAd(id,t,u,r,s){document.getElementById('ad-id').value=id;document.getElementById('ad-title').value=t;document.getElementById('ad-url').value=u;document.getElementById('ad-reward').value=r;document.getElementById('ad-status').value=s}
async function deleteAd(id){await fetch('/api/ads/'+id,{method:'DELETE'});loadAds()}
async function onSubmitAdForm(e){
  e.preventDefault();
  const id=document.getElementById('ad-id').value.trim();
  const title=document.getElementById('ad-title').value.trim();
  const url=document.getElementById('ad-url').value.trim();
  const reward=+document.getElementById('ad-reward').value.trim();
  const status=document.getElementById('ad-status').value;
  const method=id?'PUT':'POST';
  const endpoint=id?('/api/ads/'+id):'/api/ads';
  await fetch(endpoint,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({title,url,reward,status})});
  (document.getElementById('ad-form')).reset(); loadAds();
}

// ---- Finance (Withdraws)
async function renderFinance(){
  try{
    const r=await fetch('/api/withdraws?key='+encodeURIComponent(getKey()));
    if(!r.ok) throw new Error('API /api/withdraws gagal: '+r.status);
    const w=await r.json();
    let rows=(w||[]).map(x=>'<tr>'+
      '<td>'+x.id+'</td>'+
      '<td>'+x.user_id+'</td>'+
      '<td>'+x.amount+'</td>'+
      '<td>'+x.dana_number+'</td>'+
      '<td>'+x.status+'</td>'+
      '<td>'+(x.status==='pending'
        ? '<button onclick="setWdStatus('+x.id+',\\'approved\\')">Approve</button><button onclick="setWdStatus('+x.id+',\\'rejected\\')">Reject</button>'
        : '-')+'</td>'+
    '</tr>').join('');
    if(!rows) rows='<tr><td colspan=6>Kosong</td></tr>';
    document.getElementById('content').innerHTML='<h3>💰 Withdraws</h3><table><thead><tr><th>ID</th><th>User</th><th>Amount</th><th>DANA</th><th>Status</th><th>Aksi</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    document.getElementById('content').innerHTML='<div class="error">⚠️ '+e.message+'</div>';
  }
}
async function setWdStatus(id,status){
  await fetch('/api/withdraws/'+id+'?key='+encodeURIComponent(getKey()),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  renderFinance();
}

// ---- Quiz
async function renderQuiz(){
  const wrap=(html)=>document.getElementById('content').innerHTML=html;
  wrap('<div class="card"><form id="quiz-form" class="row">'+
    '<input type="hidden" id="quiz-id">'+
    '<input type="text" id="quiz-q" placeholder="Pertanyaan" required style="flex:1 1 300px">'+
    '<input type="text" id="quiz-a" placeholder="Jawaban" required>'+
    '<input type="number" id="quiz-r" placeholder="Reward (default 30)">'+
    '<select id="quiz-active"><option value="true">Active</option><option value="false">Inactive</option></select>'+
    '<button type="submit">Simpan</button></form></div>'+
    '<table><thead><tr><th>ID</th><th>Pertanyaan</th><th>Jawaban</th><th>Reward</th><th>Active</th><th>Aksi</th></tr></thead><tbody id="quiz-body"><tr><td colspan=6>Memuat...</td></tr></tbody></table>');
  document.getElementById('quiz-form').addEventListener('submit', onSubmitQuizForm);
  loadQuiz();
}
async function loadQuiz(){
  try{
    const r=await fetch('/api/quizzes?key='+encodeURIComponent(getKey()));
    if(!r.ok) throw new Error('API /api/quizzes gagal: '+r.status);
    const qs=await r.json();
    const tb=document.getElementById('quiz-body'); tb.innerHTML='';
    qs.forEach(q=>{
      tb.innerHTML += '<tr>'+
        '<td>'+q.id+'</td>'+
        '<td>'+q.question+'</td>'+
        '<td>'+q.answer+'</td>'+
        '<td>'+q.reward+'</td>'+
        '<td>'+q.active+'</td>'+
        '<td><button onclick="editQuiz('+q.id+',\\''+q.question.replace(/'/g,"\\'")+'\\',\\''+q.answer.replace(/'/g,"\\'")+'\\','+q.reward+','+q.active+')">✏️</button>'+
        '<button onclick="delQuiz('+q.id+')">🗑️</button></td></tr>';
    });
  }catch(e){
    document.getElementById('content').innerHTML='<div class="error">⚠️ '+e.message+'</div>';
  }
}
function editQuiz(id,q,a,r,act){document.getElementById('quiz-id').value=id;document.getElementById('quiz-q').value=q;document.getElementById('quiz-a').value=a;document.getElementById('quiz-r').value=r;document.getElementById('quiz-active').value=String(act)}
async function delQuiz(id){await fetch('/api/quizzes/'+id+'?key='+encodeURIComponent(getKey()),{method:'DELETE'});loadQuiz()}
async function onSubmitQuizForm(e){
  e.preventDefault();
  const id=document.getElementById('quiz-id').value.trim();
  const question=document.getElementById('quiz-q').value.trim();
  const answer=document.getElementById('quiz-a').value.trim();
  const reward=+document.getElementById('quiz-r').value.trim() || 30;
  const active=document.getElementById('quiz-active').value==='true';
  const method=id?'PUT':'POST';
  const endpoint=id?('/api/quizzes/'+id):'/api/quizzes';
  await fetch(endpoint+'?key='+encodeURIComponent(getKey()),{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({question,answer,reward,active})});
  (document.getElementById('quiz-form')).reset(); loadQuiz();
}

// ---- Settings placeholder
async function renderSettings(){
  document.getElementById('content').innerHTML =
    '<div class="card"><div class="row">'+
    '<div class="muted">Tidak ada setting khusus. Gunakan tab lain untuk mengelola data.</div>'+
    '</div></div>';
}

window.onload=()=>renderUsers();
</script></body></html>`);
});

// ====================== KEEP ALIVE ======================
app.get("/", (_req, res) => res.send("🚀 Bot is running"));
setInterval(() => {
  axios.get(`https://${BASE_HOST}`).catch(() => {});
}, 300000);

// ====================== START SERVER ======================
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
