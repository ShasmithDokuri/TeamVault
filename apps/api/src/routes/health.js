const express = require('express');

const router = express.Router();

router.get('/', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});

module.exports = router;
