/**
 * Adaptador Telegram (Bot API oficial, via grammY, long polling).
 * Toda regra de negócio fica em DutyService; aqui só há transporte,
 * fila de envio (anti-flood + 429) e tradução de updates.
 */
import { Bot, GrammyError, HttpError, type Context, type Transformer } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Logger as PinoLogger } from 'pino';
import { GROUP_COMMANDS, PRIVATE_COMMANDS } from '../domain/commands.js';
import { escapeHtml } from '../domain/messages.js';
import {
  PrivateChatUnavailableError,
  type ChannelStatus,
  type ChatKind,
  type IncomingAction,
  type IncomingMessage,
  type Keyboard,
  type MessageRef,
  type Messenger,
  type OutgoingMessage,
  type Sender,
} from './types.js';

export interface TelegramOptions {
  token: string;
  logger: PinoLogger;
  /** Intervalo mínimo entre envios/edições (ms). O Telegram limita ~20 msgs/min por grupo. */
  minIntervalMs?: number;
  /** Mensagens mais antigas que isso são ignoradas (defesa extra além de drop_pending_updates). */
  maxMessageAgeSec?: number;
  onMessage(m: IncomingMessage): Promise<void>;
  onAction(a: IncomingAction): Promise<void>;
  onGroupMigrated(oldChatId: string, newChatId: string): void;
  onPrivateStatus(userId: string, status: 'ok' | 'bloqueado'): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Métodos que passam pela fila serial. */
const QUEUED = new Set(['sendMessage', 'editMessageText', 'editMessageReplyMarkup']);
const MAX_429_RETRIES = 3;

export class TelegramChannel implements Messenger {
  private readonly bot: Bot;
  private status: ChannelStatus = { state: 'conectando', me: null, lastError: null, updatedAt: new Date().toISOString() };
  private sendChain: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;
  private stopped = false;
  private ready = false;

  constructor(private readonly opts: TelegramOptions) {
    this.bot = new Bot(opts.token);
    this.bot.api.config.use(this.transformer);
    this.bot.catch((e) => this.opts.logger.error({ err: this.safeErr(e.error) }, 'erro no processamento de update'));
    this.register();
  }

  // ---------- segurança de log ----------

  /** Remove o token de qualquer texto (URLs de erro do fetch incluem o token). */
  private redact(s: string): string {
    return this.opts.token ? s.split(this.opts.token).join('<token>') : s;
  }

  private safeErr(err: unknown): { name: string; message: string; code?: number } {
    if (err instanceof GrammyError) return { name: 'GrammyError', message: this.redact(err.description), code: err.error_code };
    if (err instanceof HttpError) {
      const inner = err.error instanceof Error ? `: ${err.error.message}` : '';
      return { name: 'HttpError', message: this.redact(err.message + inner) };
    }
    if (err instanceof Error) return { name: err.name, message: this.redact(err.message) };
    return { name: 'Error', message: this.redact(String(err)) };
  }

  // ---------- estado ----------

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<ChannelStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
  }

  isReady(): boolean {
    return this.ready && !this.stopped;
  }

  botUsername(): string | null {
    return this.ready ? this.bot.botInfo.username : null;
  }

  // ---------- ciclo de vida ----------

  async start(): Promise<void> {
    this.stopped = false;
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.bot.init();
        const me = this.bot.botInfo;
        this.ready = true;
        this.setStatus({ state: 'conectado', me: `@${me.username}`, lastError: null });
        this.opts.logger.info({ bot: me.username }, 'Telegram conectado');
        await this.registerCommands();
        break;
      } catch (err) {
        const e = this.safeErr(err);
        this.setStatus({ state: 'erro', lastError: e.message });
        if (err instanceof GrammyError && err.error_code === 401) {
          this.opts.logger.error('TELEGRAM_BOT_TOKEN inválido (401). Corrija o .env e reinicie.');
          return;
        }
        const delay = Math.min(60_000, 2_000 * 2 ** attempt++);
        this.opts.logger.warn({ err: e, delay }, 'falha ao conectar no Telegram; tentando de novo');
        await sleep(delay);
      }
    }
    void this.poll();
  }

  /** Long polling; reinicia em caso de falha (sem descartar updates nas retomadas). */
  private async poll(): Promise<void> {
    let first = true;
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.bot.start({
          drop_pending_updates: first, // ignora o que acumulou enquanto o bot estava desligado
          allowed_updates: ['message', 'callback_query', 'my_chat_member'],
          onStart: () => {
            attempt = 0;
            this.setStatus({ state: 'conectado', lastError: null });
          },
        });
        return; // stop() chamado
      } catch (err) {
        first = false;
        const e = this.safeErr(err);
        this.setStatus({ state: 'erro', lastError: e.message });
        if (err instanceof GrammyError && err.error_code === 401) {
          this.ready = false;
          this.opts.logger.error('Token revogado/inválido (401). Polling encerrado.');
          return;
        }
        // 409 = outra instância usando o mesmo token.
        const delay = Math.min(60_000, 3_000 * 2 ** attempt++);
        this.opts.logger.error({ err: e, delay }, 'polling do Telegram caiu; reiniciando');
        await sleep(delay);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (this.bot.isRunning()) await this.bot.stop();
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });
      await this.bot.api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: 'all_private_chats' } });
    } catch (err) {
      this.opts.logger.warn({ err: this.safeErr(err) }, 'falha ao registrar comandos (setMyCommands)');
    }
  }

  // ---------- fila de envio / 429 ----------

  /** Fila serial com intervalo mínimo e respeito a `retry_after` (429) para todas as chamadas. */
  private readonly transformer: Transformer = async (prev, method, payload, signal) => {
    const call = async () => {
      for (let i = 0; ; i++) {
        const res = await prev(method, payload, signal);
        if (!res.ok && res.error_code === 429 && i < MAX_429_RETRIES) {
          const wait = (res.parameters?.retry_after ?? 1) * 1000 + 250;
          this.opts.logger.warn({ method, wait }, 'Telegram 429 (flood); aguardando retry_after');
          await sleep(wait);
          continue;
        }
        return res;
      }
    };
    if (!QUEUED.has(method)) return call();
    const run = async () => {
      const gap = (this.opts.minIntervalMs ?? 1_100) - (Date.now() - this.lastSendAt);
      if (gap > 0) await sleep(gap);
      try {
        return await call();
      } finally {
        this.lastSendAt = Date.now();
      }
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => undefined);
    return p;
  };

  // ---------- Messenger ----------

  private markup(buttons?: Keyboard): InlineKeyboardMarkup {
    return {
      inline_keyboard: (buttons ?? []).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
    };
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<MessageRef> {
    const sent = await this.bot.api.sendMessage(chatId, msg.html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(msg.buttons?.length ? { reply_markup: this.markup(msg.buttons) } : {}),
      ...(msg.replyTo ? { reply_parameters: { message_id: msg.replyTo, allow_sending_without_reply: true } } : {}),
    });
    return { chatId: String(sent.chat.id), messageId: sent.message_id };
  }

  async edit(ref: MessageRef, msg: OutgoingMessage): Promise<void> {
    try {
      await this.bot.api.editMessageText(ref.chatId, ref.messageId, msg.html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: this.markup(msg.buttons),
      });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }

  async clearButtons(ref: MessageRef): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(ref.chatId, ref.messageId, { reply_markup: { inline_keyboard: [] } });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }

  async sendPrivate(userId: string, html: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(userId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (err) {
      // 403: nunca deu /start ou bloqueou o bot; 400 chat not found: idem.
      if (err instanceof GrammyError && (err.error_code === 403 || /chat not found/i.test(err.description))) {
        throw new PrivateChatUnavailableError();
      }
      throw new Error(this.safeErr(err).message);
    }
  }

  mention(userId: string, displayName: string): string {
    const name = escapeHtml(displayName);
    return /^\d{1,16}$/.test(userId) ? `<a href="tg://user?id=${userId}">${name}</a>` : name;
  }

  // ---------- entrada ----------

  private sender(ctx: Context): Sender | null {
    const u = ctx.from;
    if (!u || u.is_bot) return null;
    return {
      userId: String(u.id),
      username: u.username ?? null,
      displayName: [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 64) || String(u.id),
    };
  }

  private register(): void {
    const log = this.opts.logger;

    this.bot.on('message:text', async (ctx) => {
      const m = ctx.message;
      const maxAge = this.opts.maxMessageAgeSec ?? 120;
      if (Date.now() / 1000 - m.date > maxAge) return;
      const sender = this.sender(ctx);
      if (!sender) return;
      const chat = m.chat;
      await this.opts.onMessage({
        chatId: String(chat.id),
        chatKind: chat.type as ChatKind,
        chatTitle: 'title' in chat ? (chat.title ?? null) : null,
        messageId: m.message_id,
        sender,
        text: m.text,
      });
    });

    this.bot.on('callback_query:data', async (ctx) => {
      const q = ctx.callbackQuery;
      let answered = false;
      const answer = async (text?: string, alert?: boolean) => {
        if (answered) return;
        answered = true;
        try {
          await ctx.answerCallbackQuery(text ? { text: text.slice(0, 200), show_alert: !!alert } : undefined);
        } catch (err) {
          log.warn({ err: this.safeErr(err) }, 'falha ao responder callback');
        }
      };
      const sender = this.sender(ctx);
      const message = q.message;
      if (!sender || !message) return answer('Botão expirado.');
      try {
        await this.opts.onAction({
          chatId: String(message.chat.id),
          chatKind: message.chat.type as ChatKind,
          messageId: message.message_id,
          sender,
          data: q.data,
          answer,
        });
      } finally {
        await answer();
      }
    });

    this.bot.on('message:migrate_to_chat_id', (ctx) => {
      this.opts.onGroupMigrated(String(ctx.chat.id), String(ctx.message.migrate_to_chat_id));
    });

    // Privado: o usuário iniciou (member) ou bloqueou (kicked) o bot.
    this.bot.on('my_chat_member', (ctx) => {
      const u = ctx.myChatMember;
      if (u.chat.type !== 'private') return;
      const st = u.new_chat_member.status;
      if (st === 'kicked') this.opts.onPrivateStatus(String(u.chat.id), 'bloqueado');
      else if (st === 'member') this.opts.onPrivateStatus(String(u.chat.id), 'ok');
    });
  }
}

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 400 && /message is not modified/i.test(err.description);
}
