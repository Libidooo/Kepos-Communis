import { Type } from '@earendil-works/pi-ai';
import { webSearch } from './web-research.ts';
import { applyResearchClassification, checkResearchProvenance, renderResearchAudit, routeResearchIntent, type ResearchClassification, type ResearchEvidence, type ResearchRoute } from './research-router.ts';

export type ClaimAudit = { claim: string; status: 'supported' | 'partial' | 'unsupported'; sources: string[]; quote?: string; reason?: string };
export type AnswerAudit = { claims: ClaimAudit[]; status: 'supported' | 'partial' | 'unsupported'; note?: string };
export type ResearchVerifier = (input: { question: string; answer: string; sources: Array<Pick<ResearchEvidence, 'source' | 'url' | 'title' | 'dataAt' | 'retrievedAt' | 'excerpt'>> }) => Promise<AnswerAudit>;
type ActiveResearch = { route: ResearchRoute; evidence: ResearchEvidence[]; continuations: number; lastContinuationSignature?: string; audit?: AnswerAudit; query: string };

function textOf(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => item?.type === 'text' ? String(item.text || '') : '').join('\n');
  return '';
}

function resultDetails(result: any): any {
  if (result?.details !== undefined) return result.details;
  const text = textOf(result?.content);
  try { return JSON.parse(text); } catch { return { content: text }; }
}

function modelAnswer(messages: any[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const value = message.content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text || '')).join('\n').trim();
    if (value) return value;
  }
  return '';
}

function normalizeAudit(value: any): AnswerAudit | undefined {
  if (!value || !Array.isArray(value.claims)) return undefined;
  const claims: ClaimAudit[] = value.claims.filter((claim: any) => claim && typeof claim.claim === 'string').map((claim: any) => ({
    claim: String(claim.claim).slice(0, 500),
    status: ['supported', 'partial', 'unsupported'].includes(claim.status) ? claim.status : 'unsupported',
    sources: Array.isArray(claim.sources) ? claim.sources.map(String).slice(0, 8) : [],
    ...(typeof claim.quote === 'string' ? { quote: claim.quote.slice(0, 500) } : {}),
    ...(typeof claim.reason === 'string' ? { reason: claim.reason.slice(0, 300) } : {}),
  }));
  const status = claims.some(item => item.status === 'unsupported') ? 'unsupported' : claims.some(item => item.status === 'partial') ? 'partial' : 'supported';
  return { claims, status, ...(typeof value.note === 'string' ? { note: value.note.slice(0, 400) } : {}) };
}

function auditText(audit: AnswerAudit): string {
  if (!audit.claims.length) return `逐条核验未能提取事实主张：${audit.note || '请谨慎使用本轮结论。'}`;
  return audit.claims.map(item => `- [${item.status}] ${item.claim}${item.sources.length ? `（依据：${item.sources.join('、')}）` : '（无可用来源）'}${item.quote ? `：“${item.quote}”` : ''}${item.reason ? `；${item.reason}` : ''}`).join('\n');
}

function normalizedEvidenceText(value: string): string {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/** Deterministically check that a verifier's quote is present in the cited retrieved excerpt. */
export function quoteMatchesRetrievedEvidence(quote: unknown, excerpts: readonly string[]): boolean {
  const needle = normalizedEvidenceText(String(quote || ''));
  if (needle.length < 8) return false;
  return excerpts.some(excerpt => normalizedEvidenceText(excerpt).includes(needle));
}

/**
 * A continuation is useful only when its unresolved evidence state changes.
 * This lets research continue for as many useful source/claim updates as needed,
 * while stopping a model that repeats the same unsupported answer indefinitely.
 */
export function researchContinuationSignature(provenance: { ready: boolean; missing: string[]; cited: string[]; uncitedSources: string[] }, evidence: ResearchEvidence[], audit?: AnswerAudit): string {
  if (provenance.ready && audit) return JSON.stringify(audit.claims.map(item => ({
    claim: item.claim.toLowerCase().replace(/\s+/g, ' ').trim(),
    status: item.status,
    sources: [...item.sources].sort(),
  })).sort((a, b) => a.claim.localeCompare(b.claim)));
  return JSON.stringify({
    missing: [...provenance.missing].sort(),
    cited: [...provenance.cited].sort(),
    uncitedSources: [...provenance.uncitedSources].sort(),
    evidence: evidence.map(item => `${item.kind}:${item.ok ? 'ok' : 'failed'}:${item.url || item.source || ''}`).sort(),
  });
}

/**
 * The runtime half of research: route the request, keep tool provenance, and use
 * Pi's before-settle boundary to request another model/tool turn when evidence or
 * claim verification is missing. This is deliberately not just system-prompt text.
 */
export function registerResearchLoop(pi: any, options: { verify?: ResearchVerifier; classify?: (input: { query: string; fallback: ResearchRoute }) => Promise<ResearchClassification>; autoSearch?: boolean } = {}) {
  let active: ActiveResearch | undefined;
  const append = (item: ResearchEvidence) => { if (active) active.evidence.push(item); };
  const toolFailure = (event: any, kind: string) => append({ kind, ok: false, source: event.toolName, error: String(event.result?.content?.[0]?.text || 'tool failed').slice(0, 600), retrievedAt: new Date().toISOString() });

  pi.registerTool({
    name: 'kepos_research_status', label: '研究路由与证据状态',
    description: '查看本轮自动路由为何选择资料来源、已检索/读取的来源与时间、事实主张逐条核验状态。只能报告运行时实际观察到的记录。',
    parameters: Type.Object({}),
    async execute() {
      if (!active) return { content: [{ type: 'text', text: '本轮没有研究路由记录。' }] };
      const data = { route: active.route, evidence: active.evidence, claimAudit: active.audit };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data };
    },
  });

  pi.on('before_agent_start', async (event: any) => {
    if (event?.messageType !== 'user') return;
    const prompt = String(event.prompt || '').trim();
    const hasMaterial = Boolean(event.images?.length) || /<file\s+name=/i.test(prompt);
    const requestText = prompt.split(/<file\s+name=/i)[0].trim() || prompt.slice(0, 500);
    let route = routeResearchIntent(requestText, { hasAttachment: hasMaterial });
    if (!route.explicit && route.confidence !== 'high' && options.classify && requestText.length <= 800) {
      try {
        route = applyResearchClassification(route, await options.classify({ query: requestText, fallback: route }), hasMaterial);
      } catch (error) {
        route = { ...route, classifierError: String((error as Error)?.message || error).slice(0, 300) };
      }
    }
    active = { route, evidence: [], continuations: 0, query: requestText };
    if (hasMaterial) active.evidence.push({ kind: 'user_material', source: 'user attachment', ok: true, retrievedAt: new Date().toISOString(), excerpt: event.images?.length ? `${event.images.length} image attachment(s) supplied by the user` : prompt.slice(0, 6000) });
    const sections = event.systemPromptOptions?.sections;
    if (!sections) return;
    sections.kepos_research_route = `RESEARCH ROUTE: ${route.kind}; method=${route.method || 'rules'}; confidence=${route.confidence}; sources=${route.sources.join(', ') || 'none'}; reason=${route.reason}; user override=${route.explicit ? 'yes' : 'no'}${route.classifierError ? `; classifier error=${route.classifierError}` : ''}. This route is adjustable by explicit scope in the user's request. Evidence-required routes must use the named sources before finalizing. The runtime checks tool provenance and citations, and runs an independent claim/source audit when available.\nUser request is not automatically sent to a public search provider unless the route selects public web.`;
    if (route.kind === 'provided_material' && /(?:根据以下|根据下文|根据我提供|以下材料|下面这段|based on the following|based on this text)/i.test(prompt)) {
      active.evidence.push({ kind: 'user_material', source: 'user-provided prompt material', ok: true, retrievedAt: new Date().toISOString(), excerpt: prompt.slice(0, 6000) });
    }
    if (options.autoSearch !== false && (route.kind === 'live_external' || route.kind === 'external_knowledge') && requestText.length <= 800 &&
        !/(?:api[_ -]?key|access token|password|密钥|密码|身份证号|银行卡号|\b\d{15,19}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(requestText)) {
      try {
        const search = await webSearch(requestText, 10);
        append({ kind: 'web_search', source: search.source, ok: true, retrievedAt: search.searchedAt, excerpt: `${search.results.length} search leads returned; leads are not source evidence.` });
        sections.kepos_auto_research = `Search status=success; provider=${search.source}; retrievedAt=${search.searchedAt}. Search hits are leads only. Open relevant source pages, run additional queries if evidence is incomplete, then cite the pages actually read.\n${JSON.stringify(search.results)}`;
      } catch (error) {
        const message = String((error as Error)?.message || error);
        const provider = String(process.env.KEPOS_WEB_SEARCH_PROVIDER || (process.env.KEPOS_BRAVE_SEARCH_API_KEY ? 'brave' : 'duckduckgo')).toLowerCase();
        append({ kind: 'web_search', source: provider === 'brave' ? 'Brave Search API' : 'DuckDuckGo HTML Search', ok: false, error: message, retrievedAt: new Date().toISOString() });
        sections.kepos_auto_research = `Search status=failed; error=${message}. Do not state that current facts were verified. Try the configured alternate research tool/provider if available; otherwise explicitly downgrade the answer.`;
      }
    }
  });

  pi.on('tool_execution_end', (event: any) => {
    if (!active) return;
    const name = String(event?.toolName || '');
    const details = resultDetails(event?.result);
    const ok = !event?.isError && event?.result?.isError !== true;
    if (!ok) {
      const kind = name.includes('web_search') ? 'web_search' : name.includes('web_open') ? 'web_open' : name.includes('find_file') ? 'file_search' : name.includes('attach') ? 'file_read' : name === 'read' || name === 'grep' || name === 'find' || name === 'ls' ? 'project_read' : name.includes('market_quote') ? 'market_quote' : '';
      if (kind) toolFailure(event, kind);
      return;
    }
    if (name === 'kepos_web_search') append({ kind: 'web_search', source: details?.source || 'configured web search', ok: true, retrievedAt: details?.searchedAt || new Date().toISOString(), excerpt: `${details?.results?.length || 0} search leads returned` });
    else if (name === 'kepos_web_open') append({ kind: 'web_open', source: details?.source || details?.title || details?.url, url: details?.url || event.args?.url, title: details?.title, dataAt: details?.publishedAt, retrievedAt: details?.fetchedAt || new Date().toISOString(), excerpt: String(details?.content || '').slice(0, 6000), ok: Boolean(details?.url || event.args?.url) });
    else if (name === 'kepos_market_quote') append({ kind: 'market_quote', source: details?.source || 'structured market data', url: details?.sourceUrl, title: details?.symbol ? `${details.symbol} structured quote` : 'structured market quote', dataAt: details?.dataAt, retrievedAt: details?.retrievedAt || new Date().toISOString(), excerpt: JSON.stringify(details).slice(0, 6000), ok: Boolean(details?.symbol && Number.isFinite(Number(details?.price))) });
    else if (name === 'kepos_find_file') append({ kind: 'file_search', source: 'kepos_find_file', ok: true, coverage: details?.coverage === 'complete' ? 'complete' : 'partial', resultCount: Array.isArray(details?.results) ? details.results.length : 0, retrievedAt: new Date().toISOString(), excerpt: JSON.stringify(details || {}).slice(0, 5000) });
    else if (name === 'kepos_attach') {
      const files = Array.isArray(details?.results) ? details.results : [];
      for (const file of files) append({ kind: file?.ok ? 'file_read' : 'file_read', source: file?.path || 'kepos_attach', url: file?.path, title: file?.name, retrievedAt: new Date().toISOString(), excerpt: String(file?.content || '').slice(0, 6000), ok: file?.ok !== false, ...(file?.reason ? { error: file.reason } : {}) });
      if (!files.length) append({ kind: 'file_read', source: 'kepos_attach', ok: true, retrievedAt: new Date().toISOString(), excerpt: textOf(event.result?.content).slice(0, 6000) });
    }
    else if (['read', 'grep', 'find', 'ls'].includes(name)) append({ kind: 'project_read', source: name, url: event.args?.path || event.args?.pattern, retrievedAt: new Date().toISOString(), excerpt: textOf(event.result?.content).slice(0, 6000), ok: true });
  });

  pi.on('agent_before_settle', async (event: any) => {
    if (!active || event?.outcome !== 'completed') return;
    const answer = modelAnswer(event?.context?.contextMessages || []);
    if (!answer) return;
    const provenance = checkResearchProvenance(active.route, active.evidence, answer);
    const eligible = provenance.ready && active.route.requiresEvidence && Boolean(options.verify);
    if (eligible) {
      try {
        const sources = active.evidence.filter(item => item.ok && item.excerpt && item.kind !== 'web_search').map(({ source, url, title, dataAt, retrievedAt, excerpt }) => ({ source, url, title, dataAt, retrievedAt, excerpt: excerpt?.slice(0, 6000) }));
        active.audit = normalizeAudit(await options.verify!({ question: active.query, answer, sources }));
        if (active.audit) {
          if (!active.audit.claims.length) {
            active.audit = {
              status: 'partial',
              claims: [{ claim: '回答中的事实主张覆盖', status: 'partial', sources: [], reason: '核验器没有提取可核验主张，不能确认回答已逐条接受来源审阅' }],
              note: active.audit.note || '事实主张覆盖未能核验',
            };
          }
          active.audit.claims = active.audit.claims.map(claim => {
            const matchedSources = sources.filter(source => claim.sources.some(reference => reference === source.url || reference === source.source));
            const hasRetrievedSource = matchedSources.length > 0;
            const quotePresent = quoteMatchesRetrievedEvidence(claim.quote, matchedSources.map(source => String(source.excerpt || '')));
            if (claim.status === 'supported' && (!hasRetrievedSource || !quotePresent)) return {
              ...claim,
              status: 'partial',
              reason: !hasRetrievedSource ? claim.reason || '核验器引用的来源不在本轮已读取来源中' : claim.reason || '核验器引文未能在所引用来源的已读取摘录中逐字匹配',
            };
            return claim;
          });
          if (active.audit.claims.some(claim => claim.status === 'unsupported')) active.audit.status = 'unsupported';
          else if (active.audit.claims.some(claim => claim.status === 'partial')) active.audit.status = 'partial';
        }
      } catch (error) {
        active.audit = { status: 'partial', claims: [], note: `独立事实核验失败：${String((error as Error)?.message || error).slice(0, 300)}` };
      }
    }
    const unsupported = active.audit?.claims.filter(item => item.status !== 'supported') || [];
    const needsAnotherTurn = !provenance.ready || unsupported.length > 0 || (eligible && !active.audit);
    const continuationSignature = needsAnotherTurn ? researchContinuationSignature(provenance, active.evidence, active.audit) : '';
    const evidenceProgressed = Boolean(continuationSignature) && continuationSignature !== active.lastContinuationSignature;
    if (needsAnotherTurn && evidenceProgressed) {
      active.lastContinuationSignature = continuationSignature;
      active.continuations++;
      const next = provenance.missing.length ? `缺少：${provenance.missing.join('；')}` : `事实核验发现以下主张缺少来源支持：\n${auditText(active.audit!)}`;
      // 软提醒（人类裁定：不设硬上限）。续到第三轮还收不拢，多半是缺口本身补不上——
      // 提醒模型收窄结论并标注未核实部分，而不是为了凑核验继续空转烧钱。
      const remind = active.continuations >= 3 ? `\n提示：研究闭环已续 ${active.continuations} 次。若现有证据足以支撑一个收窄的结论，请直接给出最终回答并明确标注未核实部分；不要为了凑核验而继续空转。` : '';
      return { entries: [{ type: 'custom_message', customType: 'kepos_research_gate', content: `研究闭环要求继续：${next}${remind}\n请补充来源或收窄/限定结论，再完成回答。`, display: false }], continue: true };
    }
    const status = !active.route.requiresEvidence ? 'not_required' : active.evidence.some(item => item.ok) && provenance.ready && active.audit?.status === 'supported' ? 'verified_sources' : active.evidence.some(item => item.ok) ? 'partial' : 'failed';
    const audit = renderResearchAudit(active.route, active.evidence, status);
    const claimReport = active.audit ? `\n逐条主张核验（独立模型审阅，非数学证明）：\n${auditText(active.audit)}` : '';
    const citationReport = provenance.uncitedSources.length ? `\n未在本轮读取的引用：${provenance.uncitedSources.join('、')}` : '';
    const closing = needsAnotherTurn ? '\n闭环未通过：证据或引用仍不完整。上方回答不得被理解为已核验。' : '';
    // 续回合次数对人类可见：这是本回合为满足闭环付出的额外轮次成本。
    const continuationReport = active.continuations > 0 ? `\n本轮为满足研究闭环共续 ${active.continuations} 次回合。` : '';
    return { entries: [{ type: 'custom_message', customType: 'kepos_research_audit', content: `${audit}${claimReport}${citationReport}${continuationReport}${closing}`, display: true }], continue: false };
  });
}

export function parseAnswerAudit(raw: string): AnswerAudit | undefined {
  let value: any;
  try { value = JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return undefined; }
  return normalizeAudit(value);
}
