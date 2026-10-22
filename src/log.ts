/** One-line stderr logger; launchd captures stderr into the daemon log. */
export function createLogger(name: string) {
  const line = (level: string, message: string) =>
    process.stderr.write(`${new Date().toISOString()} ${level} ${name}: ${message}\n`);
  return {
    info: (message: string) => line("info", message),
    warn: (message: string) => line("warn", message),
    error: (message: string) => line("error", message),
  };
}
