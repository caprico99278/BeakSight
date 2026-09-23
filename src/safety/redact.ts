export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    const lowerName = name.toLowerCase();
    const compactName = lowerName.replace(/[-_]/g, '');
    const isSensitive = compactName.includes('authorization')
      || lowerName === 'cookie'
      || lowerName === 'set-cookie'
      || compactName.includes('token')
      || compactName.includes('session')
      || compactName.includes('apikey')
      || compactName.includes('authkey')
      || compactName.includes('subscriptionkey')
      || compactName.includes('secret');
    return [name, isSensitive ? '[REDACTED]' : value];
  }));
}
