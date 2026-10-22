import { BadRequestException, NotFoundException } from '@nestjs/common';

import { encodePlaybackSessionId } from '../abs-ids';
import { makeAudiobookFixture, makeUser } from '../abs-test-support';
import { AbsSessionService } from './abs-session.service';

const SECRET = 'secret';
const MIN = 60_000;
const at = (hhmm: string) => new Date(`2026-03-10T${hhmm}:00.000Z`).getTime();

function setup(options?: Parameters<typeof makeAudiobookFixture>[0]) {
  const fixture = makeAudiobookFixture(options);
  const stats = { recordLive: vi.fn().mockResolvedValue(undefined), recordLocal: vi.fn().mockResolvedValue(undefined) };
  const progress = { publish: vi.fn().mockResolvedValue(undefined) };
  return { ...fixture, stats, progress, sessions: new AbsSessionService(fixture.service, stats as never, progress as never) };
}

const localSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'play_local_1',
  libraryItemId: 'li-30',
  currentTime: 12,
  updatedAt: at('18:00'),
  timeListening: 300,
  ...overrides,
});

describe('AbsSessionService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T21:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('live sync', () => {
    it('writes the reported position stamped with the server clock', async () => {
      const { sessions, rows, key } = setup();
      const sessionId = encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password' });

      await sessions.sync(makeUser(), sessionId, { currentTime: 12, timeListened: 5, duration: 30 });

      const stored = rows.get(key(7, 30))!;
      expect(stored.currentFileId).toBe(12);
      expect(stored.positionSeconds).toBe(2);
      expect(stored.capturedAt.toISOString()).toBe('2026-03-10T21:00:00.000Z');
    });

    it('closes with a final position when the body has one and ignores an empty close', async () => {
      const { sessions, rows, key } = setup();
      const sessionId = encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password' });

      await sessions.close(makeUser(), sessionId, {});
      expect(rows.size).toBe(0);

      await sessions.close(makeUser(), sessionId, { currentTime: 4 });
      expect(rows.get(key(7, 30))!.positionSeconds).toBe(4);
    });

    it('rejects a body with no position and a session id that names no book', async () => {
      const { sessions } = setup();
      const sessionId = encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password' });

      await expect(sessions.sync(makeUser(), sessionId, { timeListened: 5 })).rejects.toThrow(BadRequestException);
      await expect(sessions.sync(makeUser(), 'play_local_x', { currentTime: 5 })).rejects.toThrow(NotFoundException);
    });

    it('cannot move progress of a book the user has no access to', async () => {
      const { sessions, rows } = setup({ inaccessibleBookIds: [30] });
      const sessionId = encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password' });

      await expect(sessions.sync(makeUser(), sessionId, { currentTime: 5 })).rejects.toThrow(NotFoundException);
      expect(rows.size).toBe(0);
    });

    it('reports an open session as not found', () => {
      expect(() => setup().sessions.getOpenSession()).toThrow(NotFoundException);
    });
  });

  describe('progress events', () => {
    it('publishes a live sync with its session id and a local session only when it was applied', async () => {
      const { sessions, progress } = setup();
      const sessionId = encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password' });

      await sessions.sync(makeUser(), sessionId, { currentTime: 12 });
      await sessions.syncLocalAll(makeUser(), { sessions: [localSession({ currentTime: 25, updatedAt: at('18:00') })] });

      expect(progress.publish.mock.calls.map(([user, bookId, id]) => [user.id, bookId, id])).toEqual([[7, 30, sessionId]]);
    });
  });

  describe('offline merge, last listened wins', () => {
    it('keeps the other device when it listened later than the offline session', async () => {
      const { sessions, rows, key } = setup();
      const user = makeUser();
      vi.setSystemTime(at('20:00'));
      await sessions.sync(user, encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 4, authMethod: 'password' }), {
        currentTime: 2,
      });
      vi.setSystemTime(at('21:00'));

      const result = await sessions.syncLocalAll(user, { sessions: [localSession({ currentTime: 25, updatedAt: at('18:00') })] });

      expect(result.results).toEqual([{ id: 'play_local_1', success: true, progressSynced: false }]);
      const stored = rows.get(key(7, 30))!;
      expect(stored.currentFileId).toBe(11);
      expect(stored.positionSeconds).toBe(2);
    });

    it('moves progress to the offline position when nothing else happened', async () => {
      const { sessions, rows, key } = setup();

      const result = await sessions.syncLocalAll(makeUser(), { sessions: [localSession({ currentTime: 25, updatedAt: at('18:00') })] });

      expect(result.results).toEqual([{ id: 'play_local_1', success: true, progressSynced: true }]);
      const stored = rows.get(key(7, 30))!;
      expect(stored.currentFileId).toBe(12);
      expect(stored.positionSeconds).toBe(15);
      expect(stored.capturedAt.getTime()).toBe(at('18:00'));
    });

    it('applies an offline session once however often it is uploaded', async () => {
      const { sessions, repo } = setup();
      const body = { sessions: [localSession()] };

      const first = await sessions.syncLocalAll(makeUser(), body);
      const second = await sessions.syncLocalAll(makeUser(), body);

      expect(first.results[0]).toEqual({ id: 'play_local_1', success: true, progressSynced: true });
      expect(second.results[0]).toEqual({ id: 'play_local_1', success: true, progressSynced: false });
      expect(repo.createPlaybackState).toHaveBeenCalledTimes(1);
      expect(repo.updatePlaybackState).not.toHaveBeenCalled();
    });

    it('cannot be pinned by a device whose clock is far ahead', async () => {
      const { sessions, rows, key } = setup();
      const user = makeUser();

      await sessions.syncLocalAll(user, { sessions: [localSession({ currentTime: 8, updatedAt: Date.now() + 365 * 24 * 60 * MIN })] });
      expect(rows.get(key(7, 30))!.capturedAt.getTime()).toBe(Date.now());

      vi.setSystemTime(new Date(Date.now() + 5 * MIN));
      await sessions.sync(user, encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password' }), {
        currentTime: 9,
      });
      expect(rows.get(key(7, 30))!.positionSeconds).toBe(9);
    });

    it('never lets two users interact', async () => {
      const { sessions, rows, key } = setup();

      await sessions.syncLocalAll(makeUser(7), { sessions: [localSession({ currentTime: 4, updatedAt: at('20:00') })] });
      await sessions.syncLocalAll(makeUser(8), { sessions: [localSession({ currentTime: 25, updatedAt: at('18:00') })] });

      expect(rows.get(key(7, 30))!.positionSeconds).toBe(4);
      expect(rows.get(key(8, 30))).toEqual(expect.objectContaining({ currentFileId: 12, positionSeconds: 15 }));
    });

    it('uses only the newest session of a book, whatever the order they arrive in', async () => {
      const { sessions, rows, key, repo } = setup();

      const result = await sessions.syncLocalAll(makeUser(), {
        sessions: [
          localSession({ id: 'newest', currentTime: 25, updatedAt: at('19:00') }),
          localSession({ id: 'oldest', currentTime: 3, updatedAt: at('17:00') }),
          localSession({ id: 'middle', currentTime: 11, updatedAt: at('18:00') }),
        ],
      });

      expect(result.results).toEqual([
        { id: 'newest', success: true, progressSynced: true },
        { id: 'oldest', success: true, progressSynced: false },
        { id: 'middle', success: true, progressSynced: false },
      ]);
      expect(rows.get(key(7, 30))!.positionSeconds).toBe(15);
      expect(repo.createPlaybackState).toHaveBeenCalledTimes(1);
    });
  });

  describe('local-all results', () => {
    it('answers every entry and never fails the batch for one bad entry', async () => {
      const { sessions, rows, key } = setup({ inaccessibleBookIds: [31] });

      const result = await sessions.syncLocalAll(makeUser(), {
        sessions: [
          localSession({ id: 'good' }),
          localSession({ id: 'unknown-item', libraryItemId: 'li-999' }),
          localSession({ id: 'local-item', libraryItemId: 'local_li_abc' }),
          localSession({ id: 'no-access', libraryItemId: 'li-31' }),
          localSession({ id: 'no-position', libraryItemId: 'li-30', currentTime: undefined }),
          'garbage',
        ],
      });

      expect(result.results.map((entry) => [entry.id, entry.success, entry.error])).toEqual([
        ['good', true, undefined],
        ['unknown-item', false, 'Media item not found'],
        ['local-item', false, 'Media item not found'],
        ['no-access', false, 'Media item not found'],
        ['no-position', false, 'currentTime is required'],
        ['unknown-5', false, 'Media item not found'],
      ]);
      expect(rows.get(key(7, 30))!.positionSeconds).toBe(2);
    });

    it('rejects a payload without a sessions array', async () => {
      const { sessions } = setup();

      await expect(sessions.syncLocalAll(makeUser(), {})).rejects.toThrow(BadRequestException);
      await expect(sessions.syncLocalAll(makeUser(), { sessions: 'nope' })).rejects.toThrow(BadRequestException);
    });

    it('caps the distinct books written in one request at 500 and reports the rest', async () => {
      const { sessions, bookService } = setup();
      const many = Array.from({ length: 502 }, (_value, index) => localSession({ id: `s${index}`, libraryItemId: `li-${index + 1}` }));

      const result = await sessions.syncLocalAll(makeUser(), { sessions: many });

      expect(result.results).toHaveLength(502);
      expect(bookService.verifyBookAccess).toHaveBeenCalledTimes(500);
      expect(result.results.slice(500)).toEqual([
        { id: 's500', success: false, error: 'Too many sessions in one request' },
        { id: 's501', success: false, error: 'Too many sessions in one request' },
      ]);
    });

    it('logs counts without any session content', async () => {
      const { sessions } = setup();
      const log = vi.spyOn(sessions['logger'], 'log').mockImplementation(() => undefined);

      await sessions.syncLocalAll(makeUser(), { sessions: [localSession(), localSession({ id: 'older', updatedAt: at('10:00') })] });

      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines[0]).toBe('[abs.session_sync_local] [start] userId=7 sessions=2 - local session sync started');
      expect(lines[1]).toMatch(/^\[abs\.session_sync_local\] \[end\] userId=7 sessions=2 applied=1 skippedOlder=1 failed=0 durationMs=\d+ - /);
    });
  });

  describe('single local session', () => {
    it('applies it', async () => {
      const { sessions, rows, key } = setup();

      await expect(sessions.syncLocal(makeUser(), localSession({ currentTime: 25 }))).resolves.toEqual({
        id: 'play_local_1',
        success: true,
        progressSynced: true,
      });
      expect(rows.get(key(7, 30))!.currentFileId).toBe(12);
    });

    it('fails an unknown item with 404 so the client keeps the session', async () => {
      const { sessions } = setup();

      await expect(sessions.syncLocal(makeUser(), localSession({ libraryItemId: 'li-999' }))).rejects.toThrow(NotFoundException);
    });
  });

  describe('listening stats', () => {
    const ANDROID = 'okhttp/4.12.0';
    const sessionId = () => encodePlaybackSessionId(SECRET, { bookId: 30, userId: 7, authSessionId: 3, authMethod: 'password' });

    it('passes a live sync on with the time listened and the device platform', async () => {
      const { sessions, stats } = setup();
      const id = sessionId();

      await sessions.sync(makeUser(), id, { currentTime: 5, timeListened: 15, duration: 30 }, ANDROID);

      expect(stats.recordLive).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), id, 30, 15, 'android');
    });

    it('records every applied local session, older ones for the same book included, but not unknown items', async () => {
      const { sessions, stats } = setup();

      await sessions.syncLocalAll(
        makeUser(),
        {
          sessions: [
            localSession({ id: 'a', timeListening: 300, startedAt: at('17:00'), updatedAt: at('17:05') }),
            localSession({ id: 'b', timeListening: 120, startedAt: at('18:00'), updatedAt: at('18:02') }),
            localSession({ id: 'c', libraryItemId: 'li-999', timeListening: 60 }),
          ],
        },
        'SoundLeaf/2.1 CFNetwork',
      );

      expect(stats.recordLocal).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        [
          { sessionId: 'a', bookId: 30, timeListeningSeconds: 300, startedAtMs: at('17:00'), updatedAtMs: at('17:05') },
          { sessionId: 'b', bookId: 30, timeListeningSeconds: 120, startedAtMs: at('18:00'), updatedAtMs: at('18:02') },
        ],
        'ios',
      );
    });

    it('does not record stats when the position could not be written', async () => {
      const { sessions, stats } = setup({ inaccessibleBookIds: [30] });

      await sessions.syncLocalAll(makeUser(), { sessions: [localSession({ timeListening: 300 })] });

      expect(stats.recordLocal).toHaveBeenCalledWith(expect.anything(), [], 'web');
    });
  });
});
