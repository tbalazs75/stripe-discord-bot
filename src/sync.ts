import { config } from 'dotenv';
config();

import { initialize as initializeDatabase } from './database';

(async () => {
  try {
    await initializeDatabase();
    console.log('✅ Database initialized (via sync.ts)');
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to initialize database:', err);
    process.exit(1);
  }
})();
