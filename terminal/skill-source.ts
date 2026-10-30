import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillHit { id: string; source: string; skillId: string; installs: number; md: string }

/** Search the skills.sh directory and pull each match's SKILL.md (two known nestings). */
export async function skillsShSearch(query: string, limit = 3, timeoutMs = 8000, fetchImpl: typeof fetch = fetch): Promise<SkillHit[]> {
  const headers = { 'user-agent': 'kepos' };
  const search = await fetchImpl('https://www.skills.sh/api/search?q=' + encodeURIComponent(query.slice(0, 60)), { headers, signal: AbortSignal.timeout(timeoutMs) }).then((r: any) => r.json());
  const hits: SkillHit[] = [];
  for (const entry of ((search?.skills || []) as any[]).slice(0, limit)) {
    let md = '';
    for (const path of [entry.skillId + '/SKILL.md', 'skills/' + entry.skillId + '/SKILL.md']) {
      const response = await fetchImpl(`https://raw.githubusercontent.com/${entry.source}/HEAD/${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) { md = await response.text(); break; }
    }
    if (md) hits.push({ id: String(entry.id), source: String(entry.source), skillId: String(entry.skillId), installs: Number(entry.installs || 0), md });
  }
  return hits;
}

/** Install a skill into <agentDir>/skills/<skillId>/; returns the skill directory. */
export function installSkill(hit: SkillHit, agentDir: string): string {
  const dir = join(agentDir, 'skills', hit.skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), hit.md);
  return dir;
}

/** Resolve one unknown skill name online; confident matches install and return the skill directory. */
export async function resolveSkillOnline(name: string, agentDir: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<{ path: string; id: string } | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const hits = await skillsShSearch(name, 5, timeoutMs, fetchImpl).catch(() => [] as SkillHit[]);
  const key = name.toLowerCase().replace(/^skill:/, '');
  const hit = hits.find(item => item.skillId.toLowerCase() === key)
    || hits.find(item => item.id.toLowerCase().endsWith('/' + key))
    || hits.find(item => item.skillId.toLowerCase().includes(key));
  if (!hit) return null;
  const path = installSkill(hit, agentDir);
  return { path, id: hit.id };
}

/** Rank installed skills against the goal; empty result means nothing local matches well. */
export function matchLocalSkills(goal: string, catalog: { name: string; description?: string }[], limit = 3): string[] {
  const text = String(goal || '').toLowerCase();
  if (!text.trim()) return [];
  const terms = text.split(/[^\p{Script=Han}a-zA-Z0-9]+/u).filter(term => term.length >= 2);
  if (!terms.length) return [];
  const scored = catalog.map(skill => {
    const haystack = (skill.name + ' ' + String(skill.description || '')).toLowerCase();
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score += Math.min(4, term.length);
    return { name: skill.name, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(item => item.name);
}
