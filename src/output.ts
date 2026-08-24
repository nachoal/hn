export function output(data: unknown, pretty: boolean): void {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  process.stdout.write(json + '\n');
}

export function outputError(err: unknown, pretty: boolean): void {
  let payload: unknown;
  const maybe = err as { toJSON?: () => unknown; name?: string; message?: string };
  if (maybe && typeof maybe.toJSON === 'function') {
    payload = maybe.toJSON();
  } else if (err instanceof Error) {
    payload = { error: err.name || 'Error', message: err.message };
  } else {
    payload = { error: 'Error', message: String(err) };
  }
  const json = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  process.stderr.write(json + '\n');
}
