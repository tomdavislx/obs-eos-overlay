/// <reference types="jest" />

import { CueStateManager } from '../cueStateManager';
import { CueState } from '../../types/cue';

describe('CueStateManager', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('promotes BACKGROUND cue to ACTIVE when the same cue fires again', () => {
    const m = new CueStateManager({});
    m.handleFire('1', '1', Date.now());
    expect(m.getCue('1/1')?.state).toBe(CueState.ACTIVE);

    m.handleFire('1', '2', Date.now());
    expect(m.getCue('1/1')?.state).toBe(CueState.BACKGROUND);
    expect(m.getCue('1/2')?.state).toBe(CueState.ACTIVE);

    m.handleFire('1', '1', Date.now());
    expect(m.getCue('1/1')?.state).toBe(CueState.ACTIVE);
    expect(m.getCue('1/2')?.state).toBe(CueState.BACKGROUND);

    m.cleanup();
  });

  it('does not run stale timeout for a cue demoted to BACKGROUND by another fire', () => {
    jest.useFakeTimers();
    const m = new CueStateManager();

    m.handleFire('1', '1', Date.now());
    expect(m.getCue('1/1')?.state).toBe(CueState.ACTIVE);

    m.handleFire('1', '2', Date.now());
    expect(m.getCue('1/1')?.state).toBe(CueState.BACKGROUND);

    jest.advanceTimersByTime(20_000);
    expect(m.getCue('1/1')?.state).not.toBe(CueState.STALE);

    m.cleanup();
  });

  it('promotes BACKGROUND to ACTIVE on active text and demotes prior main', () => {
    const m = new CueStateManager({});
    m.handleFire('1', '10', Date.now());
    m.handleFire('1', '20', Date.now());
    expect(m.getCue('1/10')?.state).toBe(CueState.BACKGROUND);

    m.handleActiveUpdate('1', '10', 'Label', 30, '50%', 'raw');
    expect(m.getCue('1/10')?.state).toBe(CueState.ACTIVE);
    expect(m.getCue('1/20')?.state).toBe(CueState.BACKGROUND);

    m.cleanup();
  });
});
