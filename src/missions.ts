import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliOptions } from './cli/options.ts';
import { activatePaths, preparePaths, type AppPaths } from './config.ts';
import type { MissionRecord, MissionScheduler, MissionWorkerPool } from '../terminal/scheduler.ts';

interface MissionSummary {
  id: string;
  goal: string;
  state: string;
  cwd: string;
  parentSessionId: string;
  updated: number;
  jobs: { id: string; state: string; agent: string; task: string; checkpoint?: string; error?: string; requiresHuman: boolean }[];
}

type MissionOptions = Pick<CliOptions, 'command' | 'args' | 'json'>;

function summarizeMission(mission: MissionRecord): MissionSummary {
  return {
    id: mission.id, goal: mission.goal, state: mission.state, cwd: mission.cwd,
    parentSessionId: mission.parentSessionId, updated: mission.updated,
    jobs: mission.jobs.map(job => ({
      id: job.id, state: job.state, agent: job.agent.name, task: job.task,
      checkpoint: job.checkpoint, error: job.error, requiresHuman: job.requiresHuman,
    })),
  };
}

function printMission(mission: MissionRecord, json = false): void {
  if (json) {
    console.log(JSON.stringify(summarizeMission(mission)));
    return;
  }
  const jobs = mission.jobs.map(job => `  ${job.id}: ${job.state}${job.error ? ' · ' + job.error : ''}`);
  console.log(`${mission.id} · ${mission.state} · ${mission.goal}\n${jobs.join('\n')}`);
}

function selectedMission(scheduler: MissionScheduler, id?: string): MissionRecord {
  if (!id) throw Error('Usage: kepos missions show|events|approve|pause|resume|cancel|run <mission-id> [job-id]');
  const mission = scheduler.get(id);
  if (!mission) throw Error('Unknown mission: ' + id);
  return mission;
}

/** Local human controls can approve a gate; this capability is absent from model tools. */
function applyControl(scheduler: MissionScheduler, mission: MissionRecord, action: string, jobId?: string): boolean {
  const { id, parentSessionId: parent } = mission;
  switch (action) {
    case 'approve': scheduler.approve(id, parent, jobId); return true;
    case 'pause': scheduler.pause(id, parent); return true;
    case 'resume': scheduler.resume(id, parent); return true;
    case 'cancel': scheduler.cancel(id, parent); return true;
    default: return false;
  }
}

async function selectMission(options: MissionOptions, scheduler: MissionScheduler): Promise<MissionRecord | undefined> {
  if (options.command !== 'missions') {
    const file = options.args[0];
    if (!file) throw Error('Usage: kepos supervise <mission.json>');
    const mission = scheduler.enqueue(JSON.parse(await readFile(file, 'utf8')));
    printMission(mission, options.json);
    return mission;
  }
  const [action = 'list', id, jobId] = options.args;
  if (action === 'list') {
    const missions = scheduler.list();
    if (options.json) console.log(JSON.stringify(missions.map(summarizeMission)));
    else if (!missions.length) console.log('No missions.');
    else missions.forEach(mission => printMission(mission));
    return undefined;
  }
  let mission = selectedMission(scheduler, id);
  if (action === 'events') {
    console.log(JSON.stringify(scheduler.events(mission.id, mission.parentSessionId, 0, 100)));
    return undefined;
  }
  if (action === 'show') {
    printMission(mission, options.json);
    return undefined;
  }
  if (applyControl(scheduler, mission, action, jobId)) {
    printMission(scheduler.get(mission.id)!, options.json);
    if (action === 'approve' && !options.json) console.log(`Run with: kepos missions run ${id}`);
    return undefined;
  }
  if (action !== 'run') throw Error('Unknown missions action: ' + action);
  if (mission.state === 'PAUSED') {
    scheduler.resume(mission.id, mission.parentSessionId);
    mission = scheduler.get(mission.id)!;
  }
  return mission;
}

async function watchMission(scheduler: MissionScheduler, mission: MissionRecord, json = false): Promise<void> {
  let previous = '';
  const stoppedStates = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN', 'PAUSED'];
  scheduler.start();
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (scheduler.lastError) throw Error(scheduler.lastError);
    const current = scheduler.get(mission.id, mission.parentSessionId);
    if (!current) throw Error('Mission disappeared');
    const state = JSON.stringify([current.state, current.jobs.map(job => job.state)]);
    if (state !== previous) {
      printMission(current, json);
      previous = state;
    }
    const active = current.jobs.some(job => job.state === 'RUNNING');
    if (stoppedStates.includes(current.state) && !active) return;
  }
}

export async function missionCommand(options: MissionOptions, paths: AppPaths): Promise<void> {
  preparePaths(paths);
  activatePaths(paths);
  const { OrbitalDatabase } = await import('../terminal/database.ts');
  const { WorkerPool } = await import('../terminal/workers.ts');
  const { MissionScheduler } = await import('../terminal/scheduler.ts');
  const database = new OrbitalDatabase(join(paths.dataDir, 'orbital.sqlite'));
  const readPool: MissionWorkerPool = {
    launch() { throw Error('A read-only mission control cannot launch workers'); },
    result() { return { state: 'UNKNOWN_HANDLE' }; },
    cancelHandle() { return { state: 'UNKNOWN_HANDLE' }; },
  };
  let scheduler = new MissionScheduler(database, readPool);
  try {
    const mission = await selectMission(options, scheduler);
    if (!mission) return;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(mission.state)) {
      printMission(mission, options.json);
      return;
    }
    scheduler.stop();
    const pool = new WorkerPool(database);
    scheduler = new MissionScheduler(database, pool, { missionIds: [mission.id] });
    function stop(): void {
      scheduler.pause(mission!.id, mission!.parentSessionId);
      pool.close();
    }
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await watchMission(scheduler, mission, options.json);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await pool.shutdown();
      await scheduler.tick();
      scheduler.stop();
    }
  } finally {
    scheduler.stop();
    database.close();
  }
}
