const app = require('./app');
const { port } = require('./config');

app.listen(port, () => {
  process.stdout.write(`TeamVault API listening on port ${port}\n`);
});
