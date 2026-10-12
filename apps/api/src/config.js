const port = Number(process.env.PORT ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

module.exports = { port, webOrigin };
