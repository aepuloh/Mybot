// index.js — Telegram Ads Bot + Admin Panel (Users, Ads, Withdraws, Quizzes) + Referral + Daily + Spin + Quiz
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");
const { Parser } = require("json2csv");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ====================== CONFIG ======================
const TOKEN = process.env.TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || "Snowboy14";
const PORT = process.env.PORT || 3000;
const BASE_HOST =
  process.env.PUBLIC_HOST ||
  process.env.RAILWAY_STATIC_URL ||
  ("localhost:" + PORT);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_ID = process.env.ADMIN_ID || ""; // optional

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

  const userCols = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name='users'
  `);
  const cols = userCols.rows.map((r) => r.column_name);
  if (!cols.includes("last_quiz"))
  await pool.query("ALTER TABLE users ADD COLUMN last_quiz TIMESTAMP");
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
const waitingQuiz = new Map();

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
        if (ADMIN_ID) {
          bot.sendMessage(
            ADMIN_ID,
            `👥 Referral Baru\nReferrer: ${ref_by}\nUser: ${chatId}`
          );
        }
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
  const user = await getUser(chatId);
  const now = new Date();

  // cek cooldown 3 jam
  if (user.last_quiz && now - new Date(user.last_quiz) < 3 * 60 * 60 * 1000) {
    const sisa = Math.ceil((3 * 60 * 60 * 1000 - (now - new Date(user.last_quiz))) / 60000);
    return bot.sendMessage(chatId, `⚠️ Kamu sudah ikut quiz. Coba lagi dalam ${sisa} menit.`);
  }

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
  await pool.query("UPDATE users SET last_quiz=$1 WHERE user_id=$2", [now, chatId]);

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
      bot.sendMessage(chatId, `🎉 Benar! Kamu dapat +${soal.reward} poin.`);
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

  if (text === "🎁 daily bonus") { await handleDaily(chatId); return; }
if (text === "🎡 spin")        { await handleSpin(chatId);  return; }
if (text === "❓ quiz")        { await handleQuiz(chatId);  return; }
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

// ====================== ADMIN API ======================
function guard(req, res) {
  if (req.query.key !== ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Users
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

  // 🔔 Tambahkan notifikasi ke user
  const r = await pool.query("SELECT user_id, amount, dana_number FROM withdraw_requests WHERE id=$1", [id]);
  if (r.rows.length) {
    const wd = r.rows[0];
    if (st === "approved") {
      bot.sendMessage(
        wd.user_id,
        `✅ Withdraw kamu sebesar ${wd.amount} poin ke ${wd.dana_number} sudah *disetujui*.\n\nSilakan cek saldo Dana kamu.`
      );
    } else if (st === "rejected") {
      bot.sendMessage(
        wd.user_id,
        `❌ Withdraw kamu sebesar ${wd.amount} poin ke ${wd.dana_number} *ditolak*.\n\nSilakan hubungi admin.`
      );
    }
  }

  res.json({ success: true });
});

// Ads (GET publik untuk panel; POST/PUT/DELETE dilindungi)
app.get("/api/ads", async (_req, res) => {
  const r = await pool.query("SELECT * FROM ads ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/ads", async (req, res) => {
  if (!guard(req, res)) return;
  const { title, url, reward, status } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: "Bad params" });
  const r = await pool.query(
    "INSERT INTO ads (title,url,reward,status) VALUES ($1,$2,$3,$4) RETURNING *",
    [title, url, reward || 10, status || "active"]
  );
  res.json(r.rows[0]);
});
app.put("/api/ads/:id", async (req, res) => {
  if (!guard(req, res)) return;
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
  if (!guard(req, res)) return;
  await pool.query("DELETE FROM ads WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// Quizzes
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
  if (!guard(req, res)) return;
  const r = await pool.query("SELECT * FROM users");
  const data = r.rows.map((u) => ({
    user_id: u.user_id,
    points: u.points,
    ref_by: u.ref_by || "",
    created_at: u.created_at || "",
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
<html>
<head>
<meta charset='utf-8'>
<title>Admin Panel</title>
<meta name='viewport' content='width=device-width,initial-scale=1'/>
<style>
  :root{--pad:12px}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,sans-serif;margin:0;padding:var(--pad);background:#f7f7f9;color:#222}
  h2,h3{margin:8px 0}
  nav{margin:8px 0 14px 0}
  nav button{margin:2px;padding:8px 10px;border:1px solid #ddd;background:#fff;border-radius:10px;cursor:pointer}
  nav button.active{background:#111;color:#fff;border-color:#111}
  .wrap{display:block}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.04)}
  th,td{border-bottom:1px solid #eee;padding:10px;font-size:14px}
  th{background:#fafafa;text-align:left}
  tr:last-child td{border-bottom:none}
  .muted{color:#666;font-size:12px}
  .actions button{padding:6px 8px;margin:0 4px 4px 0;border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer}
  .card{background:#fff;border:1px solid #eee;border-radius:12px;padding:12px;margin:10px 0;box-shadow:0 2px 10px rgba(0,0,0,.04)}
  input,select{padding:8px;border:1px solid #ddd;border-radius:8px;margin:4px 4px 8px 0}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
</style>
</head>
<body>
<h2>⚙️ Admin Panel</h2>
<nav>
  <button id='btn-users' onclick="showTab('users')">👤 Users</button>
  <button id='btn-ads' onclick="showTab('ads')">🎬 Ads</button>
  <button id='btn-withdraws' onclick="showTab('withdraws')">💵 Withdraws</button>
  <button id='btn-quizzes' onclick="showTab('quizzes')">❓ Quizzes</button>
  <a id="btn-export" href="#" style="margin-left:6px;text-decoration:none">
    <button>⬇️ Export CSV</button>
  </a>
</nav>

<div id='tab-users' class='wrap'></div>
<div id='tab-ads' class='wrap' style='display:none'></div>
<div id='tab-withdraws' class='wrap' style='display:none'></div>
<div id='tab-quizzes' class='wrap' style='display:none'></div>

<script>
function getKey(){return new URLSearchParams(location.search).get('key')||''}
function api(url,opt){return fetch(url+(url.includes('?')?'&':'?')+'key='+encodeURIComponent(getKey()),opt)}
function setActive(id){
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
  const btn=document.getElementById('btn-'+id); if(btn) btn.classList.add('active');
}
function showTab(id){
  ['users','ads','withdraws','quizzes'].forEach(t=>document.getElementById('tab-'+t).style.display='none');
  setActive(id);
  document.getElementById('tab-'+id).style.display='block';
  if(id==='users') renderUsers();
  if(id==='ads') renderAds();
  if(id==='withdraws') renderWithdraws();
  if(id==='quizzes') renderQuizzes();
}
document.getElementById('btn-export').href='/export?key='+encodeURIComponent(getKey());

// ===== USERS
async function renderUsers(){
  const box=document.getElementById('tab-users');
  box.innerHTML='<div class="card">📊 Memuat users...</div>';
  try{
    const r=await api('/api/users'); if(!r.ok) throw new Error('HTTP '+r.status);
    const u=await r.json();
    let rows=(u||[]).map(x=>\`<tr>
      <td>\${x.user_id}</td>
      <td>\${x.points}</td>
      <td><button onclick="showHist(\${JSON.stringify(String(x.user_id))})">Lihat (\${x.history?x.history.length:0})</button></td>
      <td>\${x.ref_by??'-'}</td>
      <td>\${x.created_at||'-'}</td>
      <td class="actions">
        <button onclick="adjPts(\${JSON.stringify(String(x.user_id))},10)">+10</button>
        <button onclick="adjPts(\${JSON.stringify(String(x.user_id))},-10)">-10</button>
        <button onclick="resetPts(\${JSON.stringify(String(x.user_id))})">Reset</button>
      </td>
    </tr>\`).join('');
    if(!rows) rows='<tr><td colspan=6 class=muted>Kosong</td></tr>';
    box.innerHTML='<h3>👤 Users</h3><table><thead><tr><th>User ID</th><th>Poin</th><th>Riwayat</th><th>Ref By</th><th>Created</th><th>Aksi</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    box.innerHTML='<div class="card" style="color:red">⚠️ Gagal load users: '+e.message+'</div>';
  }
}
async function adjPts(uid,delta){
  await api('/api/user/'+uid+'/points',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delta})});
  renderUsers();
}
async function resetPts(uid){
  await api('/api/user/'+uid+'/reset',{method:'POST'});
  renderUsers();
}
async function showHist(uid){
  try{
    const r=await api('/api/users'); const u=await r.json();
    const me=(u||[]).find(v=>String(v.user_id)===String(uid));
    alert((me?.history||[]).join('\\n')||'Tidak ada riwayat');
  }catch(_){alert('Tidak bisa memuat riwayat');}
}

// ===== ADS
async function renderAds(){
  const box=document.getElementById('tab-ads');
  box.innerHTML='<div class="card">📊 Memuat ads...</div>';
  try{
    const r=await fetch('/api/ads'); if(!r.ok) throw new Error('HTTP '+r.status);
    const ads=await r.json();
    let rows=(ads||[]).map(a=>\`<tr>
      <td>\${a.id}</td><td>\${a.title}</td><td>\${a.url}</td><td>\${a.reward}</td><td>\${a.status}</td>
      <td class="actions">
        <button onclick="toggleAd(\${a.id}, '\${a.status}'==='active' ? 'paused' : 'active')">Toggle</button>
        <button onclick="delAd(\${a.id})">Hapus</button>
      </td>
    </tr>\`).join('');
    if(!rows) rows='<tr><td colspan=6 class=muted>Kosong</td></tr>';

    box.innerHTML=
      '<h3>🎬 Ads</h3>'+
      '<div class="card">'+
        '<div class="row">'+
          '<input id="ad-title" placeholder="Judul" />'+
          '<input id="ad-url" placeholder="Script URL" style="min-width:260px" />'+
          '<input id="ad-reward" type="number" placeholder="Reward" value="10" />'+
          '<select id="ad-status"><option value="active">active</option><option value="paused">paused</option></select>'+
          '<button onclick="addAd()">Tambah</button>'+
        '</div>'+
      '</div>'+
      '<table><thead><tr><th>ID</th><th>Judul</th><th>URL</th><th>Reward</th><th>Status</th><th>Aksi</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    box.innerHTML='<div class="card" style="color:red">⚠️ Gagal load ads: '+e.message+'</div>';
  }
}
async function addAd(){
  const title=document.getElementById('ad-title').value.trim();
  const url=document.getElementById('ad-url').value.trim();
  const reward=parseInt(document.getElementById('ad-reward').value||'10',10);
  const status=document.getElementById('ad-status').value;
  if(!title||!url){alert('Isi judul & URL');return;}
  await api('/api/ads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,url,reward,status})});
  renderAds();
}
async function toggleAd(id,next){
  const r=await fetch('/api/ads'); const ads=await r.json();
  const a=ads.find(x=>x.id===id);
  if(!a){alert('Iklan tidak ditemukan');return;}
  await api('/api/ads/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:a.title,url:a.url,reward:a.reward,status:next})});
  renderAds();
}
async function delAd(id){
  await api('/api/ads/'+id,{method:'DELETE'});
  renderAds();
}

// ===== WITHDRAWS
async function renderWithdraws(){
  const box=document.getElementById('tab-withdraws');
  box.innerHTML='<div class="card">📊 Memuat withdraws...</div>';
  try{
    const r=await api('/api/withdraws'); if(!r.ok) throw new Error('HTTP '+r.status);
    const w=await r.json();
    let rows=(w||[]).map(x=>\`<tr>
      <td>\${x.id}</td><td>\${x.user_id}</td><td>\${x.amount}</td><td>\${x.dana_number}</td><td>\${x.status}</td><td>\${x.created_at||'-'}</td>
      <td class="actions">
        <button onclick="setWd(\${x.id},'approved')">Approve</button>
        <button onclick="setWd(\${x.id},'rejected')">Reject</button>
      </td>
    </tr>\`).join('');
    if(!rows) rows='<tr><td colspan=7 class=muted>Kosong</td></tr>';
    box.innerHTML='<h3>💵 Withdraws</h3><table><thead><tr><th>ID</th><th>User</th><th>Amount</th><th>DANA</th><th>Status</th><th>Created</th><th>Aksi</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    box.innerHTML='<div class="card" style="color:red">⚠️ Gagal load withdraws: '+e.message+'</div>';
  }
}
async function setWd(id,status){
  await api('/api/withdraws/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  renderWithdraws();
}

// ===== QUIZZES
async function renderQuizzes(){
  const box=document.getElementById('tab-quizzes');
  box.innerHTML='<div class="card">📊 Memuat quizzes...</div>';
  try{
    const r=await api('/api/quizzes'); if(!r.ok) throw new Error('HTTP '+r.status);
    const q=await r.json();
    let rows=(q||[]).map(x=>\`<tr>
      <td>\${x.id}</td><td>\${x.question}</td><td>\${x.answer}</td><td>\${x.reward}</td><td>\${x.active}</td><td>\${x.created_at||'-'}</td>
      <td class="actions">
        <button onclick="delQuiz(\${x.id})">Hapus</button>
      </td>
    </tr>\`).join('');
    if(!rows) rows='<tr><td colspan=7 class=muted>Kosong</td></tr>';

    box.innerHTML=
      '<h3>❓ Quizzes</h3>'+
      '<div class="card">'+
        '<div class="row">'+
          '<input id="q-question" placeholder="Pertanyaan" style="min-width:260px" />'+
          '<input id="q-answer" placeholder="Jawaban" />'+
          '<input id="q-reward" type="number" placeholder="Reward" value="30" />'+
          '<select id="q-active"><option value="true">active</option><option value="false">inactive</option></select>'+
          '<button onclick="addQuiz()">Tambah</button>'+
        '</div>'+
      '</div>'+
      '<table><thead><tr><th>ID</th><th>Pertanyaan</th><th>Jawaban</th><th>Reward</th><th>Active</th><th>Created</th><th>Aksi</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    box.innerHTML='<div class="card" style="color:red">⚠️ Gagal load quizzes: '+e.message+'</div>';
  }
}
async function addQuiz(){
  const question=document.getElementById('q-question').value.trim();
  const answer=document.getElementById('q-answer').value.trim();
  const reward=parseInt(document.getElementById('q-reward').value||'30',10);
  const active=document.getElementById('q-active').value==='true';
  if(!question||!answer){alert('Isi pertanyaan & jawaban');return;}
  await api('/api/quizzes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,answer,reward,active})});
  renderQuizzes();
}
async function delQuiz(id){
  await api('/api/quizzes/'+id,{method:'DELETE'});
  renderQuizzes();
}

showTab('users');
</script>
</body>
</html>`);
});

// ====================== KEEP ALIVE ======================
app.get("/", (_req, res) => res.send("🚀 Bot is running"));
setInterval(() => {
  axios.get(`https://${BASE_HOST}`).catch(() => {});
}, 300000);

// ====================== START SERVER ======================
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
