import { needsMarketResearch } from './worker-contract.ts';

export type ResearchRouteKind = 'live_external' | 'external_knowledge' | 'project' | 'local_file' | 'provided_material' | 'creative' | 'chat';
export type RouteConfidence = 'high' | 'medium' | 'low';
export type ResearchRoute = {
  kind: ResearchRouteKind;
  sources: string[];
  reason: string;
  explicit: boolean;
  confidence: RouteConfidence;
  requiresEvidence: boolean;
  query: string;
  method?: 'rules' | 'model';
  classifierError?: string;
};
export type ResearchClassification = { kind: ResearchRouteKind; reason: string; confidence?: RouteConfidence };

const has = (text: string, pattern: RegExp) => pattern.test(text);

/**
 * A deterministic high-recall fallback for route selection. Explicit user scope
 * wins, and the result always carries an explanation so callers can expose it.
 * The model classifier may refine this result, but cannot widen permissions.
 */
export function routeResearchIntent(input: string, options: { hasAttachment?: boolean } = {}): ResearchRoute {
  const text = String(input || '').trim();
  const lower = text.toLowerCase();
  const make = (kind: ResearchRouteKind, sources: string[], reason: string, explicit = false, requiresEvidence = true, confidence: RouteConfidence = explicit ? 'high' : requiresEvidence ? 'medium' : 'high'): ResearchRoute => ({
    kind, sources, reason, explicit, confidence, requiresEvidence, query: text.slice(0, 500), method: 'rules',
  });
  if (!text && !options.hasAttachment) return make('chat', [], '没有可检索的任务内容。', false, false);

  if (has(lower, /(?:不要|别|勿)(?:联网|搜索网页|查网络)|仅(?:根据|使用)(?:我提供|附件|这份材料|本地文件)|只(?:看|查)(?:本地|项目|仓库|附件)|no web|offline only|use only (?:the )?(?:provided|attached|local)/i)) {
    if (options.hasAttachment || has(lower, /附件|提供的材料|这份材料|attached|provided material/i)) return make('provided_material', ['user_material'], '用户明确要求仅依据已提供材料。', true);
    if (has(lower, /(?:本地文件|文件夹|桌面|简历|文档|local file|resume|document)/i)) return make('local_file', ['local_files'], '用户明确要求只查本机文件。', true);
    return make('project', ['project_files'], '用户明确限制为本地项目资料。', true);
  }
  if (has(lower, /(?:优先|只用|必须用)(?:官方|一手|primary|official)(?:来源|资料|source)/i)) {
    return make('external_knowledge', ['official_web'], '用户指定优先使用官方或一手来源。', true);
  }
  if (has(lower, /(?:打开|查找|找到|搜索|读取|读一下).{0,30}(?:简历|履历|文件|文档|文件夹)|(?:简历|履历|文件|文档).{0,25}(?:路径|在哪|打开|读取)|(?:open|find|locate|read).{0,30}(?:file|resume|document)/i)) {
    return make('local_file', ['local_files'], '请求目标是用户机器上的文件；先定位并读取文件。', false, true, 'high');
  }
  if (has(lower, /(?:kepos|本地|我们的(?:项目|工程|仓库|代码)|这个(?:项目|工程|仓库|代码)|本项目|本工程|本仓库|项目里的|仓库里的|代码中的|源码|文件|函数|报错|堆栈|补丁|commit|repository|codebase|source code|stack trace)/i)) {
    return make('project', ['project_files'], '请求询问项目或代码；先检索工作区文件与运行记录。', false, true, 'high');
  }
  if (has(lower, /(?:股票|股价|行情|证券|汇率|外汇|加密货币|crypto|stock|ticker|quote|market price|exchange rate|weather|天气|今天|今日|现在|目前|当前|最新|近期|实时|新闻|breaking|this week|this month|as of|right now)/i)) {
    const finance = has(lower, /(?:股票|股价|行情|证券|stock|ticker|quote|market price|英特尔|英伟达|苹果|特斯拉|nvda|aapl|tsla|intc)/i);
    const material = options.hasAttachment || has(lower, /(?:附件|附上的|上传的|这张图|这份材料|这段文字|attached file|uploaded file|attached image)/i);
    return make('live_external', [...(material ? ['user_material'] : []), ...(finance ? ['market_data', 'official_web', 'source_pages'] : ['web_search', 'source_pages'])],
      finance ? '请求涉及会变化的市场数据；先检查随附材料（如有），再优先查结构化行情并打开来源页。' : '请求涉及会变化的外部事实；先检查随附材料（如有），再实时检索并打开来源页。', false, true, 'high');
  }
  if (options.hasAttachment || has(lower, /(?:附件|附上的|上传的|这张图|这份材料|这段文字|attached file|uploaded file|attached image)/i)) {
    return make('provided_material', ['user_material'], '请求包含或指向用户提供的材料；先读取材料本身。', false, true, 'high');
  }
  if (has(lower, /(?:你好|您好|嗨|谢谢|辛苦了|再见|hi\b|hello\b|thanks\b|good morning\b|good night\b)/i) && !/[?？]/.test(text)) {
    return make('chat', [], '这是社交性对话，不需要外部资料。', false, false, 'high');
  }
  if (has(lower, /(?:写一首|写个故事|创作|编一个|润色|改写|翻译|起草|脑暴|brainstorm|write a poem|write a story|rewrite|translate|draft)/i)) {
    return make('creative', [], '这是创作或文本处理任务；默认直接完成，只有用户要求核事实时再检索。', false, false, 'high');
  }
  if (/[?？]/.test(text) || has(lower, /\b(?:what|why|how|who|where|when|which|explain|describe|compare|difference|background|definition|history)\b/i) ||
      has(lower, /(?:是什么|为什么|如何|怎么(?:做|用|回事|样)?|谁(?:是|在|负责)?|哪里|何时|哪个|哪些|多少|是否|有没有|请(?:介绍|解释|说明|比较|分析)|介绍一下|解释一下|说明一下|区别|差异|背景|历史|原理|原因|影响|现状|定义|数据来源)/i)) {
    return make('external_knowledge', ['web_search', 'source_pages'], '这是外部事实或解释性问题；先检索来源，再按证据充分程度决定是否继续。');
  }
  return make('chat', [], '未发现明确的事实检索意图；按普通对话处理。若你的问题涉及具体事实，可在消息中指定“联网核实”“查项目”或“只根据附件”。', false, false, 'low');
}

/** Apply a constrained model classification; explicit user scope always wins. */
export function applyResearchClassification(base: ResearchRoute, classification: ResearchClassification, hasMaterial = false): ResearchRoute {
  if (base.explicit) return base;
  if (!classification || !['live_external', 'external_knowledge', 'project', 'local_file', 'provided_material', 'creative', 'chat'].includes(classification.kind)) return base;
  const classifiedConfidence = classification.confidence || 'medium';
  // A low-confidence classifier may widen a route to include evidence, but it
  // cannot silently turn an evidence-required question into casual conversation.
  if (base.requiresEvidence && ['creative', 'chat'].includes(classification.kind) && classifiedConfidence !== 'high') return base;
  const material = hasMaterial || base.sources.includes('user_material');
  let kind = classification.kind;
  // A creative request based on an attachment still depends on reading that material.
  if (material && kind === 'creative') kind = 'provided_material';
  const finance = needsMarketResearch(base.query);
  const sources = kind === 'live_external'
    ? [...(material ? ['user_material'] : []), ...(finance ? ['market_data', 'official_web', 'source_pages'] : ['web_search', 'source_pages'])]
    : kind === 'external_knowledge' ? [...(material ? ['user_material'] : []), 'web_search', 'source_pages']
    : kind === 'project' ? [...(material ? ['user_material'] : []), 'project_files']
    : kind === 'local_file' ? ['local_files']
    : kind === 'provided_material' ? ['user_material']
    : [];
  const requiresEvidence = ['live_external', 'external_knowledge', 'project', 'local_file', 'provided_material'].includes(kind);
  return {
    ...base,
    kind,
    sources,
    reason: String(classification.reason || '模型根据请求内容分类资料来源').slice(0, 300),
    confidence: ['high', 'medium', 'low'].includes(String(classifiedConfidence)) ? classifiedConfidence : 'medium',
    requiresEvidence,
    method: 'model',
    classifierError: undefined,
  };
}

export function parseResearchClassification(raw: string): ResearchClassification {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: any;
  try { value = JSON.parse(text); }
  catch {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw Error('意图分类器没有返回 JSON');
    try { value = JSON.parse(text.slice(start, end + 1)); }
    catch { throw Error('意图分类器返回了无效 JSON'); }
  }
  const kinds: ResearchRouteKind[] = ['live_external', 'external_knowledge', 'project', 'local_file', 'provided_material', 'creative', 'chat'];
  if (!kinds.includes(value?.kind)) throw Error('意图分类器返回了未知资料路由');
  const reason = String(value.reason || '').trim().slice(0, 300);
  if (!reason) throw Error('意图分类器没有说明路由原因');
  const confidence = ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence as RouteConfidence : 'medium';
  return { kind: value.kind, reason, confidence };
}

export type ResearchEvidence = { kind: string; source?: string; url?: string; title?: string; retrievedAt?: string; dataAt?: string; excerpt?: string; coverage?: 'complete' | 'partial'; resultCount?: number; ok: boolean; error?: string };

export function citationUrls(answer: string): string[] {
  const candidates = [...String(answer || '').matchAll(/https?:\/\/[^\s\])}>"']+/g)].map(match => match[0].replace(/[.,;:!?，。；：！？]+$/, ''));
  return [...new Set(candidates)];
}

/** Deterministic provenance checks. This validates source use/citations, not semantic entailment. */
export function checkResearchProvenance(route: ResearchRoute, evidence: ResearchEvidence[], answer: string): { ready: boolean; missing: string[]; cited: string[]; uncitedSources: string[] } {
  if (!route.requiresEvidence) return { ready: true, missing: [], cited: [], uncitedSources: [] };
  const successful = evidence.filter(item => item.ok);
  const missing: string[] = [];
  if (route.sources.includes('web_search') || route.sources.includes('official_web') || route.sources.includes('market_data')) {
    const searched = successful.some(item => item.kind === 'web_search');
    const opened = successful.filter(item => item.kind === 'web_open' && item.url);
    const quoted = successful.some(item => item.kind === 'market_quote');
    if (!searched && !quoted) missing.push('尚无成功的实时搜索或结构化行情记录');
    if (!opened.length && !quoted) missing.push('搜索摘要不是证据；尚未读取来源页或结构化行情');
    const cited = citationUrls(answer);
    const sourceUrls = new Set([
      ...opened.map(item => item.url),
      ...successful.filter(item => item.kind === 'market_quote' && item.url).map(item => item.url),
    ]);
    if (cited.length === 0 && sourceUrls.size) missing.push('回答没有引用已读取来源的链接');
    const uncitedSources = cited.filter(url => ![...sourceUrls].some(source => url === source || url.startsWith(source + '#') || url.startsWith(source + '?')));
    if (uncitedSources.length) missing.push('回答包含本轮未读取的引用链接');
    if (route.sources.includes('user_material') && !successful.some(item => item.kind === 'user_material' || item.kind === 'file_read')) missing.push('请求包含用户材料，但本轮尚未读取该材料');
    return { ready: missing.length === 0, missing, cited, uncitedSources };
  }
  if (route.kind === 'local_file') {
    if (successful.some(item => item.kind === 'file_read')) return { ready: true, missing, cited: citationUrls(answer), uncitedSources: [] };
    const completeEmptySearch = successful.some(item => item.kind === 'file_search' && item.coverage === 'complete' && item.resultCount === 0);
    if (!completeEmptySearch) missing.push(successful.some(item => item.kind === 'file_search') ? '已定位候选文件或搜索范围不完整；尚未读取文件，不能断言找不到' : '尚未定位或读取本机文件');
  }
  if (route.kind === 'project' && !successful.some(item => item.kind === 'project_read')) missing.push('尚未读取项目或代码证据');
  if (route.kind === 'provided_material' && !successful.some(item => item.kind === 'user_material')) missing.push('尚未检查用户提供的材料');
  return { ready: missing.length === 0, missing, cited: citationUrls(answer), uncitedSources: [] };
}

export function renderResearchAudit(route: ResearchRoute, evidence: ResearchEvidence[], verdict: 'verified_sources' | 'partial' | 'failed' | 'not_required') {
  const lines = [`资料记录：${route.kind}；路由置信度 ${route.confidence}；${verdict}；${route.reason}`];
  for (const item of evidence) {
    if (item.kind === 'web_search') {
      lines.push(item.ok ? `检索状态：成功；检索时间 ${item.retrievedAt || '未记录'}；${item.excerpt || '搜索结果仅作线索'}` : `检索状态：失败；${item.error || '未提供错误详情'}`);
    } else if (item.ok) lines.push(`来源：${item.title || item.url || item.source || item.kind}${item.dataAt ? `；数据时间 ${item.dataAt}` : ''}${item.retrievedAt ? `；检索/读取时间 ${item.retrievedAt}` : ''}${item.url ? `；${item.url}` : ''}`);
    else lines.push(`检索失败：${item.source || item.kind}；${item.error || '未提供错误详情'}`);
  }
  if (!evidence.some(item => item.ok && item.kind !== 'web_search') && route.requiresEvidence) lines.push('结论依据不足，当前回答必须明确降级，不得将搜索摘要或记忆表述为已核验事实。');
  return lines.join('\n');
}
