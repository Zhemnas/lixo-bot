/**
 * Parsing de comandos (puro). Comandos começam com "/" e podem vir com o
 * sufixo "@NomeDoBot" (padrão do Telegram em grupos). Frases naturais
 * ("não posso", "eu pego") são marcadas como `natural: true` e o serviço só as
 * aceita quando existe contexto aberto (e só chegam se o bot recebe todas as
 * mensagens do grupo: privacy mode desligado ou bot administrador).
 */

export type Command =
  | { type: 'start' }
  | { type: 'ajuda' }
  | { type: 'hoje' }
  | { type: 'escala' }
  | { type: 'saldo' }
  | { type: 'feito' }
  | { type: 'sou'; name: string }
  | { type: 'naoposso'; natural: boolean }
  | { type: 'faltou'; name: string | null }
  | { type: 'eupego'; natural: boolean }
  | { type: 'vincular_grupo'; code: string };

/** Comandos exibidos no menu do Telegram (setMyCommands). */
export const GROUP_COMMANDS: { command: string; description: string }[] = [
  { command: 'hoje', description: 'Quem está com o lixo hoje' },
  { command: 'escala', description: 'Próximos dias' },
  { command: 'saldo', description: 'Saldo de turnos (fila) e dias recolhidos' },
  { command: 'naoposso', description: 'O escalado avisa que não pode' },
  { command: 'faltou', description: 'Avisa que o escalado faltou/esqueceu' },
  { command: 'eupego', description: 'Assume o dia de quem não pode' },
  { command: 'feito', description: 'Confirma que recolheu' },
  { command: 'sou', description: 'Vincula seu Telegram ao seu nome' },
  { command: 'ajuda', description: 'Lista de comandos' },
];

export const PRIVATE_COMMANDS: { command: string; description: string }[] = [
  { command: 'start', description: 'Habilita os lembretes no privado' },
  { command: 'ajuda', description: 'Como funciona' },
];

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const NATURAL_NAO_POSSO = /^(hoje )?(eu )?nao posso( hoje)?[.!]*$/;
const NATURAL_EU_PEGO = /^(eu pego|pode deixar que eu pego|deixa que eu pego)( hoje)?[.!]*$/;
const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/;

/**
 * @param botUsername username do bot; se informado, comandos endereçados a
 *   outro bot (`/hoje@OutroBot`) são ignorados.
 */
export function parseCommand(raw: string, botUsername: string | null = null): Command | null {
  const text = raw.trim();
  if (!text) return null;

  const m = COMMAND_RE.exec(text);
  if (m) {
    const head = m[1]!.toLowerCase();
    const target = m[2];
    if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
    // argumento preserva a grafia original (para nomes)
    const arg = (m[3] ?? '').trim();
    switch (head) {
      case 'start':
        return { type: 'start' };
      case 'ajuda':
      case 'help':
      case 'comandos':
        return { type: 'ajuda' };
      case 'hoje':
        return { type: 'hoje' };
      case 'escala':
        return { type: 'escala' };
      case 'saldo':
      case 'ranking':
      case 'placar':
        return { type: 'saldo' };
      case 'feito':
        return { type: 'feito' };
      case 'sou':
        return { type: 'sou', name: arg };
      case 'naoposso':
        return { type: 'naoposso', natural: false };
      case 'faltou':
        return { type: 'faltou', name: arg || null };
      case 'eupego':
        return { type: 'eupego', natural: false };
      case 'vincular_grupo':
        return { type: 'vincular_grupo', code: arg };
      default:
        return null;
    }
  }
  if (text.startsWith('/')) return null;

  // Frases naturais: só mensagens curtas e exatas, para evitar falsos positivos.
  const norm = normalize(text);
  if (norm.length > 40) return null;
  if (NATURAL_NAO_POSSO.test(norm)) return { type: 'naoposso', natural: true };
  if (NATURAL_EU_PEGO.test(norm)) return { type: 'eupego', natural: true };
  return null;
}

/** Compara nomes ignorando acentos e caixa. */
export function sameName(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

// ---------- botões (callback_data, máx. 64 bytes) ----------

export type ButtonAction =
  | { type: 'naoposso'; date: string }
  | { type: 'faltou'; date: string }
  | { type: 'feito'; date: string }
  | { type: 'eupego'; date: string }
  | { type: 'sou'; participantId: number };

const BTN_CODES = { naoposso: 'np', faltou: 'ft', feito: 'ok', eupego: 'pg' } as const;

export function encodeButton(a: ButtonAction): string {
  if (a.type === 'sou') return `sou:${a.participantId}`;
  return `${BTN_CODES[a.type]}:${a.date}`;
}

export function decodeButton(data: string): ButtonAction | null {
  const m = /^(np|ft|ok|pg|sou):([\w-]{1,20})$/.exec(data);
  if (!m) return null;
  const [, code, arg] = m as unknown as [string, string, string];
  if (code === 'sou') {
    const id = Number(arg);
    return Number.isInteger(id) && id > 0 ? { type: 'sou', participantId: id } : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) return null;
  const type = ({ np: 'naoposso', ft: 'faltou', ok: 'feito', pg: 'eupego' } as const)[
    code as 'np' | 'ft' | 'ok' | 'pg'
  ];
  return { type, date: arg };
}
