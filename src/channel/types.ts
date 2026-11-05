/**
 * Contrato entre o domínio e o canal de mensagens. O serviço de domínio só
 * conhece estas interfaces; trocar de canal significa implementar `Messenger`
 * e encaminhar eventos para `DutyService.handleIncoming` / `handleAction`.
 *
 * Textos de saída usam o subconjunto HTML do Telegram (<b>, <i>, <code>, <a>).
 * O domínio é responsável por escapar o conteúdo dinâmico (ver `escapeHtml`).
 */

export interface InlineButton {
  text: string;
  /** Payload devolvido em `IncomingAction.data` (máx. 64 bytes). */
  data: string;
}

/** Linhas de botões. */
export type Keyboard = InlineButton[][];

export interface OutgoingMessage {
  /** HTML já escapado. */
  html: string;
  /** Botões inline; ausente/vazio = sem botões. */
  buttons?: Keyboard;
  /** Responder a uma mensagem específica do mesmo chat. */
  replyTo?: number;
}

export interface MessageRef {
  chatId: string;
  messageId: number;
}

export interface Messenger {
  /** Pronto para enviar? */
  isReady(): boolean;
  /** @username do bot (sem @), se conhecido. */
  botUsername(): string | null;
  /** Envia ao chat (grupo) e devolve a referência da mensagem. */
  send(chatId: string, msg: OutgoingMessage): Promise<MessageRef>;
  /** Edita texto e botões de uma mensagem enviada pelo bot (`buttons` ausente remove os botões). */
  edit(ref: MessageRef, msg: OutgoingMessage): Promise<void>;
  /** Remove os botões, mantendo o texto. */
  clearButtons(ref: MessageRef): Promise<void>;
  /**
   * Mensagem privada para o usuário. Lança `PrivateChatUnavailableError` quando a
   * pessoa nunca iniciou conversa com o bot (ou o bloqueou).
   */
  sendPrivate(userId: string, html: string): Promise<void>;
  /** Menção clicável em HTML (o adaptador escapa `displayName`). */
  mention(userId: string, displayName: string): string;
}

export class PrivateChatUnavailableError extends Error {
  constructor(message = 'usuário não iniciou conversa privada com o bot') {
    super(message);
    this.name = 'PrivateChatUnavailableError';
  }
}

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel';

export interface Sender {
  userId: string;
  username: string | null;
  displayName: string;
}

export interface IncomingMessage {
  chatId: string;
  chatKind: ChatKind;
  chatTitle: string | null;
  messageId: number;
  sender: Sender;
  text: string;
}

export interface IncomingAction {
  chatId: string;
  chatKind: ChatKind;
  /** Mensagem (do bot) que contém o botão clicado. */
  messageId: number;
  sender: Sender;
  data: string;
  /** Responde o clique (toast). Chamar no máximo uma vez; o adaptador responde vazio se não for chamado. */
  answer(text?: string, alert?: boolean): Promise<void>;
}

export type ConnectionState = 'desabilitado' | 'conectando' | 'conectado' | 'erro';

export interface ChannelStatus {
  state: ConnectionState;
  /** @username do bot */
  me: string | null;
  lastError: string | null;
  updatedAt: string;
}
