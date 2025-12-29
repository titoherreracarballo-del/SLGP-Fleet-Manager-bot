const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send({ status: "Online", service: "SLGP Fleet Manager Bot", timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Web server active on port ${port}`);
  console.log("Monitoring fleet tasks 24/7...");
});