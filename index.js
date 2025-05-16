const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Server Node.js aktif!');
});

// Gunakan PORT dari environment Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
});
