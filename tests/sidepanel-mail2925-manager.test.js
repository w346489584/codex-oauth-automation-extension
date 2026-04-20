const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('sidepanel loads mail2925 manager before sidepanel bootstrap', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const managerIndex = html.indexOf('<script src="mail-2925-manager.js"></script>');
  const sidepanelIndex = html.indexOf('<script src="sidepanel.js"></script>');

  assert.notEqual(managerIndex, -1);
  assert.notEqual(sidepanelIndex, -1);
  assert.ok(managerIndex < sidepanelIndex);
});

test('sidepanel html contains mail2925 pool toggle and selector controls', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');

  assert.match(html, /id="input-mail2925-use-account-pool"/);
  assert.match(html, /id="select-mail2925-pool-account"/);
});

test('mail2925 manager exposes a factory and renders empty state', () => {
  const source = fs.readFileSync('sidepanel/mail-2925-manager.js', 'utf8');
  const windowObject = {};
  const localStorageMock = {
    getItem() {
      return null;
    },
    setItem() {},
  };

  const api = new Function('window', 'localStorage', `${source}; return window.SidepanelMail2925Manager;`)(
    windowObject,
    localStorageMock
  );

  assert.equal(typeof api?.createMail2925Manager, 'function');

  const mail2925AccountsList = { innerHTML: '', addEventListener() {} };
  const toggleButton = {
    textContent: '',
    disabled: false,
    setAttribute() {},
    addEventListener() {},
  };
  const noopClassList = { toggle() {} };

  const manager = api.createMail2925Manager({
    state: {
      getLatestState: () => ({ currentMail2925AccountId: null, mail2925Accounts: [] }),
      syncLatestState() {},
    },
    dom: {
      btnAddMail2925Account: { disabled: false, addEventListener() {} },
      btnDeleteAllMail2925Accounts: { textContent: '', disabled: false, addEventListener() {} },
      btnImportMail2925Accounts: { disabled: false, addEventListener() {} },
      btnToggleMail2925List: toggleButton,
      inputMail2925Email: { value: '' },
      inputMail2925Import: { value: '' },
      inputMail2925Password: { value: '' },
      mail2925AccountsList,
      mail2925ListShell: { classList: noopClassList },
    },
    helpers: {
      getMail2925Accounts: () => [],
      escapeHtml: (value) => String(value || ''),
      showToast() {},
      openConfirmModal: async () => true,
      copyTextToClipboard: async () => {},
      refreshManagedAliasBaseEmail() {},
    },
    runtime: {
      sendMessage: async () => ({}),
    },
    constants: {
      copyIcon: '',
      displayTimeZone: 'Asia/Shanghai',
      expandedStorageKey: 'multipage-mail2925-list-expanded',
    },
    mail2925Utils: {},
  });

  assert.equal(typeof manager.renderMail2925Accounts, 'function');
  assert.equal(typeof manager.bindMail2925Events, 'function');
  assert.equal(typeof manager.initMail2925ListExpandedState, 'function');

  manager.renderMail2925Accounts();
  assert.match(mail2925AccountsList.innerHTML, /还没有 2925 账号/);
});
