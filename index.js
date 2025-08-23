// ====================== DEPENDENCIES ======================
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { Pool } = require("pg");

// ====================== CONFIG ======================
const TOKEN = process.env.TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || "mysecretkey";
const WEBAPP_URL = process.env.WEBAPP_URL; // ex: https://domain.com/app
const PORT = process.env.PORT || 3000;

if (!TOKEN || !DATABASE_URL || !WEBAPP_URL) {
  console.error("❌ ENV missing. Please set TOKEN, DATABASE_URL, WEBAPP_URL");
  process.exit(1);
}

// ====================== APP & DB ======================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({ connectionString: DATABASE_URL });

// ====================== DB INIT (AUTO-REPAIR) ======================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      points BIGINT DEFAULT 0,
      hashrate INT DEFAULT 1,
      ref_by BIGINT,
      history TEXT[],
      last_daily TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      name TEXT,
      dana_number TEXT,
      amount BIGINT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      reward INT NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'active', -- active|paused
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ad_views (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      ad_id INT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ad_views_user_day ON ad_views (user_id, created_at)`);
}
initDB().catch(console.error);

// ====================== HELPERS ======================
function nowLocal() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

async function getUser(uid) {
  const q = await pool.query("SELECT * FROM users WHERE user_id=$1", [uid]);
  if (q.rowCount === 0) {
    await pool.query(
      "INSERT INTO users(user_id, points, hashrate, history) VALUES ($1, 0, 1, $2)",
      [uid, []]
    );
    return (await pool.query("SELECT * FROM users WHERE user_id=$1", [uid])).rows[0];
  }
  return q.rows[0];
}

async function updatePoints(uid, delta, note) {
  const u = await getUser(uid);
  const newPts = Number(u.points || 0) + Number(delta || 0);
  const history = [note, ...(u.history || [])].slice(0, 50);
  await pool.query("UPDATE users SET points=$1, history=$2 WHERE user_id=$3", [newPts, history, uid]);
  return newPts;
}

async function getActiveAd() {
  const q = await pool.query("SELECT * FROM ads WHERE status='active' ORDER BY RANDOM() LIMIT 1");
  return q.rows[0] || null;
}

async function countViewsToday(uid) {
  const q = await pool.query(
    "SELECT COUNT(*) FROM ad_views WHERE user_id=$1 AND DATE(created_at)=CURRENT_DATE",
    [uid]
  );
  return parseInt(q.rows[0].count || "0", 10);
}

// ====================== TELEGRAM BOT (POLos) ======================
const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await getUser(chatId);
  bot.sendMessage(
    chatId,
    "👋 Selamat datang di Hamster Mining!\n\nSemua fitur ada di Mini App. Klik tombol di bawah untuk membuka ⛏️",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Buka Mini App", web_app: { url: `${WEBAPP_URL}?uid=${chatId}` } }]
        ]
      }
    }
  );
});

// ====================== WEB MINI APP (Single Page Mining) ======================
app.get("/app", async (req, res) => {
  const uid = String(req.query.uid || "").trim();
  if (!uid) return res.status(400).send("Missing uid");

  const user = await getUser(uid);
  const me = await bot.getMe();

  res.type("html").send(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Hamster Mining</title>
<style>
  :root{--p:#6c5ce7;--txt:#222;--bg:#0b0b12;}
  html,body{margin:0;padding:0;background:var(--bg);color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,sans-serif;overflow:hidden}
  #bgCanvas{position:fixed;inset:0;z-index:0}
  .container{position:relative;z-index:1;display:flex;flex-direction:column;min-height:100vh}
  .header{padding:16px;background:transparent;display:flex;align-items:center;justify-content:space-between}
  .profile{display:flex;align-items:center;}
  .avatar{width:48px;height:48px;border-radius:50%;background:#fff1;display:flex;align-items:center;justify-content:center;font-size:26px;color:#ffd86b;margin-right:10px;backdrop-filter:blur(6px);border:1px solid #ffffff22}
  .pointsTop{font-weight:800;font-size:20px;background:#ffffff17;border:1px solid #ffffff2a;padding:6px 10px;border-radius:12px;backdrop-filter:blur(8px)}
  .main{flex:1;padding:12px 12px 90px 12px;overflow:auto}
  .card{background:#ffffff10;border:1px solid #ffffff22;border-radius:16px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);margin-bottom:12px;backdrop-filter:blur(10px)}
  .center{text-align:center}
  .btn{background:linear-gradient(135deg,#7d5fff,#74b9ff);color:#fff;border:none;border-radius:12px;padding:12px 16px;cursor:pointer;font-weight:700}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .sub{color:#d3d3d3;font-size:13px}
  input{width:100%;padding:12px;border:1px solid #ffffff33;background:#ffffff12;color:#fff;border-radius:12px;margin:6px 0;outline:none}
  input::placeholder{color:#bbb}
  .ham{width:170px;height:170px;border-radius:18px;background:linear-gradient(135deg,#fff1c9,#ffd6e6);display:flex;align-items:center;justify-content:center;font-size:72px;margin:10px auto;cursor:pointer;user-select:none;box-shadow:0 10px 30px rgba(0,0,0,.35);transform:translateZ(0)}
  .ham:active{transform:scale(.98)}
  .badge{display:inline-block;background:#ffd700;color:#000;padding:6px 10px;border-radius:999px;font-weight:800}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .grow{flex:1}
  .footer{position:fixed;left:0;right:0;bottom:0;padding:10px;background:transparent;border-top:1px solid #ffffff1c;display:flex;justify-content:center;backdrop-filter:blur(6px)}
  .tab{flex:0 0 auto;padding:10px 14px;border-radius:12px;background:#ffffff18;color:#fff;font-weight:700}
  .pill{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:#ffffff18;border:1px solid #ffffff2a}
</style>
</head>
<body>
<canvas id="bgCanvas"></canvas>

<div class="container">
  <div class="header">
    <div class="profile">
      <div class="avatar">🐹</div>
      <div>
        <div style="font-weight:800">User: ${uid}</div>
        <div class="sub" id="hashText">Hashrate: ${user.hashrate || 1}x</div>
      </div>
    </div>
    <div class="pointsTop" id="ptsTop">${user.points} ✨</div>
  </div>

  <div class="main" id="scroll">
    <!-- HOME / MINING ONLY PAGE -->
    <div id="home">
      <div class="card center">
        <div id="ptsBig" class="badge" style="margin-bottom:8px">${user.points} ✨</div>
        <div id="ham" class="ham" title="Klik untuk mining">🐹</div>
        <div class="sub">Klik hamster untuk menambang</div>
        <div id="hashInfo" class="sub" style="margin:8px 0">Hashrate: ${user.hashrate || 1}x</div>
        <button id="btnUp" class="btn">Upgrade Hashrate (nonton iklan)</button>
      </div>

      <div class="row">
        <div class="card grow">
          <div class="pill">🎬 <b>Watch Ads</b></div>
          <div class="sub">Maksimal 20 iklan per hari</div>
          <div style="margin-top:8px"><button class="btn" onclick="watchAds()">Tonton Iklan</button></div>
        </div>

        <div class="card grow">
          <div class="pill">📅 <b>Daily Login</b></div>
          <div class="sub">1x setiap 24 jam</div>
          <div style="margin-top:8px"><button id="btnDaily" class="btn">Claim Harian (+500)</button></div>
        </div>
      </div>

      <div class="card">
        <div class="pill">👥 <b>Invite Teman</b></div>
        <div class="sub" style="margin-top:6px">Bagikan link berikut:</div>
        <input id="refLink" readonly value="https://t.me/${me.username}?start=ref_${uid}" />
      </div>

      <div class="card">
        <div class="pill">💵 <b>Withdraw</b></div>
        <div class="sub" style="margin-top:6px">Minimal 10.000 poin. Poin akan dipotong saat pengajuan.</div>
        <input id="wdName" placeholder="Nama lengkap" />
        <input id="wdDana" placeholder="No. DANA" />
        <input id="wdAmt" placeholder="Minimal 10000 poin" />
        <button id="btnWd" class="btn">Ajukan Withdraw</button>
      </div>
    </div>
  </div>

  <div class="footer">
    <div class="tab">⛏️ Mining</div>
  </div>
</div>

<script>
// ============ PARTICLE BACKGROUND ============
const c = document.getElementById('bgCanvas');
const ctx = c.getContext('2d',{alpha:true});
let W,H,particles=[];
function resize(){W=window.innerWidth;H=window.innerHeight;c.width=W;c.height=H}
function rand(min,max){return Math.random()*(max-min)+min}
function initParticles(){
  particles = Array.from({length: Math.min(120, Math.floor(W*H/12000))}, ()=>({
    x: rand(0,W), y: rand(0,H),
    vx: rand(-.6,.6), vy: rand(-.6,.6),
    r: rand(1.2,2.6),
    hue: rand(0,360)
  }));
}
function step(){
  ctx.clearRect(0,0,W,H);
  for(const p of particles){
    p.x += p.vx; p.y += p.vy; p.hue += .2;
    if(p.x<0||p.x>W) p.vx*=-1;
    if(p.y<0||p.y>H) p.vy*=-1;
    ctx.beginPath();
    ctx.fillStyle = \`hsla(\${p.hue},85%,65%,.85)\`;
    ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
    ctx.fill();
  }
  requestAnimationFrame(step);
}
window.addEventListener('resize', ()=>{resize(); initParticles()});
resize(); initParticles(); step();

// ============ UI / API ============
const UID = "${uid}";
function smoothCount(el, from, to){
  const diff = to - from;
  if (diff === 0) return;
  const steps = 24;
  const inc = diff / steps;
  let cur = from, i = 0;
  const timer = setInterval(()=>{
    i++; cur += inc;
    if(i>=steps){cur=to; clearInterval(timer);}
    el.textContent = Math.round(cur) + " ✨";
  }, 45);
}

async function refreshUser(){
  const r = await fetch('/api/user/'+UID).then(r=>r.json()).catch(()=>null);
  if(!r) return;
  const top = document.getElementById('ptsTop');
  const big = document.getElementById('ptsBig');
  const prev = parseInt((top.textContent||'0'));
  smoothCount(top, prev, r.points||0);
  big.textContent = (r.points||0) + " ✨";
  document.getElementById('hashInfo').textContent = "Hashrate: " + (r.hashrate||1) + "x";
  document.getElementById('hashText').textContent = "Hashrate: " + (r.hashrate||1) + "x";
}

document.getElementById('ham').onclick = async ()=>{
  const r = await fetch('/api/mining/'+UID, {method:'POST'}).then(r=>r.json()).catch(()=>null);
  if(r && r.success){
    const el = document.getElementById('ptsBig');
    el.animate([{transform:'scale(1)'},{transform:'scale(1.1)'},{transform:'scale(1)'}],{duration:220});
    await refreshUser();
  } else {
    alert(r?.error||'Gagal mining');
  }
};

document.getElementById('btnUp').onclick = async ()=>{
  window.location.href = "/watch?user_id="+UID+"&mode=upgrade";
};

document.getElementById('btnDaily').onclick = async ()=>{
  const r = await fetch('/api/daily/'+UID, {method:'POST'}).then(r=>r.json()).catch(()=>null);
  if(r && r.success){ 
    alert("Daily claimed: +"+r.reward); 
    refreshUser(); 
  } else alert(r?.error || "Gagal claim");
};

document.getElementById('btnWd').onclick = async ()=>{
  const name = document.getElementById('wdName').value.trim();
  const dana = document.getElementById('wdDana').value.trim();
  const amt = parseInt(document.getElementById('wdAmt').value.trim() || '0', 10);
  if(!name || !dana || !amt){ alert('Lengkapi form'); return; }
  const r = await fetch('/api/withdraw_direct', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ user_id: UID, name, dana_number: dana, amount: amt })
  }).then(r=>r.json()).catch(()=>null);
  if(r && r.success){ alert('Withdraw diajukan. Menunggu approve admin.'); refreshUser(); }
  else alert(r?.error||'Gagal ajukan');
};

function watchAds(){ window.location.href = "/watch?user_id="+UID; }

// Placeholder nominal hilang saat ketik, muncul bila kosong (default browser sudah begitu untuk placeholder).
// Tambahan: blok input hanya angka
document.getElementById('wdAmt').addEventListener('input', (e)=>{
  e.target.value = e.target.value.replace(/[^0-9]/g,'');
});
</script>
</body></html>`);
});

// ====================== WATCH PAGE (IKLAN) ======================
// Pakai ads aktif (iframe) ATAU fallback Gigapub (window.showGiga)
app.get("/watch", async (req, res) => {
  const user_id = String(req.query.user_id || "").trim();
  const mode = String(req.query.mode || "watch"); // "watch" biasa atau "upgrade"
  if (!user_id) return res.status(400).send("Missing user_id");

  await getUser(user_id);
  const todayCount = await countViewsToday(user_id);
  if (todayCount >= 20 && mode !== "upgrade") {
    return res.type("html").send("<h3 style='font-family:system-ui'>❌ Batas 20 iklan per hari sudah tercapai</h3>");
  }

  const ad = await getActiveAd(); // dari tabel ads
  const reward = ad ? ad.reward : 10;

  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Watch Ads</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#0b0b12;margin:0;padding:16px;color:#fff}
  .card{background:#ffffff10;border:1px solid #ffffff22;border-radius:16px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.25);margin:10px 0;backdrop-filter:blur(10px)}
  .btn{padding:12px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,#7d5fff,#74b9ff);color:#fff;cursor:pointer;font-weight:700}
  .sub{color:#d3d3d3;font-size:13px}
  iframe{border:none;width:100%;height:320px;border-radius:12px;background:#000}
</style>
${ad ? "" : `<script src="https://ad.gigapub.tech/script?id=1669"></script>`}
</head>
<body>
  <h3>🎬 Tonton Iklan</h3>
  <div class="card">
    <div class="sub">${ad ? "Iklan: <b>"+ad.title+"</b>" : "Iklan Gigapub"}</div>
    <div id="adbox">
      ${ad ? `<iframe src="${ad.url}" allow="autoplay; encrypted-media"></iframe>` 
            : `<div id="gigabox" style="height:320px;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;border-radius:12px">Menunggu iklan...</div>`}
    </div>
    <div class="sub" style="margin-top:8px">Hadiah: ${reward} poin ${mode==='upgrade' ? "(upgrade hashrate)" : ""}</div>
    <div style="margin-top:10px">
      <button id="btn" class="btn" disabled>⏳ Tunggu iklan selesai...</button>
    </div>
  </div>
<script>
const user_id = ${JSON.stringify(user_id)};
const mode = ${JSON.stringify(mode)};
const reward = ${reward};

function enableBtn(){
  const b = document.getElementById('btn');
  b.disabled=false; 
  b.textContent = mode==='upgrade' ? '✅ Upgrade Hashrate' : '✅ Klaim '+reward+' Poin';
  b.onclick = async ()=>{
    if(mode==='upgrade'){
      const r = await fetch('/api/upgrade/'+user_id,{method:'POST'}).then(r=>r.json()).catch(()=>null);
      if(r && r.success){ alert('Hashrate +1 ditambahkan'); window.history.back(); }
      else alert(r?.error||'Gagal upgrade');
    } else {
      const r = await fetch('/reward?user_id='+encodeURIComponent(user_id)+'&reward='+encodeURIComponent(reward)).then(r=>r.text()).catch(()=>null);
      alert(r||'Selesai');
      window.history.back();
    }
  };
}

${ad 
  ? `// Iklan via iframe -> anggap selesai setelah 15 detik
     setTimeout(enableBtn,15000);`
  : `// Iklan via Gigapub -> tombol aktif saat showGiga resolve
     window.showGiga()
       .then(()=>enableBtn())
       .catch(e=>{document.getElementById('gigabox').textContent='❌ Gagal load iklan: '+e});`}
</script>
</body></html>`);
});

// ====================== PUBLIC API (MINI APP) ======================

// Ambil data user
app.get("/api/user/:id", async (req, res) => {
  const user = await getUser(req.params.id);
  res.json(user);
});

// Mining klik hamster
app.post("/api/mining/:id", async (req, res) => {
  const uid = req.params.id;
  const u = await getUser(uid);
  const reward = 100 * (u.hashrate || 1);
  await updatePoints(uid, reward, `Mining +${reward} (${nowLocal()})`);
  res.json({ success: true, reward });
});

// Upgrade via iklan (dipanggil dari /watch?mode=upgrade)
app.post("/api/upgrade/:id", async (req, res) => {
  const uid = req.params.id;
  const u = await getUser(uid);
  const newH = (u.hashrate || 1) + 1;
  await pool.query("UPDATE users SET hashrate=$1 WHERE user_id=$2", [newH, uid]);
  res.json({ success: true, newHashrate: newH });
});

// Daily login 1x/24 jam
app.post("/api/daily/:id", async (req, res) => {
  const uid = req.params.id;
  const u = await getUser(uid);
  if (u.last_daily && new Date() - new Date(u.last_daily) < 24 * 60 * 60 * 1000) {
    return res.json({ error: "Sudah claim hari ini" });
  }
  await updatePoints(uid, 500, `Daily +500 (${nowLocal()})`);
  await pool.query("UPDATE users SET last_daily=$1 WHERE user_id=$2", [new Date(), uid]);
  res.json({ success: true, reward: 500 });
});

// Reward iklan (max 20/day)
app.get("/reward", async (req, res) => {
  const user_id = String(req.query.user_id || "").trim();
  const reward = parseInt(req.query.reward || "10", 10);
  if (!user_id) return res.send("Missing user_id");

  const today = await countViewsToday(user_id);
  if (today >= 20) return res.send("❌ Batas 20 iklan per hari sudah tercapai");

  await updatePoints(user_id, reward, `+${reward} poin (watch) (${nowLocal()})`);
  await pool.query("INSERT INTO ad_views(user_id) VALUES($1)", [user_id]);
  res.send("✅ Reward diberikan");
});

// Withdraw
app.post("/api/withdraw_direct", async (req, res) => {
  const { user_id, name, dana_number, amount } = req.body || {};
  if (!user_id || !name || !dana_number || !amount) {
    return res.json({ error: "Data tidak lengkap" });
  }
  const amt = parseInt(amount, 10);
  const u = await getUser(user_id);
  if (amt < 10000) return res.json({ error: "Minimal withdraw 10000 poin" });
  if (u.points < amt) return res.json({ error: "Saldo tidak cukup" });
  await updatePoints(user_id, -amt, `Withdraw request -${amt} (${nowLocal()})`);
  await pool.query(
    "INSERT INTO withdraw_requests(user_id,name,dana_number,amount,status) VALUES($1,$2,$3,$4,'pending')",
    [user_id, name, dana_number, amt]
  );
  res.json({ success: true });
});

// Leaderboard endpoint dihapus dari UI (opsional masih bisa dipakai)
// app.get("/api/leaderboard", ... ) // tidak dipakai karena single page mining

// ====================== ADMIN API & PANEL ======================

// List users (admin)
app.get("/api/users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const q = await pool.query("SELECT * FROM users ORDER BY points DESC LIMIT 200");
  res.json(q.rows);
});

// List withdraws (admin)
app.get("/api/withdraws", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const q = await pool.query("SELECT * FROM withdraw_requests ORDER BY id DESC LIMIT 200");
  res.json(q.rows);
});

// Update withdraw status (approve/reject)
app.post("/api/withdraws/:id", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const id = parseInt(req.params.id, 10);
  const status = (req.body && req.body.status) || "";
  if (!["approved", "rejected", "pending"].includes(status)) return res.json({ error: "status invalid" });
  await pool.query("UPDATE withdraw_requests SET status=$1 WHERE id=$2", [status, id]);
  res.json({ success: true });
});

// ADS CRUD (admin)
app.get("/api/ads", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const q = await pool.query("SELECT * FROM ads ORDER BY id DESC");
  res.json(q.rows);
});
app.post("/api/ads", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const { title, url, reward = 10, status = "active" } = req.body || {};
  if (!title || !url) return res.json({ error: "title & url required" });
  await pool.query("INSERT INTO ads(title,url,reward,status) VALUES($1,$2,$3,$4)", [title, url, reward, status]);
  res.json({ success: true });
});
app.put("/api/ads/:id", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const id = parseInt(req.params.id, 10);
  const { title, url, reward, status } = req.body || {};
  await pool.query(
    "UPDATE ads SET title=$1,url=$2,reward=$3,status=$4 WHERE id=$5",
    [title, url, reward, status, id]
  );
  res.json({ success: true });
});
app.delete("/api/ads/:id", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  const id = parseInt(req.params.id, 10);
  await pool.query("DELETE FROM ads WHERE id=$1", [id]);
  res.json({ success: true });
});

// ADMIN PANEL (HTML) — Mining Monitor
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
  <button id='btn-mining' onclick="showTab('mining')">⛏️ Mining Monitor</button>
</nav>

<div id='tab-users' class='wrap'></div>
<div id='tab-ads' class='wrap' style='display:none'></div>
<div id='tab-withdraws' class='wrap' style='display:none'></div>
<div id='tab-mining' class='wrap' style='display:none'></div>

<script>
function getKey(){return new URLSearchParams(location.search).get('key')||''}
function api(url,opt){return fetch(url+(url.includes('?')?'&':'?')+'key='+encodeURIComponent(getKey()),opt)}
function setActive(id){
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));
  const btn=document.getElementById('btn-'+id); if(btn) btn.classList.add('active');
}
function showTab(id){
  ['users','ads','withdraws','mining'].forEach(t=>document.getElementById('tab-'+t).style.display='none');
  setActive(id);
  document.getElementById('tab-'+id).style.display='block';
  if(id==='users') renderUsers();
  if(id==='ads') renderAds();
  if(id==='withdraws') renderWithdraws();
  if(id==='mining') renderMining();
}

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
      <td>\${x.hashrate||1}x</td>
      <td>\${x.created_at||'-'}</td>
    </tr>\`).join('');
    if(!rows) rows='<tr><td colspan=4 class=muted>Kosong</td></tr>';
    box.innerHTML='<h3>👤 Users</h3><table><thead><tr><th>User</th><th>Poin</th><th>Hashrate</th><th>Created</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    box.innerHTML='<div class="card" style="color:red">⚠️ Gagal load users: '+e.message+'</div>';
  }
}

// ===== ADS
async function renderAds(){
  const box=document.getElementById('tab-ads');
  box.innerHTML='<div class="card">📊 Memuat ads...</div>';
  try{
    const r=await api('/api/ads'); if(!r.ok) throw new Error('HTTP '+r.status);
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
          '<input id="ad-url" placeholder="Script/Video URL" style="min-width:260px" />'+
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
  const r=await api('/api/ads'); const ads=await r.json();
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

// ===== MINING MONITOR
async function renderMining(){
  const box=document.getElementById('tab-mining');
  box.innerHTML='<div class="card">📊 Memuat mining data...</div>';
  try{
    const r=await api('/api/users'); if(!r.ok) throw new Error('HTTP '+r.status);
    const u=await r.json();
    let rows=(u||[]).map(x=>\`<tr>
      <td>\${x.user_id}</td>
      <td>\${x.points}</td>
      <td>\${x.hashrate||1}x</td>
      <td>\${(x.history && x.history[0]) || '-'}</td>
    </tr>\`).join('');
    if(!rows) rows='<tr><td colspan=4 class=muted>Kosong</td></tr>';
    box.innerHTML='<h3>⛏️ Mining Monitor</h3><table><thead><tr><th>User</th><th>Poin</th><th>Hashrate</th><th>Last Activity</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){
    box.innerHTML='<div class="card" style="color:red">⚠️ Gagal load mining</div>';
  }
}

showTab('users');
</script>
</body>
</html>`);
});

// ====================== SERVER START ======================
app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});