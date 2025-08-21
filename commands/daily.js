module.exports = (bot, pool) => {
  bot.onText(/\/daily/, async (msg) => {
    const tgId = msg.from.id;
    try {
      const res = await pool.query("SELECT last_daily FROM users WHERE tg_id=$1", [tgId]);
      if (res.rows.length === 0) {
        return bot.sendMessage(tgId, "⚠️ Kamu belum terdaftar. Gunakan /start dulu.");
      }
      const lastDaily = res.rows[0].last_daily;
      const now = new Date();

      if (lastDaily && (now - new Date(lastDaily)) < 24 * 60 * 60 * 1000) {
        bot.sendMessage(tgId, "⏳ Kamu sudah klaim daily reward. Coba lagi besok!");
      } else {
        await pool.query(
          "UPDATE users SET balance = balance + 20, last_daily=$1 WHERE tg_id=$2",
          [now, tgId]
        );
        bot.sendMessage(tgId, "🎁 Kamu berhasil klaim 20 poin harian!");
      }
    } catch (err) {
      console.error(err);
    }
  });
};