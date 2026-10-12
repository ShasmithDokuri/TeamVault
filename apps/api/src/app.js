const cors = require('cors');
const express = require('express');
const { webOrigin } = require('./config');
const errorHandler = require('./middleware/error-handler');
const healthRouter = require('./routes/health');

const app = express();

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    callback(null, origin === webOrigin ? origin : false);
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use('/api/health', healthRouter);

app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

app.use(errorHandler);

module.exports = app;
