const express = require('express');
const ivasmsRouter = require('./ivasmsRouter');

const app = express();
const PORT = process.env.PORT || 3000;

// Mount the router under /api/ivasms
app.use('/api/ivasms', ivasmsRouter);

// Simple health check for Railway
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`IVASMS API running on port ${PORT}`);
});
