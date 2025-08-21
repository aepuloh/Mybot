module.exports = (bot, pool) => {
  bot.onText(/\/ref/, async (msg) => {
    const tgId = msg.from.id;
    const link = `https://t.me/${bot.username}?start=${tgId}`;
    bot.sendMessage(
      tgId,
      `🔗 Link referral kamu:\n${link}\n\nAjak teman dan dapatkan 50 poin tiap referral!`
    );
  });
};