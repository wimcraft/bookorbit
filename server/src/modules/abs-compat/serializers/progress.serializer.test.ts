import { absoluteSeconds, buildTimeline } from './book-timeline';
import { isProgressFinished, toAbsMediaProgress } from './progress.serializer';

const base = {
  userId: 4,
  bookId: 1287,
  durationSeconds: 3600,
  currentTimeSeconds: 900,
  percentage: 25,
  capturedAt: new Date('2026-03-01T18:00:00.000Z'),
  readStatus: 'reading',
  startedAt: new Date('2026-02-20T10:00:00.000Z'),
  finishedAt: null,
};

describe('toAbsMediaProgress', () => {
  it('maps a started book', () => {
    expect(toAbsMediaProgress(base)).toEqual({
      id: 'mp-1287',
      userId: 'usr-4',
      libraryItemId: 'li-1287',
      episodeId: null,
      mediaItemId: 'book-1287',
      mediaItemType: 'book',
      duration: 3600,
      progress: 0.25,
      currentTime: 900,
      isFinished: false,
      hideFromContinueListening: false,
      ebookLocation: null,
      ebookProgress: 0,
      lastUpdate: Date.parse('2026-03-01T18:00:00.000Z'),
      startedAt: Date.parse('2026-02-20T10:00:00.000Z'),
      finishedAt: null,
    });
  });

  it('uses the time the listening happened as lastUpdate, not a write time', () => {
    expect(toAbsMediaProgress({ ...base, capturedAt: new Date('2025-01-01T00:00:00.000Z') }).lastUpdate).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
  });

  it('falls back to capturedAt when the read status has no start date', () => {
    expect(toAbsMediaProgress({ ...base, startedAt: null }).startedAt).toBe(base.capturedAt.getTime());
  });

  it.each([
    ['full percentage', 100, 'reading', true],
    ['read status', 40, 'read', true],
    ['in progress', 40, 'reading', false],
    ['no status', 40, null, false],
    ['rereading', 40, 'rereading', false],
    ['unread set by hand mid-book', 40, 'unread', false],
  ])('decides finished from %s', (_name, percentage, readStatus, expected) => {
    expect(isProgressFinished(percentage, readStatus)).toBe(expected);
    const progress = toAbsMediaProgress({ ...base, percentage, readStatus });
    expect(progress.isFinished).toBe(expected);
    expect(progress.progress).toBe(expected ? 1 : percentage / 100);
    expect(progress.finishedAt !== null).toBe(expected);
  });
});

describe('book timeline', () => {
  const files = [
    { id: 2, absolutePath: '/b/Part 2.mp3', sortOrder: 2, durationSeconds: 20 },
    { id: 1, absolutePath: '/b/Part 1.mp3', sortOrder: 1, durationSeconds: 10 },
    { id: 3, absolutePath: '/b/Part 3.mp3', sortOrder: 3, durationSeconds: 30 },
  ];
  const bySortOrder = (left: { sortOrder: number | null }, right: { sortOrder: number | null }) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0);

  it('lays files out in playback order and sums the duration', () => {
    const timeline = buildTimeline(files, bySortOrder, null);

    expect(timeline.entries.map((entry) => [entry.id, entry.startSeconds])).toEqual([
      [1, 0],
      [2, 10],
      [3, 30],
    ]);
    expect(timeline.totalSeconds).toBe(60);
  });

  it('turns a position inside a file into an absolute position', () => {
    const timeline = buildTimeline(files, bySortOrder, null);

    expect(absoluteSeconds(timeline, 2, 5)).toBe(15);
    expect(absoluteSeconds(timeline, 3, 0)).toBe(30);
    expect(absoluteSeconds(timeline, 99, 5)).toBeNull();
  });

  it('trusts the book level duration when a file has none', () => {
    const timeline = buildTimeline([{ ...files[0]!, durationSeconds: null }, files[1]!], bySortOrder, 500);
    expect(timeline.totalSeconds).toBe(500);
  });

  it.each(['unread', 'want_to_read'])('restarts a finished book the user moved back to %s', (readStatus) => {
    const progress = toAbsMediaProgress({ ...base, percentage: 100, currentTimeSeconds: 3600, readStatus, finishedAt: new Date() });
    expect(progress).toEqual(expect.objectContaining({ isFinished: false, progress: 0, currentTime: 0, finishedAt: null }));
  });
});
