import { createApp } from './src/app.js';

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || './data/finance.db';
const trustProxy = process.env.TRUST_PROXY === '1';

const app = createApp({ dbPath, trustProxy });
app.listen(port, () => {
  console.log(`Спільні витрати: http://localhost:${port}`);
});
