import app from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be a valid TCP port.');
}

app.listen(port, () => {
  console.info(`Route Optimization service listening on port ${port}`);
});
