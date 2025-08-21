module.exports = (bot, pool) => {
  bot.onText(/\/leaderboard/, async (msg) => {
    const tgId = msg.from.id;
    try {
      const res = await pool.query(
        "SELECT username, balance FROM users ORDER BY balance DESC LIMIT 10"
      );

      if (res.rows.length === 0) {
        return bot.sendMessage(tgId, "⚠️ Belum ada data leaderboard.");
      }

      let text = "🏆 *Top 10 Leaderboard*\n\n";
      res.rows.forEach((user, i) => {
        text += `${i + 1}. @${user.username || "noname"} — ${user.balance} poin\n`;
      });

      bot.sendMessage(tgId, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(err);
      bot.sendMessage(tgId, "❌ Terjadi error saat ambil data leaderboard.");
    }
  });
};