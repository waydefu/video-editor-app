/**
 * Only the application entrypoint may retain the privileged Electron preload.
 * Do not grant the same bridge to arbitrary URLs reached through navigation.
 */
export function isTrustedAppNavigation(target: string, entry: string, development: boolean): boolean {
  try {
    const destination = new URL(target);
    const trusted = new URL(entry);
    if (development) {
      return (
        (trusted.protocol === "http:" || trusted.protocol === "https:") &&
        destination.protocol === trusted.protocol &&
        destination.origin === trusted.origin
      );
    }
    return (
      trusted.protocol === "file:" &&
      destination.protocol === "file:" &&
      destination.host === trusted.host &&
      destination.pathname === trusted.pathname &&
      destination.search === trusted.search
    );
  } catch {
    return false;
  }
}
