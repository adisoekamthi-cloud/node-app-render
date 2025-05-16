const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000; // pakai PORT dari Railway jika ada

app.get('/', (req, res) => {
  res.send('Halo dari aplikasi Node.js di Railway!');
});

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
