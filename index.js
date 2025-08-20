// index.js — Telegram Ads Bot (Railway) // Features: // - Watch ads via /watch page (GigaPub) → auto reward +10 // - Bot menu: start, points, withdraw, history // - Withdraw flow: /withdraw → pending → admin approves/rejects // - Admin Panel with bottom tab bar, submenus, dark/light toggle // - Anti-abuse: one-time nonce per ad view (table: views)

// ===== DEPENDENCIES ===== const TelegramBot = require("node-telegram-bot-api"); const express = require("express"); const Database = require("better-sqlite3"); const crypto = require("crypto");

// ===== APP & DB ===== const app = express(); const db = new Database("db.sqlite");

// ===== CONFIG (ENV) ===== const TOKEN = process.env.TOKEN; // Telegram bot token const ADMIN_ID = process.env.ADMIN_ID || ""; // Telegram user id admin (optional notif) const ADMIN_KEY = process.env.ADMIN_KEY || "admin123"; // password akses panel admin const DOMAIN = process.env.DOMAIN || "https://your-app.railway.app"; // set ke URL Railway kamu const PORT = process.env.PORT || 3000;

if (!TOKEN) { console.error("ERROR: Env TOKEN kosong. Set TOKEN di Railway."); }

const bot = new TelegramBot(TOKEN, { polling: true });

// ===== DB SCHEMA ===== db.prepare(CREATE TABLE IF NOT EXISTS users ( id TEXT PRIMARY KEY, points INTEGER DEFAULT 0 )).run();

db.prepare(CREATE TABLE IF NOT EXISTS withdraws ( id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, amount INTEGER, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP )).run();

// One-time nonce untuk klaim reward per view // rewarded = 0 (belum), 1 (sudah) db.prepare(CREATE TABLE IF NOT EXISTS views ( nonce TEXT PRIMARY KEY, user_id TEXT, rewarded INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP )).run();

// ===== HELPERS ===== const getPoints = (uid) => (db.prepare("SELECT points FROM users WHERE id=?").get(uid)?.points || 0); const ensureUser = (uid) => db.prepare("INSERT OR IGNORE INTO users (id, points) VALUES (?,0)").run(uid); const addPoints = (uid, amt) => db.prepare("UPDATE users SET points = points + ? WHERE id=?").run(amt, uid); const deductPoints = (uid, amt) => { const cur = getPoints(uid); if (cur >= amt) { db.prepare("UPDATE users SET points = points - ? WHERE id=?").run(amt, uid); return true; } return false; }; const fmt = (n) => new Intl.NumberFormat("id-ID").format(n);

// ===== BOT COMMANDS ===== bot.onText(//start/, (msg) => { const chatId = String(msg.chat.id); ensureUser(chatId); bot.sendMessage(chatId, "👋 Selamat datang! Pilih menu:", { reply_markup: { inline_keyboard: [ [{ text: "🎬 Nonton Iklan", url: ${DOMAIN}/watch?user_id=${chatId} }], [ { text: "📊 Cek Poin", callback_data: "mypoints" }, { text: "💸 Withdraw", callback_data: "withdraw_help" } ], [{ text: "🧾 Riwayat Withdraw", callback_data: "riwayat" }] ] } }); });

bot.on("callback_query", (q) => { const chatId = String(q.message.chat.id); if (q.data === "mypoints") { const pts = getPoints(chatId); bot.answerCallbackQuery(q.id); bot.sendMessage(chatId, 💰 Poin kamu: *${fmt(pts)}*, { parse_mode: "Markdown" }); } if (q.data === "withdraw_help") { bot.answerCallbackQuery(q.id); bot.sendMessage(chatId, "Ketik perintah seperti ini:\n/withdraw 100\n(minimal 50 poin)", { parse_mode: "Markdown" }); } if (q.data === "riwayat") { const rows = db.prepare("SELECT id, amount, status, created_at FROM withdraws WHERE user_id=? ORDER BY id DESC LIMIT 10").all(chatId); let text = "🧾 Riwayat withdraw (10 terakhir):\n"; if (!rows.length) text += "(kosong)"; for (const r of rows) { text += #${r.id} • ${fmt(r.amount)} poin • ${r.status} • ${r.created_at}\n; } bot.answerCallbackQuery(q.id); bot.sendMessage(chatId, text); } });

// /poin cepat bot.onText(//poin/, (msg) => { const chatId = String(msg.chat.id); const pts = getPoints(chatId); bot.sendMessage(chatId, 💰 Poin kamu: *${fmt(pts)}*, { parse_mode: "Markdown" }); });

// /withdraw bot.onText(//withdraw\s+(\d+)/, (msg, match) => { const chatId = String(msg.chat.id); const amount = parseInt(match[1]); if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "Nominal tidak valid."); if (amount < 50) return bot.sendMessage(chatId, "⚠️ Minimal withdraw 50 poin."); ensureUser(chatId); const ok = deductPoints(chatId, amount); if (!ok) return bot.sendMessage(chatId, ❌ Poin kamu tidak cukup. Saldo: ${fmt(getPoints(chatId))});

// simpan request withdraw const info = db.prepare("INSERT INTO withdraws (user_id, amount) VALUES (?, ?)").run(chatId, amount); const wid = info.lastInsertRowid; bot.sendMessage(chatId, ✅ Withdraw *${fmt(amount)}* poin diajukan. ID: *#${wid}*\nMenunggu persetujuan admin., { parse_mode: "Markdown" });

if (ADMIN_ID) { // kirim notif + quick links approve/reject const approveUrl = ${DOMAIN}/admin/approve/${wid}?key=${encodeURIComponent(ADMIN_KEY)}; const rejectUrl = ${DOMAIN}/admin/reject/${wid}?key=${encodeURIComponent(ADMIN_KEY)}; const uname = msg.from.username ? @${msg.from.username} : (msg.from.first_name || chatId); bot.sendMessage(ADMIN_ID, 📢 Withdraw baru:\nUser: ${uname} (ID: ${chatId})\nAmount: ${fmt(amount)} poin\nID: #${wid}, { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", url: approveUrl }, { text: "❌ Reject", url: rejectUrl }]] } }); } });

// ===== WEB: Watch Page (generate nonce) ===== app.get("/watch", (req, res) => { const userId = String(req.query.user_id || ""); if (!userId) return res.send("User ID kosong"); ensureUser(userId); const nonce = crypto.randomBytes(16).toString("hex"); db.prepare("INSERT OR REPLACE INTO views (nonce, user_id, rewarded) VALUES (?, ?, 0)").run(nonce, userId);

res.send(` 

Nonton Iklan body { font-family: system-ui, Arial, sans-serif; text-align:center; padding:24px; } .box { max-width:560px; margin:0 auto; } 

🎬 Tonton iklan untuk dapat poin

Silakan tunggu sampai iklan selesai…

window.showGiga() .then(() => { fetch('/reward?user_id=${userId}&k=${nonce}') .then(() => { document.body.innerHTML = '<h2>✅ Iklan selesai! Poin ditambahkan. Kamu bisa kembali ke Telegram.</h2>'; }) .catch(() => { document.body.innerHTML = '<h2>⚠️ Gagal mencatat reward.</h2>'; }); }) .catch(() => { document.body.innerHTML = '<h2>❌ Gagal memutar iklan.</h2>'; }); `); }); 

// ===== WEB: Reward (validate nonce) ===== app.get("/reward", (req, res) => { const userId = String(req.query.user_id || ""); const k = String(req.query.k || ""); // nonce if (!userId || !k) return res.status(400).send("Bad request");

const row = db.prepare("SELECT * FROM views WHERE nonce=? AND user_id=?").get(k, userId); if (!row) return res.status(400).send("Invalid nonce"); if (row.rewarded) return res.send("Reward sudah pernah diklaim");

// tandai rewarded + tambah poin const tx = db.transaction(() => { db.prepare("UPDATE views SET rewarded=1 WHERE nonce=?").run(k); ensureUser(userId); addPoints(userId, 10); // === BESAR REWARD === }); tx();

res.send("✅ Reward ditambahkan"); try { bot.sendMessage(userId, "🎉 Kamu mendapat +10 poin dari nonton iklan!", { parse_mode: "Markdown" }); } catch {} });

// ===== ADMIN PANEL (bottom tab bar + submenus + dark mode) ===== app.get("/admin", (req, res) => { const key = String(req.query.key || ""); if (key !== ADMIN_KEY) return res.status(403).send("🚫 Unauthorized");

const users = db.prepare("SELECT * FROM users ORDER BY points DESC").all(); const withdraws = db.prepare("SELECT * FROM withdraws ORDER BY id DESC").all();

let html = `

Admin Panel body { font-family: system-ui, Arial; margin:0; padding-bottom:64px; transition: .2s; background:#f5f5f5; color:#111; } header { position:sticky; top:0; z-index:10; display:flex; justify-content:space-between; align-items:center; background:#333; color:#fff; padding:12px 16px; } .toggle { cursor:pointer; padding:6px 12px; border-radius:8px; background:#555; color:#fff; border:0; } .content { padding:16px; display:none; } .content.active { display:block; } .submenu { display:flex; gap:8px; margin-bottom:8px; } .submenu button { padding:8px 12px; border:0; border-radius:8px; background:#ddd; cursor:pointer; } .submenu button.active { background:#333; color:#fff; } table { width:100%; border-collapse:collapse; background:#fff; } th, td { padding:10px; border:1px solid #ddd; text-align:center; } th { background:#333; color:#fff; } a.btn { padding:6px 10px; background:#28a745; color:#fff; border-radius:6px; text-decoration:none; } a.btn.reject { background:#dc3545; } .tabs { position:fixed; bottom:0; left:0; right:0; display:flex; background:#333; } .tab { flex:1; text-align:center; padding:12px; color:#ccc; cursor:pointer; } .tab.active { background:#fff; color:#000; font-weight:600; } /* Dark */ body.dark { background:#121212; color:#eee; } body.dark header { background:#1f1f1f; } body.dark .submenu button { background:#2b2b2b; color:#ddd; } body.dark .submenu button.active { background:#555; color:#fff; } body.dark table { background:#1e1e1e; } body.dark th { background:#3a3a3a; } body.dark td { border-color:#333; } body.dark .tabs { background:#1f1f1f; } body.dark .tab { color:#aaa; } body.dark .tab.active { background:#2a2a2a; color:#fff; } 📊 Admin Panel 🌙 Dark <!-- USERS TAB --> <div id="users" class="content active"> <div class="submenu"> <button class="active" onclick="usersFilter('all', this)">Semua</button> <button onclick="usersFilter('top', this)">Top 10</button> <button onclick="location.reload()">🔄 Refresh</button> </div> <table id="tblUsers"> <tr><th>User ID</th><th>Poin</th></tr>`; 

for (const u of users) { html += <tr><td>${u.id}</td><td>${u.points}</td></tr>; } html += ` 

<!-- WITHDRAWS TAB --> <div id="withdraws" class="content"> <div class="submenu"> <button class="active" onclick="wdFilter('pending', this)">Pending</button> <button onclick="wdFilter('done', this)">Selesai</button> </div> <table id="tblWd"> <tr><th>ID</th><th>User ID</th><th>Jumlah</th><th>Status</th><th>Aksi</th></tr>`; 

for (const w of withdraws) { html += <tr data-status="${w.status}"> <td>${w.id}</td> <td>${w.user_id}</td> <td>${w.amount}</td> <td>${w.status}</td> <td>${w.status === 'pending' ? Approve Reject : '-'} </td> </tr>; } html += ` 

<div class="tabs"> <div class="tab active" onclick="showTab('users', this)">👥 Users</div> <div class="tab" onclick="showTab('withdraws', this)">💸 Withdraws</div> </div> <script> function showTab(id, el){ document.querySelectorAll('.content').forEach(c=>c.classList.remove('active')); document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); document.getElementById(id).classList.add('active'); el.classList.add('active'); } function usersFilter(type, btn){ document.querySelectorAll('#users .submenu button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); const rows=[...document.querySelectorAll('#tblUsers tr')]; rows.forEach((tr,i)=>{ if(i===0) return; tr.style.display=''; }); if(type==='top'){ const body=rows.slice(1); body.sort((a,b)=>parseInt(b.cells[1].innerText)-parseInt(a.cells[1].innerText)); body.forEach((tr,i)=>{ tr.style.display = i<10 ? '' : 'none'; }); } } function wdFilter(type, btn){ document.querySelectorAll('#withdraws .submenu button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); const rows=[...document.querySelectorAll('#tblWd tr')]; rows.forEach((tr,i)=>{ if(i===0) return; const st=tr.getAttribute('data-status'); tr.style.display = (type==='pending'? (st==='pending') : (st!=='pending')) ? '' : 'none'; }); } function toggleTheme(){ document.body.classList.toggle('dark'); const btn=document.querySelector('.toggle'); btn.innerText = document.body.classList.contains('dark') ? '☀️ Light' : '🌙 Dark'; } </script> `; 

res.send(html); });

// ===== ADMIN ACTIONS ===== app.get("/admin/approve/:wid", (req, res) => { if (String(req.query.key||"") !== ADMIN_KEY) return res.status(403).send("🚫 Unauthorized"); const wid = req.params.wid; const w = db.prepare("SELECT * FROM withdraws WHERE id=?").get(wid); if (!w) return res.send("Withdraw tidak ditemukan"); db.prepare("UPDATE withdraws SET status='approved' WHERE id=?").run(wid); try { bot.sendMessage(w.user_id, ✅ Withdraw ${fmt(w.amount)} poin kamu *disetujui*., { parse_mode: 'Markdown' }); } catch{} res.redirect(/admin?key=${encodeURIComponent(ADMIN_KEY)}); });

app.get("/admin/reject/:wid", (req, res) => { if (String(req.query.key||"") !== ADMIN_KEY) return res.status(403).send("🚫 Unauthorized"); const wid = req.params.wid; const w = db.prepare("SELECT * FROM withdraws WHERE id=?").get(wid); if (!w) return res.send("Withdraw tidak ditemukan"); db.prepare("UPDATE withdraws SET status='rejected' WHERE id=?").run(wid); // kembalikan poin ensureUser(w.user_id); addPoints(w.user_id, w.amount); try { bot.sendMessage(w.user_id, ❌ Withdraw ${fmt(w.amount)} poin kamu *ditolak*. Poin dikembalikan., { parse_mode: 'Markdown' }); } catch{} res.redirect(/admin?key=${encodeURIComponent(ADMIN_KEY)}); });

// ===== START ===== app.listen(PORT, () => console.log(Server running on :${PORT}));


