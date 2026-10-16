// Is this a cinematic film, or a failure we must say out loud? Pure.
// Every shot must have moved — in films of 4+ shots, all but one (that shot is dropped).
export function cinematicVerdict(shotCount, goodCount) {
  if (shotCount > 0 && goodCount === shotCount) return 'cinematic';
  if (shotCount >= 4 && shotCount - goodCount <= 1) return 'cinematic_trimmed';
  return 'failed';
}
