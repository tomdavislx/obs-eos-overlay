/// <reference types="jest" />

import { CueDataSync } from '../cueDataSync';
import { EosConsoleCue } from '../../types/eos';

describe('CueDataSync scene range resolution', () => {
  it('applies scene markers across cue ranges until sceneEnd', async () => {
    const cues: EosConsoleCue[] = [
      { uid: 'a', targetNumber: 1, label: 'Cue 1', scene: 'Scene 1' },
      { uid: 'b', targetNumber: 15, label: 'Cue 15', sceneEnd: true },
      { uid: 'c', targetNumber: 16, label: 'Cue 16', scene: 'Scene 2' },
      { uid: 'd', targetNumber: 32, label: 'Cue 32', sceneEnd: true },
    ];

    const connection = {
      getCues: jest.fn().mockResolvedValue(cues),
      getCue: jest.fn().mockResolvedValue(null),
    } as any;

    const sync = new CueDataSync(connection, {
      syncOnConnect: false,
      syncInterval: 0,
      prefetchEnabled: false,
      prefetchCount: 0,
      cacheTTL: 60_000,
      cacheMaxSize: 1000,
    });

    await sync.initialSync(1);

    expect(sync.getSceneForCue('1/1')).toBe('Scene 1');
    expect(sync.getSceneForCue('1/10')).toBe('Scene 1');
    expect(sync.getSceneForCue('1/15')).toBe('Scene 1');
    expect(sync.getSceneForCue('1/16')).toBe('Scene 2');
    expect(sync.getSceneForCue('1/20')).toBe('Scene 2');
    expect(sync.getSceneForCue('1/32')).toBe('Scene 2');
    expect(sync.getSceneForCue('1/33')).toBeNull();
  });
});

