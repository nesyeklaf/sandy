// Display formatting shared by the popup and the overview page.
export function ago(at: number | null, now = Date.now()): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function bytes(value: number): string {
  const mb = value / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
