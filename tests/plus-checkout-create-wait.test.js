const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)(globalScope);

test('Plus checkout create does not wait 20 seconds after opening checkout page', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome: {
      tabs: {
        create: async (payload) => {
          events.push({ type: 'tab-create', payload });
          return { id: 42 };
        },
        update: async (tabId, payload) => {
          events.push({ type: 'tab-update', tabId, payload });
        },
      },
    },
    completeStepFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {
      events.push({ type: 'ready' });
    },
    registerTab: async (source, tabId) => {
      events.push({ type: 'register', source, tabId });
    },
    sendTabMessageUntilStopped: async () => ({
      checkoutUrl: 'https://checkout.stripe.com/c/pay/session',
      country: 'US',
      currency: 'USD',
    }),
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async (ms) => {
      events.push({ type: 'sleep', ms });
    },
    waitForTabCompleteUntilStopped: async () => {
      events.push({ type: 'tab-complete' });
    },
  });

  await executor.executePlusCheckoutCreate();

  assert.deepEqual(
    events.find((event) => event.type === 'tab-create'),
    { type: 'tab-create', payload: { url: 'https://chatgpt.com/', active: true } }
  );
  assert.deepEqual(
    events.find((event) => event.type === 'register'),
    { type: 'register', source: 'plus-checkout', tabId: 42 }
  );

  const sleepEvents = events.filter((event) => event.type === 'sleep');
  assert.deepStrictEqual(sleepEvents.map((event) => event.ms), [1000, 1000]);

  const completeIndex = events.findIndex((event) => event.type === 'complete');
  const readyLogIndex = events.findIndex((event) => event.type === 'log' && /Plus Checkout 页面已就绪/.test(event.message));
  assert.ok(readyLogIndex > -1);
  assert.ok(completeIndex > readyLogIndex);
  assert.equal(events.some((event) => event.type === 'sleep' && event.ms === 20000), false);
  assert.equal(events.some((event) => event.type === 'log' && /固定等待 20 秒后继续下一步/.test(event.message)), false);
});
