// index.js — Telegram Bot (minimal) + WebApp (game-like UI) + Ads/Withdraw/Leaderboard
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
  if (!cols.includes("ref_by"))
    await pool.query("ALTER TABLE users ADD COLUMN ref_by BIGINT");
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

  // quizzes table kept (admin can still manage) but we won't use it in app by default
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
function nowLocal() {
  return new Date().toLocaleString();
}

// ====================== BOT (Webhook minimal) ======================
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`https://${BASE_HOST}/bot${TOKEN}`);

// Minimal bot commands: start & ref
bot.setMyCommands([
  { command: "start", description: "Buka Mini App" },
  { command: "ref", description: "Lihat referral link" },
]);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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
        try {
          await bot.sendMessage(
            ref_by,
            `🎉 Kamu dapat +50 poin dari referral baru: ${chatId}`
          );
        } catch (e) { /* ignore if can't message */ }
      }
    } else {
      await addUser(chatId);
    }
  } else {
    await addUser(chatId);
  }

  // Send simple message + inline web_app button to open Mini App
  const me = await bot.getMe();
  bot.sendMessage(chatId, `Halo! Buka Mini App untuk bermain:`, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🚀 Buka Mini App",
            web_app: { url: `https://${BASE_HOST}/app?uid=${chatId}` },
          },
        ],
      ],
    },
  });
});

bot.onText(/\/ref/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  const me = await bot.getMe();
  bot.sendMessage(
    chatId,
    `🔗 Referral link kamu:\nhttps://t.me/${me.username}?start=ref_${chatId}\n\nAjak teman dan dapatkan reward!`
  );
});

// ====================== WEB: IKLAN (watch & reward remain) ======================
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
<head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Nonton Iklan</title></head>
<body style="font-family:sans-serif;text-align:center;padding:18px;">
<h2>🎬 Tonton Iklan</h2>
<p id="status">⏳ Tunggu beberapa detik...</p>
<script src="${scriptUrl}"></script>
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
            .then(()=>{s.textContent="✅ ${reward} poin!"; setTimeout(()=>{location.href="https://t.me/${me}"},1400);});
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
  await updatePoints(user_id, pts, `+${pts} poin (watch) (${nowLocal()})`);
  res.send("Reward diberikan");
});

// ====================== WEBAPP (single-page) ======================
app.get("/app", async (req, res) => {
  const uid = req.query.uid;
  const user = await getUser(uid);
  if (!user) {
    return res
      .status(404)
      .send(
        "User tidak ditemukan. Pastikan kamu membuka App melalui bot Telegram."
      );
  }

  // single-file app: tab bar (Home, Quest, Leaderboard, Wallet)
  res.type("html").send(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Mini Game App</title>
<style>
:root{--bg:#071026;--card:rgba(255,255,255,0.04);--accent:#3b9af7;--muted:rgba(255,255,255,.6)}
html,body{height:100%;margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial;background:linear-gradient(180deg,#021026,#071026);color:#eaf2ff}
.container{max-width:460px;margin:10px auto;border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(2,6,23,.7);background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))}
.header{display:flex;align-items:center;justify-content:space-between;padding:14px}
.profile{display:flex;gap:12px;align-items:center}
.avatar{width:56px;height:56px;border-radius:12px;background:linear-gradient(135deg,#ffd1a9,#ff8a8a);display:flex;align-items:center;justify-content:center;font-size:28px}
.points{background:linear-gradient(90deg,#174bff,#00e0a8);padding:8px 12px;border-radius:999px;color:#fff;font-weight:700}
.main{padding:12px}
.card{background:var(--card);padding:12px;border-radius:12px;margin-bottom:10px}
.center-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px;border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))}
.btn{padding:10px 14px;border-radius:12px;border:none;background:linear-gradient(90deg,#4b8bff,#00d3a0);color:#fff;font-weight:700;cursor:pointer}
.row{display:flex;gap:8px}
.leaderboard{max-height:260px;overflow:auto}
.tabbar{display:flex;justify-content:space-around;padding:10px;background:linear-gradient(180deg,rgba(0,0,0,0.12),rgba(0,0,0,0.06));position:sticky;bottom:0}
.tab{flex:1;padding:10px 6px;text-align:center;color:var(--muted);cursor:pointer}
.tab.active{color:#fff}
.small{font-size:13px;color:var(--muted)}
.footer-links{display:flex;gap:8px;justify-content:center;padding:8px}
@media (max-width:480px){.container{margin:6px;border-radius:10px}}
</style>
</head>
<body>
<div class="container" id="app">
  <div class="header">
    <div class="profile">
      <div class="avatar" id="avatar">😺</div>
      <div>
        <div style="font-weight:800" id="userId">User: ${uid}</div>
        <div class="small" id="userMeta">Rank: — • Level: —</div>
      </div>
    </div>
    <div class="points" id="points">${user.points} ✨</div>
  </div>

  <div class="main" id="content">
    <!-- Home Tab by default -->
    <div id="homeTab">
      <div class="card center-card">
        <div style="font-size:13px;color:#9fb6ff">Your Mascot</div>
        <div style="width:140px;height:140px;border-radius:14px;background:linear-gradient(135deg,#fff1c9,#ffd6e6);display:flex;align-items:center;justify-content:center;font-size:64px">😺</div>
        <div class="row">
          <button class="btn" id="btnUpgrade">Upgrade</button>
          <button class="btn" id="btnShop">Shop</button>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:700">Quests</div>
          <div class="small">Complete to earn</div>
        </div>
        <div style="margin-top:10px">
          <div class="card" style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:700">🎬 Watch Ads</div>
              <div class="small">Tonton iklan untuk mendapat poin</div>
            </div>
            <div><button class="btn" onclick="startWatch()">Tonton</button></div>
          </div>
          <div class="card" style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:700">🔗 Invite</div>
              <div class="small">Ajak teman via referral</div>
            </div>
            <div><button class="btn" onclick="shareRef()">Share</button></div>
          </div>
          <div class="card" style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:700">🎁 Daily login</div>
              <div class="small">Klaim hadiah harian (sekali/hari)</div>
            </div>
            <div><button class="btn" onclick="claimDaily()">Claim</button></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Quest Tab -->
    <div id="questTab" style="display:none">
      <div class="card">
        <div style="font-weight:700">Tasks</div>
        <div class="small" style="margin-top:8px">Selesaikan tugas untuk mendapatkan poin</div>
      </div>
      <div id="questList"></div>
    </div>

    <!-- Leaderboard Tab -->
    <div id="leaderboardTab" style="display:none">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:700">Leaderboard</div>
          <div class="small">Top 10</div>
        </div>
        <div class="leaderboard" id="leaderboardList" style="margin-top:10px"></div>
      </div>
    </div>

    <!-- Wallet Tab -->
    <div id="walletTab" style="display:none">
      <div class="card">
        <div style="font-weight:700">Wallet</div>
        <div class="small">Saldo dan riwayat transaksi</div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><div class="small">Saldo</div><div style="font-weight:800" id="walletPoints">${user.points} ✨</div></div>
          <div><button class="btn" onclick="doWithdraw()">Withdraw</button></div>
        </div>
      </div>
      <div id="history" class="card small">Memuat riwayat...</div>
    </div>

  </div>

  <div class="tabbar">
    <div class="tab active" id="tabHome" onclick="switchTab('home')">Home</div>
    <div class="tab" id="tabQuest" onclick="switchTab('quest')">Quest</div>
    <div class="tab" id="tabLead" onclick="switchTab('leaderboard')">Leaderboard</div>
    <div class="tab" id="tabWallet" onclick="switchTab('wallet')">Wallet</div>
  </div>
</div>

<script>
const UID = "${uid}";

function switchTab(t){
  document.getElementById('homeTab').style.display = t==='home' ? '' : 'none';
  document.getElementById('questTab').style.display = t==='quest' ? '' : 'none';
  document.getElementById('leaderboardTab').style.display = t==='leaderboard' ? '' : 'none';
  document.getElementById('walletTab').style.display = t==='wallet' ? '' : 'none';
  ['tabHome','tabQuest','tabLead','tabWallet'].forEach(x=>document.getElementById(x).classList.remove('active'));
  if(t==='home') document.getElementById('tabHome').classList.add('active');
  if(t==='quest') document.getElementById('tabQuest').classList.add('active');
  if(t==='leaderboard') document.getElementById('tabLead').classList.add('active');
  if(t==='wallet') document.getElementById('tabWallet').classList.add('active');

  if(t==='leaderboard') loadLeaderboard();
  if(t==='quest') loadQuests();
  if(t==='wallet') loadHistory();
}

async function refreshPoints(){
  const r = await fetch('/api/user/'+UID).then(r=>r.json()).catch(()=>null);
  if(r && r.points!==undefined){
    document.getElementById('points').textContent = r.points + ' ✨';
    document.getElementById('walletPoints').textContent = r.points + ' ✨';
  }
}

async function loadLeaderboard(){
  const d = await fetch('/api/leaderboard').then(r=>r.json()).catch(()=>[]);
  const el = document.getElementById('leaderboardList');
  el.innerHTML = '';
  d.forEach((u,i)=>{
    const div = document.createElement('div'); div.className='card';
    div.innerHTML = '<div style="display:flex;gap:10px;align-items:center"><div style="width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700">'+(i+1)+'</div><div><div style="font-weight:700">'+u.user_id+'</div><div class="small">'+u.points+' pts</div></div></div>';
    el.appendChild(div);
  });
}

async function loadQuests(){
  const list = document.getElementById('questList');
  list.innerHTML = '';
  list.appendChild(createQuestNode('🎬 Watch Ads','Tonton iklan untuk mendapat poin', 'Tonton', startWatch));
  list.appendChild(createQuestNode('🔗 Invite','Ajak teman via referral', 'Share', shareRef));
  list.appendChild(createQuestNode('🎁 Daily login','Claim hadiah harian (1x/day)', 'Claim', claimDaily));
}

function createQuestNode(title,desc,btnTxt,onclick){
  const wrapper = document.createElement('div'); wrapper.className='card';
  wrapper.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><div><div style="font-weight:700">'+title+'</div><div class="small">'+desc+'</div></div><div></div></div>';
  const btn = document.createElement('button'); btn.className='btn'; btn.textContent = btnTxt; btn.onclick = onclick;
  wrapper.querySelector('div > div:last-child').appendChild(btn);
  return wrapper;
}

async function loadHistory(){
  const r = await fetch('/api/user/'+UID).then(r=>r.json()).catch(()=>null);
  const h = (r && r.history) ? r.history : [];
  const el = document.getElementById('history');
  el.innerHTML = h.length ? ('<div style="display:flex;flex-direction:column;gap:6px">'+h.slice().reverse().map(x=>'<div>'+x+'</div>').join('')+'</div>') : '<div class="small">Belum ada riwayat</div>';
}

function startWatch(){
  // open /watch in new tab (redirect back to telegram after done)
  window.open('/watch?user_id='+UID, '_blank');
}

function shareRef(){
  const refLink = 'https://t.me/' + (window.location.hostname) + '?start=ref_' + UID;
  if(navigator.share){
    navigator.share({title:'Ayo main', text:'Main dan dapat poin', url:refLink});
  } else {
    prompt('Copy referral link', refLink);
  }
}

async function claimDaily(){
  // server-side simple daily grant (guard on server may be minimal — DB should enforce real cooldowns if desired)
  const r = await fetch('/api/trigger/'+UID+'?cmd=daily').then(r=>r.json()).catch(()=>null);
  if(r && r.success) { alert('Daily diklaim'); refreshPoints(); } else alert('Gagal klaim atau sudah klaim hari ini');
}

async function doWithdraw(){
  const dana = prompt('Masukkan nomor DANA untuk withdraw (min 10000 poin)');
  if(!dana) return;
  const body = { user_id: UID, dana_number: dana };
  const r = await fetch('/api/withdraw_direct', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if(r.ok){ alert('Withdraw request terkirim'); refreshPoints(); } else { alert('Gagal kirim withdraw'); }
}

// initial load
refreshPoints();
loadLeaderboard();

</script>
</body>
</html>`);
});

// ====================== APIs for WebApp ======================

// fetch user -> include history to show in wallet
app.get('/api/user/:id', async (req, res) => {
  const id = req.params.id;
  const u = await getUser(id);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({
    user_id: u.user_id,
    points: u.points,
    history: u.history || [],
    ref_by: u.ref_by || null,
    created_at: u.created_at || null,
  });
});

// leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  const r = await pool.query("SELECT user_id, points FROM users ORDER BY points DESC LIMIT 10");
  res.json(r.rows);
});

// server-side trigger for small actions (daily)
app.get('/api/trigger/:uid', async (req, res) => {
  const uid = req.params.uid;
  const cmd = req.query.cmd;
  if (!['daily'].includes(cmd)) return res.status(400).json({ error: 'bad cmd' });
  try {
    if (cmd === 'daily') {
      // implement simple once-per-day check via history timestamp (lightweight)
      const u = await getUser(uid);
      const today = (new Date()).toDateString();
      const hist = (u.history || []).slice(-10).join('||');
      if (hist.includes('daily:'+today)) {
        return res.status(400).json({ error: 'already claimed' });
      }
      const reward = 100;
      await updatePoints(uid, reward, `+${reward} daily (webapp) (${nowLocal()})`);
      // append a marker so next claim detects
      await pool.query("UPDATE users SET history = array_append(history, $1) WHERE user_id=$2", [`daily:${today}`, uid]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// create withdraw request from WebApp
app.post('/api/withdraw_direct', express.json(), async (req, res) => {
  const { user_id, dana_number } = req.body || {};
  if (!user_id || !dana_number) return res.status(400).json({ error: 'bad params' });
  const u = await getUser(user_id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  const amount = u.points || 0;
  await pool.query("INSERT INTO withdraw_requests (user_id, amount, dana_number, status) VALUES ($1,$2,$3,$4)", [user_id, amount, dana_number, 'pending']);
  await pool.query("UPDATE users SET points=0 WHERE user_id=$1", [user_id]);
  if (ADMIN_ID) {
    try { bot.sendMessage(ADMIN_ID, `📥 Withdraw WebApp\nUser: ${user_id}\nJumlah: ${amount}\nDANA: ${dana_number}`); } catch(e){}
  }
  res.json({ success: true });
});

// bot info (optional)
app.get('/botinfo', async (_req, res) => {
  const me = await bot.getMe();
  res.json(me);
});

// ====================== ADMIN API (same as before) ======================
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

  // notify user
  const r = await pool.query("SELECT user_id, amount, dana_number FROM withdraw_requests WHERE id=$1", [id]);
  if (r.rows.length) {
    const wd = r.rows[0];
    if (st === "approved") {
      try {
        bot.sendMessage(
          wd.user_id,
          `✅ Withdraw kamu sebesar ${wd.amount} poin ke ${wd.dana_number} sudah *disetujui*.`
        );
      } catch (e) {}
    } else if (st === "rejected") {
      try {
        bot.sendMessage(
          wd.user_id,
          `❌ Withdraw kamu sebesar ${wd.amount} poin ke ${wd.dana_number} *ditolak*.`
        );
      } catch (e) {}
    }
  }

  res.json({ success: true });
});

// Ads (public GET; admin-protected POST/PUT/DELETE)
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