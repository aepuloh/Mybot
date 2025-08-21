// loadCommands.js
const fs = require("fs");
const path = require("path");

function loadCommands(bot, pool) {
  const commandsPath = path.join(__dirname, "commands");

  if (!fs.existsSync(commandsPath)) {
    console.warn("⚠️ Folder 'commands' tidak ditemukan");
    return;
  }

  fs.readdirSync(commandsPath).forEach((file) => {
    if (file.endsWith(".js")) {
      const command = require(path.join(commandsPath, file));
      if (typeof command === "function") {
        command(bot, pool); // jalankan tiap command
        console.log(`✅ Loaded command: ${file}`);
      }
    }
  });
}

module.exports = loadCommands;
