export interface TimelineFileInput {
  id: number;
  absolutePath: string;
  sortOrder: number | null;
  durationSeconds: number | null;
}

export interface TimelineEntry extends TimelineFileInput {
  startSeconds: number;
}

export interface BookTimeline {
  entries: TimelineEntry[];
  totalSeconds: number;
}

/**
 * Lays an audiobook's files end to end in playback order. `compare` is the server's track order, so
 * absolute positions computed here agree with the manifest the web player uses.
 */
export function buildTimeline<T extends TimelineFileInput>(
  files: readonly T[],
  compare: (left: T, right: T) => number,
  metaDurationSeconds: number | null,
): BookTimeline {
  const ordered = [...files].sort(compare);
  let elapsed = 0;
  const entries = ordered.map<TimelineEntry>((file) => {
    const entry = {
      id: file.id,
      absolutePath: file.absolutePath,
      sortOrder: file.sortOrder,
      durationSeconds: file.durationSeconds,
      startSeconds: elapsed,
    };
    elapsed += file.durationSeconds ?? 0;
    return entry;
  });
  const complete = entries.length > 0 && entries.every((entry) => (entry.durationSeconds ?? 0) > 0);
  return { entries, totalSeconds: complete ? elapsed : (metaDurationSeconds ?? elapsed) };
}

export function absoluteSeconds(timeline: BookTimeline, currentFileId: number, positionSeconds: number): number | null {
  const entry = timeline.entries.find((candidate) => candidate.id === currentFileId);
  if (!entry) return null;
  return entry.startSeconds + Math.max(0, positionSeconds);
}
