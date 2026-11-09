const developmentOrigin = 'http://localhost:5173';

export function getAllowedClientOrigins(clientUrl = process.env.CLIENT_URL): string[] {
  const configuredOrigins = clientUrl
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

  return [...new Set([developmentOrigin, ...configuredOrigins])];
}
