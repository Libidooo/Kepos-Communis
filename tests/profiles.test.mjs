import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const isolated = mkdtempSync(join(tmpdir(), 'kepos-profile-history-'));
process.env.ORBITAL_HOME = join(isolated, 'orbital');
const { ProfileHistory, agentRevision } = await import('../dist/terminal/profiles.js');
const { OrbitalDatabase } = await import('../dist/terminal/database.js');
const profile = { id: 'expert', name: 'Expert', model: 'fixture', provider: 'fixture', role: 'Investigate', tools: ['read'] };

test('history deduplicates unchanged configuration and keeps immutable old revisions', () => {
 const db = new OrbitalDatabase(join(isolated, 'versions.sqlite'));
 const history = new ProfileHistory(db);
 const first = history.record(profile);
 const second = history.record({ ...profile, role: 'Review' });
 assert.notEqual(first, second);
 assert.equal(history.record({ ...profile, tools: ['read', 'read'] }), first);
 assert.equal(history.list(profile.id).length, 2);
 assert.equal(history.get(profile.id, first).profile.role, 'Investigate');
 assert.throws(() => db.prepare('UPDATE profile_revisions SET profile=? WHERE agent_id=?').run('{}', profile.id), /immutable/);
 assert.throws(() => history.record({ ...profile, tools: ['bash'] }), /read-only/);
 db.close();
});

test('saving drafts does not create revisions and restoring configuration does not rewrite captured snapshots', async () => {
 const { loadConfig, saveConfig, profileHistory, restoreProfile } = await import('../dist/terminal/store.js');
 const config = loadConfig(); config.agents.push({ ...profile }); saveConfig(config);
 const first = agentRevision(config.agents[0]);
 const captured = structuredClone(config.agents[0]);
 config.agents[0].role = 'Review'; config.agents[0].tools = []; saveConfig(config);
 const beforeRestore = structuredClone(config.agents[0]);
 config.drafts.fixture = 'unsent'; saveConfig(config);
 assert.equal(profileHistory().list(profile.id).length, 2);
 restoreProfile(config, profile.id, first);
 assert.equal(config.agents[0].role, 'Investigate'); assert.deepEqual(config.agents[0].tools, ['read']);
 assert.equal(beforeRestore.role, 'Review'); assert.deepEqual(beforeRestore.tools, []);
 assert.equal(captured.role, 'Investigate'); assert.equal(config.drafts.fixture, 'unsent');
 assert.equal(profileHistory().list(profile.id).length, 2);
});

test('restoring a renamed version cannot collide with another member name', async () => {
 const { loadConfig, saveConfig, restoreProfile } = await import('../dist/terminal/store.js');
 const config = loadConfig(); const first = agentRevision(config.agents[0]);
 config.agents[0].name = 'Renamed'; config.agents.push({ ...profile, id: 'other', name: 'Expert' }); saveConfig(config);
 assert.throws(() => restoreProfile(config, profile.id, first), /名称/);
 assert.equal(config.agents.find(agent => agent.id === profile.id).name, 'Renamed');
});

test('worker defaults respect saved readonly tool presets and preserve the profile revision', async () => {
 const { WorkerPool } = await import('../dist/terminal/workers.js');
 const db = new OrbitalDatabase(join(isolated, 'tool-default.sqlite'));
 let requested;
 const pool = new WorkerPool(db, tools => { requested = tools; throw Error('fixture: do not spawn'); });
 const handle = pool.launch(profile, 'fixture', isolated, 'source', 1, undefined, 'parent');
 assert.deepEqual(requested.tools, ['read']);
 assert.equal(pool.result(handle, 'parent').profileRevision, agentRevision(profile));
 pool.close(); db.close();
});
