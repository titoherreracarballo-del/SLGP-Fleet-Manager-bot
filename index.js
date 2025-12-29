const nodemailer = require('nodemailer');

console.log("SLGP Fleet Manager Bot is starting up...");

// This simple interval keeps the Node.js process alive 24/7
setInterval(() => {
  console.log("Bot Heartbeat: Still monitoring fleet tasks at " + new Date().toISOString());
}, 60000); // Logs every minute