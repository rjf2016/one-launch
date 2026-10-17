const files = import.meta.glob('../assets/whats-new/*.{png,jpg,jpeg,webp,gif}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The bundled URL of a What's New image by its file name in src/renderer/src/assets/whats-new/, or null when there is no such file. */
export function whatsNewImageUrl(file: string): string | null {
  return files[`../assets/whats-new/${file}`] ?? null;
}
