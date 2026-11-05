import path from 'node:path';

try {
  // Node >= 20.12: carrega .env se existir (sem dependência extra).
  process.loadEnvFile();
} catch {
  /* sem .env: segue com as variáveis do ambiente */
}

const int = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : def;
};

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  dataDir,
  dbFile: path.join(dataDir, 'lixo-bot.sqlite'),
  tz: process.env.APP_TZ || 'America/Sao_Paulo',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminHost: process.env.ADMIN_HOST || '127.0.0.1',
  adminPort: int(process.env.ADMIN_PORT, 3000),
  telegramEnabled: (process.env.TELEGRAM_ENABLED ?? 'true').toLowerCase() !== 'false',
  /** Nunca logar. */
  telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
  /** Intervalo mínimo entre envios/edições no Telegram (anti-flood). */
  sendMinIntervalMs: int(process.env.SEND_MIN_INTERVAL_MS, 1100),
  logLevel: process.env.LOG_LEVEL || 'info',
};
