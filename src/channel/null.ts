import { escapeHtml } from '../domain/messages.js';
import type { MessageRef, Messenger } from './types.js';

/** Messenger nulo, usado com TELEGRAM_ENABLED=false. */
export class NullMessenger implements Messenger {
  isReady(): boolean {
    return false;
  }
  botUsername(): string | null {
    return null;
  }
  async send(): Promise<MessageRef> {
    throw new Error('canal desabilitado');
  }
  async edit(): Promise<void> {
    throw new Error('canal desabilitado');
  }
  async clearButtons(): Promise<void> {
    throw new Error('canal desabilitado');
  }
  async sendPrivate(): Promise<void> {
    throw new Error('canal desabilitado');
  }
  mention(_userId: string, displayName: string): string {
    return escapeHtml(displayName);
  }
}
