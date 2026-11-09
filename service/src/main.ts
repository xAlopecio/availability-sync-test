import Fastify from 'fastify';

// Placeholder entry point: proves the toolchain (native TS type stripping on Node 24).
// The real wiring (config, DB, worker, routes) arrives in later branches.
const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
