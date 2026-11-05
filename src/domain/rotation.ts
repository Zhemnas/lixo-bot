/**
 * Rodízio round-robin puro (sem I/O).
 *
 * O "ponteiro" é o id do último participante escalado pela fila. O próximo é o
 * primeiro participante `ativo` depois dele na ordem da fila (circular).
 * Férias/desligados são pulados sem alterar a ordem: quando voltam a `ativo`
 * simplesmente voltam a ser elegíveis na sua posição.
 */
import type { ISODate } from './dates.js';
import type { Participant } from './types.js';

export function sortQueue(participants: Participant[]): Participant[] {
  return [...participants].sort((a, b) => a.position - b.position || a.id - b.id);
}

/**
 * Próximo participante ativo após `lastId` (exclusivo) na fila.
 * `exclude` remove candidatos específicos (usado na escala automática).
 */
export function nextInQueue(
  participants: Participant[],
  lastId: number | null,
  exclude: ReadonlySet<number> = new Set(),
): Participant | null {
  const queue = sortQueue(participants);
  if (queue.length === 0) return null;
  let start = 0;
  if (lastId !== null) {
    const idx = queue.findIndex((p) => p.id === lastId);
    // Se o último escalado foi removido do banco (não deveria acontecer), recomeça do início.
    start = idx >= 0 ? idx + 1 : 0;
  }
  for (let i = 0; i < queue.length; i++) {
    const p = queue[(start + i) % queue.length]!;
    if (p.status === 'ativo' && !exclude.has(p.id)) return p;
  }
  return null;
}

export interface Prediction {
  date: ISODate;
  participant: Participant | null;
}

/** Prevê a escala dos `dates` (já filtradas como dias ativos) a partir do ponteiro. */
export function predict(
  participants: Participant[],
  lastId: number | null,
  dates: ISODate[],
): Prediction[] {
  const out: Prediction[] = [];
  let pointer = lastId;
  for (const date of dates) {
    const p = nextInQueue(participants, pointer);
    out.push({ date, participant: p });
    if (p) pointer = p.id;
  }
  return out;
}
