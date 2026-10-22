import { ForbiddenException } from '@nestjs/common';

import { makeUser } from '../abs-test-support';
import { AbsListeningStatsService, listeningSource, statsSessionId } from './abs-listening-stats.service';

const NOW = Date.parse('2026-03-10T20:00:00.000Z');

function setup() {
  const readingSessions = { save: vi.fn().mockResolvedValue(undefined) };
  const repo = {
    findTimelineFiles: vi.fn().mockResolvedValue([
      { id: 12, publicId: 'b', bookId: 30, absolutePath: '/b.mp3', sortOrder: 2, durationSeconds: 10 },
      { id: 11, publicId: 'a', bookId: 30, absolutePath: '/a.mp3', sortOrder: 1, durationSeconds: 10 },
    ]),
  };
  const service = new AbsListeningStatsService(readingSessions as never, repo as never);
  vi.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  return { service, readingSessions, repo };
}

describe('listeningSource', () => {
  it.each([
    ['okhttp/4.12.0', 'android'],
    ['Mozilla/5.0 (Linux; Android 14) AudiobookshelfApp', 'android'],
    ['SoundLeaf/2.1 CFNetwork/1490 Darwin/23.2.0', 'ios'],
    [undefined, 'web'],
  ])('maps %j to %s', (agent, source) => {
    expect(listeningSource(agent)).toBe(source);
  });
});

describe('AbsListeningStatsService', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('keeps a running total for a live session and saves it under one short session id', async () => {
    const { service, readingSessions } = setup();
    const absId = `ps-30-7-3-p-${'a'.repeat(16)}-${'b'.repeat(32)}`;

    await service.recordLive(makeUser(), absId, 30, 15, 'android');
    vi.setSystemTime(NOW + 15_000);
    await service.recordLive(makeUser(), absId, 30, 15, 'android');

    expect(readingSessions.save).toHaveBeenCalledTimes(2);
    const [fileId, dto, , source] = readingSessions.save.mock.calls[1]!;
    expect(fileId).toBe(11);
    expect(source).toBe('android');
    expect(dto).toEqual({
      sessionId: statsSessionId(absId),
      startedAt: new Date(NOW - 15_000).toISOString(),
      endedAt: new Date(NOW + 15_000).toISOString(),
      durationSeconds: 30,
      sessionType: 'listen',
    });
    expect(dto.sessionId.length).toBeLessThanOrEqual(64);
  });

  it('keeps totals per user and caps an implausible single tick', async () => {
    const { service, readingSessions } = setup();

    await service.recordLive(makeUser(7), 'ps-shared', 30, 5_000, 'ios');
    await service.recordLive(makeUser(8), 'ps-shared', 30, 20, 'ios');

    expect(readingSessions.save.mock.calls.map(([, dto]) => dto.durationSeconds)).toEqual([600, 20]);
  });

  it('ignores a sync that reports no listening', async () => {
    const { service, readingSessions } = setup();

    await service.recordLive(makeUser(), 'ps-1', 30, 0, 'web');
    await service.recordLive(makeUser(), 'ps-1', 30, undefined, 'web');

    expect(readingSessions.save).not.toHaveBeenCalled();
  });

  it('saves offline sessions with their own span, clamping a clock from the future', async () => {
    const { service, readingSessions } = setup();

    await service.recordLocal(
      makeUser(),
      [
        { sessionId: 'play_local_1', bookId: 30, timeListeningSeconds: 300, startedAtMs: NOW - 3_600_000, updatedAtMs: NOW - 3_000_000 },
        { sessionId: 'play_local_2', bookId: 30, timeListeningSeconds: 60, startedAtMs: undefined, updatedAtMs: NOW + 86_400_000 },
        { sessionId: 'play_local_3', bookId: 30, timeListeningSeconds: 0, startedAtMs: undefined, updatedAtMs: NOW },
      ],
      'ios',
    );

    expect(readingSessions.save.mock.calls.map(([, dto]) => [dto.sessionId, dto.startedAt, dto.endedAt, dto.durationSeconds])).toEqual([
      [statsSessionId('play_local_1'), new Date(NOW - 3_600_000).toISOString(), new Date(NOW - 3_000_000).toISOString(), 300],
      [statsSessionId('play_local_2'), new Date(NOW - 60_000).toISOString(), new Date(NOW).toISOString(), 60],
    ]);
  });

  it('never lets a stats failure escape', async () => {
    const { service, readingSessions } = setup();
    readingSessions.save.mockRejectedValue(new ForbiddenException('nope'));

    await expect(service.recordLive(makeUser(), 'ps-1', 30, 15, 'web')).resolves.toBeUndefined();
    expect(service['logger'].warn).toHaveBeenCalledWith(expect.stringContaining('[abs.listening_stats] [fail]'));
  });
});
