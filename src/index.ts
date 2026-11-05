import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import pino from 'pino';
import { config } from './config.js';
import { startAdmin, type ChannelControl } from './admin/server.js';
import { NullMessenger } from './channel/null.js';
import { TelegramChannel } from './channel/telegram.js';
import type { ChannelStatus } from './channel/types.js';
import { openDatabase } from './db/database.js';
import { Repository } from './db/repository.js';
import { DutyService } from './domain/service.js';

const logger = pino({ level: config.logLevel });

async function main(): Promise<void> {
  mkdirSync(config.dataDir, { recursive: true });
  // Sessão do antigo canal WhatsApp (descontinuado): não é mais usada.
  const legacyAuth = path.join(config.dataDir, 'auth');
  if (existsSync(legacyAuth)) {
    rmSync(legacyAuth, { recursive: true, force: true });
    logger.info('sessão antiga do WhatsApp (data/auth) removida');
  }

  const db = openDatabase(config.dbFile);
  const repo = new Repository(db);
  const service = new DutyService(repo, new NullMessenger(), { tz: config.tz, logger });

  let channel: ChannelControl;
  let tg: TelegramChannel | null = null;
  if (config.telegramEnabled) {
    if (!/^\d+:[\w-]{20,}$/.test(config.telegramBotToken)) {
      throw new Error('TELEGRAM_BOT_TOKEN ausente ou em formato inválido (ou use TELEGRAM_ENABLED=false)');
    }
    tg = new TelegramChannel({
      token: config.telegramBotToken,
      logger,
      minIntervalMs: config.sendMinIntervalMs,
      onMessage: (m) => service.handleIncoming(m),
      onAction: (a) => service.handleAction(a),
      onGroupMigrated: (oldId, newId) => service.migrateGroup(oldId, newId),
      onPrivateStatus: (userId, status) => service.setPrivateStatus(userId, status),
    });
    service.setMessenger(tg);
    channel = tg;
    void tg.start();
  } else {
    const disabled: ChannelStatus = {
      state: 'desabilitado',
      me: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    channel = { getStatus: () => disabled };
    logger.warn('TELEGRAM_ENABLED=false: rodando sem conexão com o Telegram');
  }

  let server: ReturnType<typeof startAdmin> | null = null;
  if (config.adminPassword.length >= 10) {
    server = startAdmin({
      host: config.adminHost,
      port: config.adminPort,
      user: config.adminUser,
      password: config.adminPassword,
      service,
      channel,
      tz: config.tz,
    });
    server.on('listening', () => logger.info(`Painel admin em http://${config.adminHost}:${config.adminPort}`));
    server.on('error', (err) => logger.error({ err }, 'falha ao subir o painel'));
  } else {
    logger.error('ADMIN_PASSWORD ausente ou com menos de 10 caracteres: painel admin NÃO iniciado');
  }

  // Um tick por minuto resolve aviso, prazo, lembrete e fechamento (idempotente).
  const task = cron.schedule('* * * * *', () => void service.tick(), { timezone: config.tz });
  setTimeout(() => void service.tick(), 5_000);

  const shutdown = async (sig: string) => {
    logger.info(`${sig} recebido, encerrando`);
    await task.stop();
    server?.close();
    await tg?.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: { message: (err as Error).message } }, 'falha fatal');
  process.exit(1);
});
