import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.text('Hello World'));
app.get('/api/test', (c) => c.json({ hello: 'world' }));

Bun.serve({
    fetch: app.fetch,
    port: 3001,
});

console.log('Server running on port 3001');
