import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A throwaway local HTTP server, ONLY for the portal client's transport faults (timeouts, resets,
 * non-JSON bodies) that the real portal cannot produce on demand (SPEC §12). Never for sync tests.
 */
export async function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A URL on which nothing listens (connection refused). */
export async function refusedUrl(): Promise<string> {
  const { url, close } = await startFakeServer(() => {});
  await close();
  return url;
}
