import test from 'node:test';
import assert from 'node:assert/strict';

const { routeResearchIntent, checkResearchProvenance, citationUrls } = await import('../dist/terminal/research-router.js');
const { parseAnswerAudit, registerResearchLoop } = await import('../dist/terminal/research-loop.js');
const { parseBraveSearchResponse, parseFinnhubQuote } = await import('../dist/terminal/web-research.js');

test('intent routing distinguishes project, local files, current facts, provided material, and chat', () => {
  assert.equal(routeResearchIntent('检查我们 Kepos 仓库里的启动逻辑').kind, 'project');
  assert.equal(routeResearchIntent('打开简历文件').kind, 'local_file');
  assert.equal(routeResearchIntent('查看今天英特尔的股票行情').kind, 'live_external');
  assert.equal(routeResearchIntent('根据附件总结这份材料', { hasAttachment: true }).kind, 'provided_material');
  assert.equal(routeResearchIntent('谢谢').requiresEvidence, false);
  assert.equal(routeResearchIntent('不要联网，只根据附件回答', { hasAttachment: true }).explicit, true);
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

test('research continues past two source pages while evidence makes progress, then settles when supported', async () => {
  const handlers = new Map();
  const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
  let reviewedSources = 0;
  registerResearchLoop(pi, {
    autoSearch: false,
    verify: async ({ sources }) => {
      reviewedSources = sources.length;
      const final = sources.length >= 4;
      return { claims: [{ claim: 'The requested factual claim.', status: final ? 'supported' : 'partial', sources: [sources.at(-1).url], quote: final ? 'supporting text' : '', reason: final ? '' : '还需要更多来源材料' }] };
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
