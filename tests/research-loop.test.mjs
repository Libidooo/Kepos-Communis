import test from 'node:test';
import assert from 'node:assert/strict';

const { applyResearchClassification, parseResearchClassification, routeResearchIntent, checkResearchProvenance, citationUrls } = await import('../dist/terminal/research-router.js');
const { parseAnswerAudit, quoteMatchesRetrievedEvidence, registerResearchLoop } = await import('../dist/terminal/research-loop.js');
const { parseBraveSearchResponse, parseFinnhubQuote, pinnedLookup } = await import('../dist/terminal/web-research.js');

test('intent routing distinguishes project, local files, current facts, provided material, and chat', () => {
  assert.equal(routeResearchIntent('检查我们 Kepos 仓库里的启动逻辑').kind, 'project');
  assert.equal(routeResearchIntent('打开简历文件').kind, 'local_file');
  assert.equal(routeResearchIntent('查看今天英特尔的股票行情').kind, 'live_external');
  assert.equal(routeResearchIntent('查看今天英特尔的股票行情').confidence, 'high');
  const mixed = routeResearchIntent('根据附件对比英特尔今天的股价', { hasAttachment: true });
  assert.equal(mixed.kind, 'live_external');
  assert.ok(mixed.sources.includes('user_material'), 'attachments and live sources are both included');
  assert.equal(routeResearchIntent('根据附件总结这份材料', { hasAttachment: true }).kind, 'provided_material');
  assert.equal(routeResearchIntent('谢谢').requiresEvidence, false);
  assert.equal(routeResearchIntent('某个不明确的陈述').confidence, 'low');
  assert.equal(routeResearchIntent('不要联网，只根据附件回答', { hasAttachment: true }).explicit, true);
});

test('model classification repairs uncertain routes while explicit user scope stays authoritative', () => {
  const fallback = routeResearchIntent('Fermat theorem proof');
  assert.equal(fallback.confidence, 'low');
  const refined = applyResearchClassification(fallback, { kind: 'external_knowledge', confidence: 'high', reason: 'Named mathematical theorem requires factual explanation.' });
  assert.equal(refined.kind, 'external_knowledge');
  assert.equal(refined.method, 'model');
  assert.deepEqual(refined.sources, ['web_search', 'source_pages']);
  assert.equal(applyResearchClassification(routeResearchIntent('Why do leaves change color?'), { kind: 'chat', confidence: 'low', reason: 'uncertain' }).kind, 'external_knowledge', 'uncertain classification cannot suppress the evidence route');
  const explicit = routeResearchIntent('不要联网，只根据附件总结', { hasAttachment: true });
  assert.equal(applyResearchClassification(explicit, { kind: 'live_external', reason: 'bad override' }, true).kind, 'provided_material');
  assert.equal(parseResearchClassification('{"kind":"project","confidence":"high","reason":"asks about repository code"}').kind, 'project');
  assert.throws(() => parseResearchClassification('{"kind":"surprise","reason":"unknown"}'), /未知资料路由/);
});

test('research loop asks the classifier only for uncertain routes and records its decision', async () => {
  const handlers = new Map();
  const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
  let calls = 0;
  registerResearchLoop(pi, {
    autoSearch: false,
    classify: async ({ query }) => { calls++; assert.match(query, /Fermat/); return { kind: 'external_knowledge', confidence: 'high', reason: 'A named theorem is a factual topic.' }; },
  });
  const sections = {};
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Fermat theorem proof', systemPromptOptions: { sections } });
  assert.match(sections.kepos_research_route, /live_external|external_knowledge/);
  assert.match(sections.kepos_research_route, /method=model/);
  assert.equal(calls, 1);
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: '不要联网，只根据附件总结', images: [{}], systemPromptOptions: { sections: {} } });
  assert.equal(calls, 1, 'explicit scope bypasses the classifier');
});

test('evidence gate treats search hits as leads and requires a read source plus matching citation', () => {
  const route = routeResearchIntent('Explain the current policy');
  const searchOnly = [{ kind: 'web_search', ok: true, retrievedAt: '2026-11-12T00:00:00Z' }];
  assert.equal(checkResearchProvenance(route, searchOnly, 'The policy changed.').ready, false);
  const page = { kind: 'web_open', ok: true, url: 'https://example.org/policy', title: 'Policy', retrievedAt: '2026-11-12T00:01:00Z' };
  assert.equal(checkResearchProvenance(route, [...searchOnly, page], 'The policy changed. [source](https://example.org/policy)').ready, true);
  assert.deepEqual(citationUrls('See https://example.org/policy. and https://example.org/policy'), ['https://example.org/policy']);
  assert.equal(checkResearchProvenance(route, [...searchOnly, page], 'See https://unread.example.org/').ready, false);
  const marketRoute = routeResearchIntent('查看今天英特尔的股票行情');
  const quote = { kind: 'market_quote', ok: true, url: 'https://finnhub.io/docs/api/quote', dataAt: '2026-11-12T00:00:00Z', retrievedAt: '2026-11-12T00:01:00Z' };
  assert.equal(checkResearchProvenance(marketRoute, [quote], 'INTC 行情数据来自 Finnhub：https://finnhub.io/docs/api/quote').ready, true);
  assert.equal(checkResearchProvenance(marketRoute, [quote], 'INTC 行情数据来自 https://unread.example.org/').ready, false);
});

test('structured research payloads preserve provider and market timestamps', () => {
  assert.deepEqual(parseBraveSearchResponse({ web: { results: [{ title: 'A', url: 'https://a.example', description: 'B', page_age: 'yesterday' }] } }, 1), [
    { title: 'A', url: 'https://a.example/', snippet: 'B', publishedAt: 'yesterday' },
  ]);
  const quote = parseFinnhubQuote({ c: 42, d: 1, dp: 2.4, t: 1794440000 }, { isOpen: false, session: 'regular', timezone: 'America/New_York' }, 'INTC', '2026-11-12T00:00:00Z');
  assert.equal(quote.symbol, 'INTC');
  assert.equal(quote.price, 42);
  assert.equal(quote.dataAt, new Date(1794440000 * 1000).toISOString());
  assert.equal(quote.retrievedAt, '2026-11-12T00:00:00Z');
});

test('answer audit parser rejects invalid JSON and normalizes unverifiable claims', () => {
  assert.equal(parseAnswerAudit('not json'), undefined);
  const audit = parseAnswerAudit(JSON.stringify({ claims: [{ claim: 'A fact', status: 'bogus', sources: [], quote: 'x' }] }));
  assert.equal(audit.status, 'unsupported');
  assert.equal(audit.claims[0].status, 'unsupported');
});

test('a supported claim needs an exact quote from one of its cited retrieved excerpts', async () => {
  assert.equal(quoteMatchesRetrievedEvidence('Actual evidence text', ['The Actual evidence\ntext appears here.']), true);
  assert.equal(quoteMatchesRetrievedEvidence('Fabricated wording', ['The page contains unrelated text.']), false);
  const handlers = new Map();
  const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
  registerResearchLoop(pi, {
    autoSearch: false,
    verify: async () => ({ claims: [{ claim: 'A factual claim', status: 'supported', sources: ['https://source.example/page'], quote: 'A fabricated quote from this article.' }] }),
  });
  const sections = {};
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: 'What is the current evidence?', systemPromptOptions: { sections } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_search', result: { details: { results: [{ url: 'https://source.example/page' }] } } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_open', args: { url: 'https://source.example/page' }, result: { details: { url: 'https://source.example/page', content: 'The article contains a different factual passage.' } } });
  const event = await handlers.get('agent_before_settle')({ outcome: 'completed', context: { contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'A factual claim. https://source.example/page' }] }] } });
  assert.equal(event.continue, true, 'the runtime asks for more evidence or a narrower answer');
  assert.match(event.entries[0].content, /逐字匹配/);
});

test('empty claim extraction fails closed and requests another evidence turn', async () => {
  const handlers = new Map();
  const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
  registerResearchLoop(pi, { autoSearch: false, verify: async () => ({ claims: [], note: 'No claims found' }) });
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: 'What is the current status?', systemPromptOptions: { sections: {} } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_search', result: { details: { results: [{ url: 'https://source.example/page' }] } } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_open', args: { url: 'https://source.example/page' }, result: { details: { url: 'https://source.example/page', content: 'A current factual passage.' } } });
  const event = await handlers.get('agent_before_settle')({ outcome: 'completed', context: { contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'The current status is active. https://source.example/page' }] }] } });
  assert.equal(event.continue, true);
  assert.match(event.entries[0].content, /没有提取可核验主张/);
});

test('a worker without an independent claim verifier reports provenance as partial, not verified', async () => {
  const handlers = new Map();
  const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
  registerResearchLoop(pi, { autoSearch: false });
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: 'What is the current status?', systemPromptOptions: { sections: {} } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_search', result: { details: { results: [{ url: 'https://source.example/page' }] } } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_open', args: { url: 'https://source.example/page' }, result: { details: { url: 'https://source.example/page', content: 'A current factual passage.' } } });
  const event = await handlers.get('agent_before_settle')({ outcome: 'completed', context: { contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'The current status is active. https://source.example/page' }] }] } });
  assert.equal(event.continue, false);
  assert.match(event.entries[0].content, /partial/);
  assert.doesNotMatch(event.entries[0].content, /verified_sources/);
});

test('research continues past two source pages while evidence makes progress, then settles when supported', async () => {
  const handlers = new Map();
  const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
  let reviewedSources = 0;
  registerResearchLoop(pi, {
    autoSearch: false,
    verify: async ({ sources }) => {
      reviewedSources = sources.length;
      const final = sources.length >= 4;
      return { claims: [{ claim: 'The requested factual claim.', status: final ? 'supported' : 'partial', sources: [sources.at(-1).url], quote: final ? 'supporting source excerpt' : '', reason: final ? '' : '还需要更多来源材料' }] };
    },
  });
  const sections = {};
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: 'What is the current evidence?', systemPromptOptions: { sections } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_search', result: { details: { source: 'test search', searchedAt: 'now', results: [{ url: 'https://source1.example' }] } } });

  let finalEvent;
  for (let index = 1; index <= 4; index++) {
    const url = `https://source${index}.example/page`;
    handlers.get('tool_execution_end')({ toolName: 'kepos_web_open', args: { url }, result: { details: { url, title: `Source ${index}`, content: 'supporting source excerpt', fetchedAt: `read-${index}` } } });
    finalEvent = await handlers.get('agent_before_settle')({
      outcome: 'completed',
      context: { contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: `The claim is under review. https://source1.example/page` }] }] },
    });
    assert.equal(finalEvent.continue, index < 4, `source ${index}: continue only while the claim remains unresolved`);
  }
  assert.equal(reviewedSources, 4);
  assert.match(finalEvent.entries[0].content, /verified_sources/);
});

// 人类裁定：续回合不设硬上限，但从第三轮起提醒收敛，且次数对人类可见。
test('repeated continuations get a convergence reminder and the audit reports the turn count', async () => {
  const handlers = new Map();
  const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
  registerResearchLoop(pi, {
    autoSearch: false,
    verify: async ({ sources }) => {
      const final = sources.length >= 6;
      return { claims: [{ claim: 'The requested factual claim.', status: final ? 'supported' : 'partial', sources: [sources.at(-1).url], quote: final ? 'supporting source excerpt' : '', reason: final ? '' : '还需要更多来源材料' }] };
    },
  });
  const sections = {};
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: 'What is the current evidence?', systemPromptOptions: { sections } });
  handlers.get('tool_execution_end')({ toolName: 'kepos_web_search', result: { details: { source: 'test search', searchedAt: 'now', results: [{ url: 'https://source1.example' }] } } });
  const gates = [];
  let finalEvent;
  for (let index = 1; index <= 6; index++) {
    const url = `https://source${index}.example/page`;
    handlers.get('tool_execution_end')({ toolName: 'kepos_web_open', args: { url }, result: { details: { url, title: `Source ${index}`, content: 'supporting source excerpt', fetchedAt: `read-${index}` } } });
    finalEvent = await handlers.get('agent_before_settle')({
      outcome: 'completed',
      context: { contextMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'The claim is under review. https://source1.example/page' }] }] },
    });
    if (finalEvent.continue) gates.push(finalEvent.entries[0].content);
  }
  assert.equal(gates.length, 5, 'five continuations, then the loop settles');
  assert.doesNotMatch(gates[1], /提示：研究闭环已续/, 'no nagging while continuations are still cheap');
  assert.match(gates[2], /已续 3 次/);
  assert.match(gates[2], /收窄的结论/);
  assert.match(gates[4], /已续 5 次/, 'the counter keeps counting without a cap');
  assert.equal(finalEvent.continue, false);
  assert.match(finalEvent.entries[0].content, /verified_sources/);
  assert.match(finalEvent.entries[0].content, /共续 5 次回合/, 'the human sees the extra turn cost');
});

// Node ≥20 默认 autoSelectFamily：lookup 回调以 all:true 被调用并要求数组返回。
// 0.5.5 固定返回单地址，Node 24 下整个钉 IP 路径抛 "Invalid IP address: undefined"。
test('the pinned lookup honours both Node address contracts', () => {
  const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
  let arrayCall;
  lookup('example.org', { all: true }, (error, addresses) => { arrayCall = { error, addresses }; });
  assert.equal(arrayCall.error, null);
  assert.deepEqual(arrayCall.addresses, [{ address: '93.184.216.34', family: 4 }], 'autoSelectFamily expects an array');
  let tupleCall;
  lookup('example.org', undefined, (error, address, family) => { tupleCall = { error, address, family }; });
  assert.deepEqual(tupleCall, { error: null, address: '93.184.216.34', family: 4 }, 'the classic contract stays a tuple');
});
