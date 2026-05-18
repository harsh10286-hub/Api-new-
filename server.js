const express = require('express');
const ivasmsRouter = require('./ivasmsRouter');

const app = express();
const PORT = process.env.PORT || 3000;

app.use('/api/ivasms', ivasmsRouter);
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`IVASMS API running on port ${PORT}`);
});
