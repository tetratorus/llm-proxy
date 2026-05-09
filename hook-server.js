const express = require('express');

const app = express();
const PORT = Number(process.env.HOOK_PORT || 8888);

app.use(express.json({ limit: process.env.HOOK_BODY_LIMIT || '25mb' }));

const events = [];
const maxEvents = Number(process.env.HOOK_MAX_EVENTS || 500);

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    events: events.length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/events', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), maxEvents);
  res.json({
    events: events.slice(-limit).reverse(),
    total: events.length,
  });
});

app.post('/hooks/policy', (req, res) => {
  const event = {
    received_at: new Date().toISOString(),
    ...req.body,
  };
  events.push(event);
  while (events.length > maxEvents) events.shift();

  console.log(JSON.stringify({
    received_at: event.received_at,
    rule: event.rule && event.rule.name,
    direction: event.direction,
    provider: event.provider,
    request_id: event.request_id,
    frame_id: event.frame_id,
    match: event.match,
  }));

  res.json({ ok: true });
});

function startHookServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`llm-proxy hook server running on http://localhost:${port}`);
  });
}

if (require.main === module) {
  startHookServer();
}

module.exports = {
  app,
  startHookServer,
};
