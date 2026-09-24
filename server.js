const app = require('./app');

const port = process.env.PORT || 4000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`CA & AI API listening on http://localhost:${port}`);
});
