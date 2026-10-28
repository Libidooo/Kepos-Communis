import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { spawn } from 'node:child_process';
import type { AuthInteraction, AuthPrompt, AuthEvent } from '@earendil-works/pi-ai';

export function openAuthUrl(value: string): void {
 const url = new URL(value);
 if (!['https:', 'http:'].includes(url.protocol)) throw Error('Unsupported authentication URL');
 const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
 const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
 const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
 child.on('error', () => {}); // The displayed URL remains a manual fallback.
 child.unref();
}
export function authEventText(event: AuthEvent): string {
 if (event.type === 'auth_url') return (event.instructions ? event.instructions + '\n' : '') + event.url;
 if (event.type === 'device_code') return `Open ${event.verificationUri}\nCode: ${event.userCode}`;
 return event.message;
}
export function terminalInteraction(signal?: AbortSignal): AuthInteraction {
 return {
  signal,
  notify(event) {
   stderr.write(authEventText(event) + '\n');
   if (event.type === 'auth_url' && process.env.KEPOS_NO_BROWSER !== '1') openAuthUrl(event.url);
  },
  async prompt(prompt: AuthPrompt) {
   const activeSignal = signal && prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal || prompt.signal;
   if (activeSignal?.aborted) throw activeSignal.reason;
   if (!stdin.isTTY) throw Error('Interactive authentication requires a terminal; use an environment API key for automation.');
   if (prompt.type === 'secret') return secretQuestion(prompt.message, activeSignal);
   const reader = createInterface({ input: stdin, output: stderr });
   try {
    if (prompt.type === 'select') {
     prompt.options.forEach((option, index) => stderr.write(`${index + 1}. ${option.label}${option.description ? ' — ' + option.description : ''}\n`));
     const answer = (await reader.question(prompt.message + ' ', { signal: activeSignal })).trim();
     const found = prompt.options.find(option => option.id === answer) || prompt.options[Number(answer) - 1];
     if (!found) throw Error('Invalid authentication choice');
     return found.id;
    }
    const value = await reader.question(prompt.message + ' ', { signal: activeSignal });
    if (!value.trim()) throw Error('Authentication input was empty');
    return value.trim();
   } finally { reader.close(); }
  },
 };
}
function secretQuestion(message: string, signal?: AbortSignal): Promise<string> {
 return new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const raw = stdin.isRaw;
  let value = '';
  stderr.write(message + ' ');
  stdin.setRawMode(true);
  stdin.resume();
  const cleanup = () => {
   stdin.off('data', input);
   signal?.removeEventListener('abort', abort);
   stdin.setRawMode(raw);
   stderr.write('\n');
   if (!raw) stdin.pause();
  };
  const abort = () => { cleanup(); reject(signal?.reason || Error('Authentication cancelled')); };
  const input = (chunk: Buffer) => {
   for (const character of chunk.toString('utf8')) {
    if (character === '\u0003' || character === '\u001b') { cleanup(); reject(Error('Authentication cancelled')); return; }
    if (character === '\r' || character === '\n') { cleanup(); value ? resolve(value) : reject(Error('Empty credential')); return; }
    if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
    else if (character >= ' ') value += character;
   }
  };
  signal?.addEventListener('abort', abort, { once: true });
  stdin.on('data', input);
 });
}

export function tuiInteraction(ctx: any, signal?: AbortSignal): AuthInteraction {
 return {
  signal,
  notify(event) {
   ctx.ui.notify(authEventText(event), 'info');
   if (event.type === 'auth_url' && process.env.KEPOS_NO_BROWSER !== '1') openAuthUrl(event.url);
  },
  async prompt(prompt) {
   const activeSignal = signal && prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal || prompt.signal;
   let value: string | undefined;
   if (prompt.type === 'select') {
    const labels = prompt.options.map(option => option.label);
    const selected = await ctx.ui.select(prompt.message, labels, { signal: activeSignal });
    value = prompt.options[labels.indexOf(selected)]?.id;
   } else if (prompt.type === 'secret') {
    const { Input, Key, matchesKey, truncateToWidth, CURSOR_MARKER } = await import('@earendil-works/pi-tui');
    value = await ctx.ui.custom((tui: any, theme: any, _keys: any, done: any) => {
     const input = new Input();
     let finished = false;
     const finish = (result?: string) => { if (finished) return; finished = true; activeSignal?.removeEventListener('abort', abort); input.setValue(''); done(result); };
     const abort = () => finish();
     input.onSubmit = text => finish(text);
     input.onEscape = abort;
     activeSignal?.addEventListener('abort', abort, { once: true });
     if (activeSignal?.aborted) queueMicrotask(abort);
     return {
      focused: true, invalidate() {}, dispose() { activeSignal?.removeEventListener('abort', abort); input.setValue(''); },
      render(width: number) {
       // Render only masks; the real value never enters screen history or notices.
       const masked = '•'.repeat(Math.min(Array.from(input.getValue()).length, Math.max(0, width - 8)));
       return [theme.fg('accent', truncateToWidth('Kepos · ' + prompt.message, width)), '', '  › ' + masked + CURSOR_MARKER, '', theme.fg('muted', truncateToWidth('Enter confirm · Esc cancel', width))];
      },
      handleInput(data: string) { if (matchesKey(data, Key.escape)) abort(); else input.handleInput(data); tui.requestRender(); },
     };
    }, { overlay: true, overlayOptions: { anchor: 'center', width: '80%', maxHeight: '80%', margin: 1 } });
   } else value = await ctx.ui.input(prompt.message, prompt.placeholder, { signal: activeSignal });
   if (value === undefined || !value.trim()) throw Error('Authentication cancelled');
   return value.trim();
  },
 };
}
