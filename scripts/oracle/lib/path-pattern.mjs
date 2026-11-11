const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Any run of either slash between segments covers a path written raw, with forward slashes, VDF-escaped, JSON-escaped, or JSON inside JSON.
export function pathPattern(path) {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) throw new Error('a path pattern needs at least one segment');
  return `(?<![A-Za-z0-9])${segments.map(escape).join('[\\\\/]+')}(?![\\w-])`;
}
