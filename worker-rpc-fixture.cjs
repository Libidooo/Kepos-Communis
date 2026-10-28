// Deterministic local transport fixture; never imports Pi or contacts a provider.
const readline = require('node:readline');
const mode = process.env.KEPOS_FIXTURE_MODE || 'normal';
let messages = [];
const send = record => process.stdout.write(JSON.stringify(record) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const command = JSON.parse(line);
 const response = data => send({ type: 'response', id: command.id, success: true, data });
 switch (command.type) {
  case 'get_state':
   if (mode === 'invalid-json') { process.stdout.write('null\n'); return; }
   response({ isStreaming: false }); return;
  case 'new_session': messages = []; response({ cancelled: false }); return;
  case 'get_messages':
   response(mode === 'missing-messages' ? {} : { messages: mode === 'retained-tool' ? [{ role: 'toolResult', content: 'old data' }] : messages }); return;
  case 'prompt':
   if (command.message === 'HANDLED') { response({ disposition: 'handled' }); return; }
   response({ disposition: 'started' });
   if (command.message === 'WAIT') return;
   setImmediate(() => {
    const text = command.message === 'FRESH' ? (messages.length ? 'LEAKED_CONTEXT' : 'FRESH_CONTEXT') : command.message === 'UNICODE' ? '中文😀'.repeat(10000) : command.message;
    messages.push({ role: 'user', content: command.message });
    send({ type: 'agent_start' });
    send({ type: 'message_start', message: { role: 'assistant' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    send({ type: 'message_end', message: { role: 'assistant', stopReason: command.message === 'FAIL' ? 'error' : 'stop', content: [{ type: 'text', text }], errorMessage: command.message === 'FAIL' ? 'fixture failure' : undefined } });
    messages.push({ role: 'assistant', content: text });
    send({ type: 'agent_settled' });
   });
 }
});
