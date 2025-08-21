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
const ADMIN_ID = process.env.ADMIN_ID; // optional (notif withdraw)

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
  ssl: { rejectUnauthorized: false }
});

// Buat tabel + auto-repair kolom status
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
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Auto-repair kolom status
  try {
    await pool.query("SELECT status FROM ads LIMIT 1");
  } catch (e) {
    if (e.code === "42703") {
      await pool.query("ALTER TABLE ads ADD COLUMN status TEXT DEFAULT 'active'");
      console.log("✅ Kolom 'status' ditambahkan otomatis");
    }
  }
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

// ====================== BOT (Webhook) ======================
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`https://${BASE_HOST}/bot${TOKEN}`);

// ====================== SET COMMANDS ======================
bot.setMyCommands([
  { command: "start", description: "Mulai bot" },
  { command: "daily", description: "Klaim bonus harian" },
  { command: "ref", description: "Lihat dan bagikan referral link" },
  { command: "leaderboard", description: "Cek top pengguna" },
  { command: "spin", description: "Lucky Spin harian" },
  { command: "withdraw", description: "Tarik saldo" }
]);
// Load commands
require("./commands/ref")(bot, pool);
require("./commands/daily")(bot, pool);
require("./commands/leaderboard")(bot, pool);
require("./commands/spin")(bot, pool);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const waitingWithdraw = new Map();

// ====================== TELEGRAM BOT ======================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await addUser(chatId);
  bot.sendMessage(chatId, "👋 Selamat datang!\nPilih menu:", {
    reply_markup: {
      keyboard: [
        ["💰 Cek Poin", "🎬 Nonton Iklan"],
        ["💵 Withdraw", "📜 Riwayat"]
      ],
      resize_keyboard: true
    }
  });
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (waitingWithdraw.get(chatId)) {
    const user = await getUser(chatId);
    const danaNumber = text;

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

  const user = await getUser(chatId);
  if (!user) return;

  if (text === "💰 Cek Poin") return bot.sendMessage(chatId, `💎 Poin kamu: ${user.points}`);
  if (text === "🎬 Nonton Iklan") return bot.sendMessage(chatId, `🎥 Klik:\nhttps://${BASE_HOST}/watch?user_id=${chatId}`);
  if (text === "💵 Withdraw") {
    if (user.points < 10000) return bot.sendMessage(chatId, "⚠️ Minimal 10.000 poin untuk withdraw");
    bot.sendMessage(chatId, "💳 Masukkan nomor DANA kamu:");
    waitingWithdraw.set(chatId, true);
    return;
  }
  if (text === "📜 Riwayat") {
    if (!user.history?.length) return bot.sendMessage(chatId, "📭 Belum ada riwayat");
    bot.sendMessage(chatId, "📜 Riwayat:\n" + user.history.join("\n"));
    return;
  }
});

// ====================== WEB: IKLAN ======================
app.get("/watch", async (req, res) => {
  const { user_id } = req.query;
  const user = await getUser(user_id);
  if (!user) return res.send("User tidak ditemukan");

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
      const i=setInterval(()=>{c--;if(c>0){s.textContent="⏳ Tunggu "+c+" detik...";}
      else{clearInterval(i);fetch("/reward?user_id=${user_id}&reward=${reward}").then(()=>{s.textContent="✅ ${reward} poin!";setTimeout(()=>{location.href="https://t.me/Addsstargaze_bot"},1500);});}},1000);
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
  await updatePoints(user_id, pts, `+${pts} poin (${new Date().toLocaleString()})`);
  res.send("Reward diberikan");
});

// ====================== ADMIN PANEL ======================
app.get("/admin", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("❌ Unauthorized");
  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Admin Panel</title>
<style>body{font-family:sans-serif;margin:0;padding:0}.tabbar{position:fixed;bottom:0;left:0;right:0;display:flex;border-top:1px solid #ccc;background:#f9f9f9}.tab{flex:1;text-align:center;padding:12px;cursor:pointer}.tab:hover{background:#eee}.content{padding:20px;margin-bottom:70px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#fafafa;text-align:left}.muted{color:#666;font-size:12px}</style>
</head><body>
<div class="content" id="content">📊 Memuat...</div>
<div class="tabbar"><div class="tab" onclick="loadTab('users')">👤 Users</div><div class="tab" onclick="loadTab('ads')">🎬 Ads</div><div class="tab" onclick="loadTab('finance')">💰 Finance</div><div class="tab" onclick="loadTab('settings')">⚙️ Settings</div></div>
<script>
function getAdminKey(){return new URLSearchParams(location.search).get('key')||''}
function loadTab(t){if(t==='users')renderUsers();if(t==='ads')renderAds();if(t==='finance')renderFinance();if(t==='settings')renderSettings();}
async function renderUsers(){const r=await fetch('/api/users?key='+encodeURIComponent(getAdminKey()));const u=await r.json().catch(()=>[]);let rows=u.map(x=>'<tr><td>'+x.user_id+'</td><td>'+x.points+'</td><td>'+(x.history||[]).length+'</td></tr>').join('');if(!rows)rows='<tr><td colspan=3 class=muted>Kosong</td></tr>';document.getElementById('content').innerHTML='<h3>👤 Users</h3><p><a href=\"/export?key='+encodeURIComponent(getAdminKey())+'\">⬇️ Export CSV</a></p><table><thead><tr><th>User ID</th><th>Points</th><th>Riwayat</th></tr></thead><tbody>'+rows+'</tbody></table>'}
async function renderAds(){document.getElementById('content').innerHTML='<h3>🎬 Ads</h3><form id=ad-form><input type=hidden id=ad-id><input type=text id=ad-title placeholder=\"Judul\" required><input type=url id=ad-url placeholder=\"URL script\" required><input type=number id=ad-reward placeholder=\"Reward\" required><select id=ad-status><option value=active>Active</option><option value=inactive>Inactive</option></select><button type=submit>Simpan</button></form><table><thead><tr><th>ID</th><th>Judul</th><th>URL</th><th>Reward</th><th>Status</th><th>Aksi</th></tr></thead><tbody id=ads-table-body><tr><td colspan=6>Memuat...</td></tr></tbody></table>';document.getElementById('ad-form').addEventListener('submit',onSubmitAdForm);loadAds();}
async function loadAds(){const r=await fetch('/api/ads');const ads=await r.json().catch(()=>[]);const tb=document.getElementById('ads-table-body');tb.innerHTML='';ads.forEach(a=>{tb.innerHTML+='<tr><td>'+a.id+'</td><td>'+a.title+'</td><td><a href=\"'+a.url+'\" target=_blank>'+a.url+'</a></td><td>'+a.reward+'</td><td>'+a.status+'</td><td><button onclick=\"editAd('+a.id+',\\''+a.title+'\\',\\''+a.url+'\\','+a.reward+',\\''+a.status+'\\')\">✏️</button><button onclick=\"deleteAd('+a.id+')\">🗑️</button></td></tr>'});}
function editAd(id,t,u,r,s){document.getElementById('ad-id').value=id;document.getElementById('ad-title').value=t;document.getElementById('ad-url').value=u;document.getElementById('ad-reward').value=r;document.getElementById('ad-status').value=s}
async function deleteAd(id){await fetch('/api/ads/'+id,{method:'DELETE'});loadAds()}
async function onSubmitAdForm(e){e.preventDefault();const id=document.getElementById('ad-id').value.trim();const title=document.getElementById('ad-title').value.trim();const url=document.getElementById('ad-url').value.trim();const reward=+document.getElementById('ad-reward').value.trim();const status=document.getElementById('ad-status').value;const method=id?'PUT':'POST';const endpoint=id?('/api/ads/'+id):'/api/ads';await fetch(endpoint,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify({title,url,reward,status})});loadAds()}
async function renderFinance(){const r=await fetch('/api/withdraws?key='+encodeURIComponent(getAdminKey()));const w=await r.json().catch(()=>[]);let rows=w.map(x=>'<tr><td>'+x.id+'</td><td>'+x.user_id+'</td><td>'+x.amount+'</td><td>'+x.dana_number+'</td><td>'+x.status+'</td></tr>').join('');if(!rows)rows='<tr><td colspan=5>Kosong</td></tr>';document.getElementById('content').innerHTML='<h3>💰 Withdraws</h3><table><thead><tr><th>ID</th><th>User</th><th>Amount</th><th>DANA</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table>'}
async function renderSettings(){document.getElementById('content').innerHTML='<h3>⚙️ Settings</h3><p>Belum ada</p>'}
window.onload=()=>loadTab('ads');
</script></body></html>`);
});

// ====================== ADMIN DATA API ======================
app.get("/api/users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({error:"Unauthorized"});
  const r = await pool.query("SELECT user_id,points,history FROM users ORDER BY user_id DESC");
  res.json(r.rows);
});
app.get("/api/withdraws", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({error:"Unauthorized"});
  const r = await pool.query("SELECT * FROM withdraw_requests ORDER BY id DESC");
  res.json(r.rows);
});
app.get("/api/ads", async (req, res) => {
  const r = await pool.query("SELECT * FROM ads ORDER BY id DESC");
  res.json(r.rows);
});
app.post("/api/ads", async (req, res) => {
  const {title,url,reward,status} = req.body;
  const r = await pool.query("INSERT INTO ads (title,url,reward,status) VALUES ($1,$2,$3,$4) RETURNING *",[title,url,reward,status]);
  res.json(r.rows[0]);
});
app.put("/api/ads/:id", async (req, res) => {
  const {id} = req.params;
  const {title,url,reward,status} = req.body;
  const r = await pool.query("UPDATE ads SET title=$1,url=$2,reward=$3,status=$4 WHERE id=$5 RETURNING *",[title,url,reward,status,id]);
  res.json(r.rows[0]);
});
app.delete("/api/ads/:id", async (req, res) => {
  await pool.query("DELETE FROM ads WHERE id=$1", [req.params.id]);
  res.json({success:true});
});
app.get("/export", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("❌ Unauthorized");
  const r = await pool.query("SELECT * FROM users");
  const data = r.rows.map(u=>({user_id:u.user_id,points:u.points,history:(u.history||[]).join('; ')}));
  const parser = new Parser({fields:["user_id","points","history"]});
  const csv = parser.parse(data);
  res.header("Content-Type","text/csv");
  res.attachment("users.csv");
  res.send(csv);
});

// ====================== KEEP ALIVE ======================
app.get("/", (req,res)=>res.send("🚀 Bot is running"));
setInterval(()=>{axios.get(`https://${BASE_HOST}`).catch(()=>{})},300000);

// ====================== START SERVER ======================
app.listen(PORT,()=>console.log(`✅ Server running on ${PORT}`));