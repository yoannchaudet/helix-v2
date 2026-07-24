/** Public GitHub avatar URL for a login. The github.com redirect is allowed by the app CSP,
 * so callers can show an avatar without another API request or a persisted URL. */
export function avatarUrl(login, size = 32) {
  return `https://github.com/${encodeURIComponent(String(login))}.png?size=${size}`;
}
