module.exports = (bot, pool) => {
  bot.onText(/\/spin/, async (msg) => {
    const tgId = msg.from.id;
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_spin TIMESTAMP DEFAULT NULL`);
      const res = await pool.query("SELECT last_spin FROM users WHERE tg_id=$1", [tgId]);

      if (res.rows.length === 0) {
        return bot.sendMessage(tgId, "⚠️ Kamu belum terdaftar. Gunakan /start dulu.");
      }

      const lastSpin = res.rows[0].last_spin;
      const now = new Date();

      if (lastSpin && (now - new Date(lastSpin)) < 24 * 60 * 60 * 1000) {
        return bot.sendMessage(tgId, "⏳ Kamu sudah spin hari ini. Coba lagi besok!");
      }

      const reward = Math.floor(Math.random() * 101);
      await pool.query("UPDATE users SET balance = balance + $1, last_spin=$2 WHERE tg_id=$3", [reward, now, tgId]);

      bot.sendMessage(
        tgId,
        `🎰 Kamu dapat *${reward} poin* dari Lucky Spin hari ini!`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error(err);
    }
  });
};