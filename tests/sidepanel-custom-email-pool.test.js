const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

test('sidepanel html exposes custom email pool generator option and input row', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');

  assert.match(html, /option value="custom-pool">自定义邮箱池<\/option>/);
  assert.match(html, /id="row-custom-email-pool"/);
  assert.match(html, /id="input-custom-email-pool"/);
});

test('sidepanel locks run count to custom email pool size', () => {
  const bundle = [
    extractFunction('isCustomMailProvider'),
    extractFunction('normalizeCustomEmailPoolEntries'),
    extractFunction('getSelectedEmailGenerator'),
    extractFunction('usesGeneratedAliasMailProvider'),
    extractFunction('usesCustomEmailPoolGenerator'),
    extractFunction('getCustomEmailPoolSize'),
    extractFunction('getRunCountValue'),
  ].join('\n');

  const api = new Function(`
const GMAIL_PROVIDER = 'gmail';
const GMAIL_ALIAS_GENERATOR = 'gmail-alias';
const CUSTOM_EMAIL_POOL_GENERATOR = 'custom-pool';
const selectMailProvider = { value: 'gmail' };
const selectEmailGenerator = { value: 'custom-pool' };
const inputCustomEmailPool = { value: 'first@example.com\\nsecond@example.com' };
const inputRunCount = { value: '99' };

function isLuckmailProvider() {
  return false;
}

function isManagedAliasProvider() {
  return false;
}

function getSelectedMail2925Mode() {
  return 'provide';
}

function isManagedAliasProvider(provider) {
  return String(provider || '').trim().toLowerCase() === GMAIL_PROVIDER;
}

${bundle}

return {
  getSelectedEmailGenerator,
  usesGeneratedAliasMailProvider,
  usesCustomEmailPoolGenerator,
  getCustomEmailPoolSize,
  getRunCountValue,
};
`)();

  assert.equal(api.getSelectedEmailGenerator(), 'custom-pool');
  assert.equal(api.usesGeneratedAliasMailProvider('gmail', 'provide', 'gmail-alias'), true);
  assert.equal(api.usesGeneratedAliasMailProvider('gmail', 'provide', 'custom-pool'), false);
  assert.equal(api.usesCustomEmailPoolGenerator(), true);
  assert.equal(api.getCustomEmailPoolSize(), 2);
  assert.equal(api.getRunCountValue(), 2);
});
