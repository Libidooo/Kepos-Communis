import type { OrbitalDatabase } from './database.ts';
import { profileRevision, READ_ONLY_TOOLS } from './worker-contract.ts';

export interface AgentProfile {
  id: string;
  name: string;
  model: string;
  provider: string;
  role: string;
  roleKey?: string;
  tools?: string[];
  skills?: string[];
}

export interface ProfileRevision {
  agentId: string;
  revision: string;
  created: number;
  profile: AgentProfile;
}

function canonicalProfile(profile: AgentProfile): AgentProfile {
  const tools = [...new Set(profile.tools ?? READ_ONLY_TOOLS)].sort();
  if (tools.some(tool => !(READ_ONLY_TOOLS as readonly string[]).includes(tool))) throw Error('Profile tools must be read-only');
  const skills = [...new Set((profile.skills ?? []).filter(skill => typeof skill === 'string' && skill.trim()).map(skill => skill.trim()))].sort();
  const canonical: AgentProfile = {
    id: profile.id,
    name: profile.name,
    model: profile.model,
    provider: profile.provider || '',
    role: profile.role,
    tools,
  };
  if (profile.roleKey) canonical.roleKey = profile.roleKey;
  if (skills.length) canonical.skills = skills;
  return canonical;
}

export function agentRevision(profile: AgentProfile): string {
  const value = canonicalProfile(profile);
  return profileRevision({ name: value.name, model: value.model, provider: value.provider, role: value.role, roleKey: value.roleKey, tools: value.tools!, skills: value.skills ?? [], mcp: false });
}

/** Revision history belongs to a stable profile ID; deleting a member keeps its history. */
export class ProfileHistory {
  constructor(private readonly database: OrbitalDatabase) {
    database.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile_revisions(
        agent_id TEXT NOT NULL, revision TEXT NOT NULL, created INTEGER NOT NULL,
        profile TEXT NOT NULL, PRIMARY KEY(agent_id,revision)
      );
      CREATE INDEX IF NOT EXISTS profile_history_order ON profile_revisions(agent_id,created);
      CREATE TRIGGER IF NOT EXISTS immutable_profile_revision
      BEFORE UPDATE ON profile_revisions
      BEGIN SELECT RAISE(ABORT,'profile revision is immutable'); END;
    `);
  }

  record(profile: AgentProfile): string {
    const canonical = canonicalProfile(profile);
    const revision = agentRevision(canonical);
    const encoded = JSON.stringify(canonical);
    const known = this.get(profile.id, revision);
    if (known) {
      if (JSON.stringify(known.profile) !== encoded) throw Error('Profile revision content conflict');
      return revision;
    }
    this.database.transaction(() => {
      this.database.prepare('INSERT OR IGNORE INTO profile_revisions VALUES(?,?,?,?)')
        .run(profile.id, revision, Date.now(), encoded);
      const existing = this.get(profile.id, revision);
      if (!existing || JSON.stringify(existing.profile) !== encoded) throw Error('Profile revision content conflict');
    });
    return revision;
  }

  list(agentId: string): ProfileRevision[] {
    const rows = this.database.prepare('SELECT * FROM profile_revisions WHERE agent_id=? ORDER BY created DESC,rowid DESC').all(agentId) as any[];
    return rows.map(decodeRevision);
  }

  get(agentId: string, revision: string): ProfileRevision | undefined {
    const row = this.database.prepare('SELECT * FROM profile_revisions WHERE agent_id=? AND revision=?').get(agentId, revision);
    if (row) return decodeRevision(row);
    return undefined;
  }
}

function decodeRevision(row: any): ProfileRevision {
  return { agentId: row.agent_id, revision: row.revision, created: row.created, profile: JSON.parse(row.profile) };
}
