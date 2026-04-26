(function attachBackgroundPlusCheckoutBilling(root, factory) {
  root.MultiPageBackgroundPlusCheckoutBilling = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPlusCheckoutBillingModule() {
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PLUS_CHECKOUT_INJECT_FILES = ['content/utils.js', 'content/plus-checkout.js'];
  const PLUS_CHECKOUT_URL_PATTERN = /^https:\/\/chatgpt\.com\/checkout(?:\/|$)/i;
  const PLUS_CHECKOUT_FRAME_READY_DELAY_MS = 500;
  const MEIGUODIZHI_ADDRESS_ENDPOINT = 'https://www.meiguodizhi.com/api/v1/dz';
  const MEIGUODIZHI_PATH_BY_COUNTRY = {
    AU: '/au-address',
    DE: '/de-address',
    FR: '/fr-address',
    US: '/',
  };
  const MEIGUODIZHI_SUPPORTED_COUNTRIES = new Set(Object.keys(MEIGUODIZHI_PATH_BY_COUNTRY));

  function createPlusCheckoutBillingExecutor(deps = {}) {
    const {
      addLog,
      chrome,
      completeStepFromBackground,
      ensureContentScriptReadyOnTabUntilStopped,
      fetch: fetchImpl = null,
      generateRandomName,
      getAddressSeedForCountry,
      getTabId,
      isTabAlive,
      setState,
      sleepWithStop,
      waitForTabCompleteUntilStopped,
      waitForTabUrlMatchUntilStopped,
    } = deps;

    function isPlusCheckoutUrl(url = '') {
      return PLUS_CHECKOUT_URL_PATTERN.test(String(url || ''));
    }

    function normalizeText(value = '') {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function hasCompleteAddressFallback(seed) {
      const fallback = seed?.fallback || {};
      return Boolean(
        normalizeText(fallback.address1)
        && normalizeText(fallback.city)
        && normalizeText(fallback.postalCode)
      );
    }

    function buildDirectAddressSeed(countryCode, apiAddress, fallbackSeed) {
      const address1 = normalizeText(apiAddress?.Address);
      const city = normalizeText(apiAddress?.City);
      const region = normalizeText(apiAddress?.State || apiAddress?.State_Full);
      const postalCode = normalizeText(apiAddress?.Zip_Code);
      if (!address1 || !city || !postalCode) {
        return null;
      }
      return {
        ...(fallbackSeed || {}),
        countryCode,
        query: [address1, city].filter(Boolean).join(', '),
        source: 'meiguodizhi',
        skipAutocomplete: true,
        fallback: {
          ...(fallbackSeed?.fallback || {}),
          address1,
          city,
          region,
          postalCode,
        },
      };
    }

    async function fetchMeiguodizhiAddressSeed(countryCode, fallbackSeed) {
      if (typeof fetchImpl !== 'function') {
        return null;
      }
      if (!MEIGUODIZHI_SUPPORTED_COUNTRIES.has(countryCode)) {
        return null;
      }
      const path = MEIGUODIZHI_PATH_BY_COUNTRY[countryCode] || MEIGUODIZHI_PATH_BY_COUNTRY.DE;
      const city = normalizeText(fallbackSeed?.fallback?.city || fallbackSeed?.query || '');
      const response = await fetchImpl(MEIGUODIZHI_ADDRESS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          city,
          path,
          method: 'refresh',
        }),
      });
      if (!response?.ok) {
        throw new Error(`HTTP ${response?.status || 0}`);
      }
      const data = await response.json();
      if (data?.status !== 'ok') {
        throw new Error(data?.message || data?.status || 'unknown response');
      }
      return buildDirectAddressSeed(countryCode, data.address || {}, fallbackSeed);
    }

    async function resolveBillingAddressSeed(state = {}, countryOverride = '') {
      const requestedCountry = normalizeText(countryOverride || state.plusCheckoutCountry || 'DE');
      const fallbackSeed = getAddressSeedForCountry(requestedCountry, {
        fallbackCountry: 'DE',
      });
      if (!fallbackSeed) {
        throw new Error('步骤 7：未找到可用的本地账单地址种子。');
      }

      const countryCode = fallbackSeed.countryCode || 'DE';
      try {
        const remoteSeed = await fetchMeiguodizhiAddressSeed(countryCode, fallbackSeed);
        if (hasCompleteAddressFallback(remoteSeed)) {
          await addLog(
            `步骤 7：已从 meiguodizhi 接口获取账单地址（${remoteSeed.fallback.city} / ${remoteSeed.fallback.postalCode}），将跳过 Google 地址推荐。`,
            'info'
          );
          return remoteSeed;
        }
        await addLog('步骤 7：meiguodizhi 接口返回的地址字段不完整，回退到本地地址种子。', 'warn');
      } catch (error) {
        await addLog(`步骤 7：meiguodizhi 地址接口不可用，回退到本地地址种子：${error?.message || String(error || '')}`, 'warn');
      }

      return fallbackSeed;
    }

    async function getAlivePlusCheckoutTabId(tabId) {
      if (!Number.isInteger(tabId) || tabId <= 0) {
        return null;
      }
      if (!chrome?.tabs?.get) {
        return tabId;
      }
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return tab && isPlusCheckoutUrl(tab.url) ? tabId : null;
    }

    async function getCurrentPlusCheckoutTabId() {
      if (!chrome?.tabs?.query) {
        return null;
      }

      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const activeCheckoutTab = activeTabs.find((tab) => Number.isInteger(tab?.id) && isPlusCheckoutUrl(tab.url));
      if (activeCheckoutTab) {
        return activeCheckoutTab.id;
      }

      const checkoutTabs = await chrome.tabs.query({ url: 'https://chatgpt.com/checkout/*' }).catch(() => []);
      const checkoutTab = checkoutTabs.find((tab) => Number.isInteger(tab?.id) && isPlusCheckoutUrl(tab.url));
      return checkoutTab?.id || null;
    }

    async function getCheckoutFrames(tabId) {
      if (!chrome?.webNavigation?.getAllFrames) {
        return [{ frameId: 0, url: '' }];
      }
      const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
      if (!Array.isArray(frames) || !frames.length) {
        return [{ frameId: 0, url: '' }];
      }
      return frames
        .filter((frame) => Number.isInteger(frame?.frameId))
        .sort((left, right) => Number(left.frameId) - Number(right.frameId));
    }

    async function pingCheckoutFrame(tabId, frameId) {
      try {
        const pong = await chrome.tabs.sendMessage(tabId, {
          type: 'PING',
          source: 'background',
          payload: {},
        }, {
          frameId: Number.isInteger(frameId) ? frameId : 0,
        });
        return Boolean(pong?.ok && (!pong.source || pong.source === PLUS_CHECKOUT_SOURCE));
      } catch {
        return false;
      }
    }

    async function ensurePlusCheckoutFrameReady(tabId, frameId) {
      if (await pingCheckoutFrame(tabId, frameId)) {
        return true;
      }
      if (!chrome?.scripting?.executeScript) {
        return false;
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [PLUS_CHECKOUT_SOURCE],
        });
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          files: PLUS_CHECKOUT_INJECT_FILES,
        });
      } catch {
        // If the frame was already injected or navigated mid-injection, ping once more below.
      }

      await sleepWithStop(PLUS_CHECKOUT_FRAME_READY_DELAY_MS);
      return await pingCheckoutFrame(tabId, frameId);
    }

    async function ensurePlusCheckoutFramesReady(tabId, frames) {
      const checkedFrames = [];
      for (const frame of frames) {
        const ready = await ensurePlusCheckoutFrameReady(tabId, frame.frameId);
        checkedFrames.push({ ...frame, ready });
      }
      return checkedFrames;
    }

    async function sendFrameMessage(tabId, frameId, message) {
      return chrome.tabs.sendMessage(tabId, message, {
        frameId: Number.isInteger(frameId) ? frameId : 0,
      });
    }

    async function inspectCheckoutFrame(tabId, frame) {
      try {
        const result = await sendFrameMessage(tabId, frame.frameId, {
          type: 'PLUS_CHECKOUT_GET_STATE',
          source: 'background',
          payload: {},
        });
        if (result?.error) {
          return { frame, error: result.error };
        }
        return { frame: { ...frame, ready: true }, result: result || {} };
      } catch (error) {
        const readyError = frame.ready === false ? 'content-script-not-ready' : '';
        const message = error?.message || String(error || '');
        return { frame, error: readyError ? `${readyError}: ${message}` : message };
      }
    }

    function isPaymentFrameUrl(url = '') {
      return /elements-inner-payment|componentName=payment/i.test(String(url || ''));
    }

    function isAddressFrameUrl(url = '') {
      return /elements-inner-address|componentName=address/i.test(String(url || ''));
    }

    function isAutocompleteFrameUrl(url = '') {
      return /elements-inner-autocompl/i.test(String(url || ''));
    }

    function buildFrameSummary(inspections) {
      return inspections
        .map((item) => {
          const flags = [];
          if (item.result?.hasPayPal) flags.push('paypal');
          if (item.result?.billingFieldsVisible) flags.push('billing');
          if (item.result?.hasSubscribeButton) flags.push('subscribe');
          if (!flags.length && item.error) flags.push(item.error);
          if (!flags.length) flags.push('no-match');
          return `${item.frame.frameId}:${item.frame.url || 'about:blank'}:${flags.join(',')}`;
        })
        .slice(0, 8)
        .join(' | ');
    }

    async function inspectCheckoutFrames(tabId, frames) {
      const inspections = [];
      for (const frame of frames) {
        const inspection = await inspectCheckoutFrame(tabId, frame);
        inspections.push(inspection);
      }
      return inspections;
    }

    function pickPaymentFrame(inspections) {
      return inspections.find((item) => item.result?.hasPayPal || item.result?.paypalCandidates?.length)
        || inspections.find((item) => isPaymentFrameUrl(item.frame.url))
        || null;
    }

    function pickBillingFrame(inspections) {
      return inspections.find((item) => item.result?.billingFieldsVisible)
        || inspections.find((item) => isAddressFrameUrl(item.frame.url))
        || null;
    }

    function pickSubscribeFrame(inspections) {
      return inspections.find((item) => item.result?.hasSubscribeButton)
        || inspections.find((item) => item.frame.frameId === 0)
        || null;
    }

    async function getReadyCheckoutFrames(tabId) {
      return ensurePlusCheckoutFramesReady(tabId, await getCheckoutFrames(tabId));
    }

    async function resolveOptionalFrameByUrl(tabId, predicate) {
      const frames = await getCheckoutFrames(tabId);
      const frame = frames.find((item) => predicate(item.url));
      if (!frame) {
        return null;
      }
      const ready = await ensurePlusCheckoutFrameReady(tabId, frame.frameId);
      return {
        frame,
        ready,
      };
    }

    async function resolvePaymentFrame(tabId, frames) {
      const inspections = await inspectCheckoutFrames(tabId, frames);
      const picked = pickPaymentFrame(inspections);
      if (picked) {
        return {
          frameId: picked.frame.frameId,
          frameUrl: picked.frame.url || '',
          ready: picked.frame.ready !== false,
          inspections,
        };
      }

      return {
        frameId: null,
        frameUrl: '',
        inspections,
      };
    }

    async function waitForBillingFrame(tabId) {
      while (true) {
        const frames = await getReadyCheckoutFrames(tabId);
        const inspections = await inspectCheckoutFrames(tabId, frames);
        const picked = pickBillingFrame(inspections);
        if (picked) {
          return {
            frameId: picked.frame.frameId,
            frameUrl: picked.frame.url || '',
            countryText: picked.result?.countryText || '',
            ready: picked.frame.ready !== false,
            inspections,
          };
        }
        await sleepWithStop(250);
      }
    }

    async function waitForSubscribeFrame(tabId, candidateFrames) {
      const frames = candidateFrames.length ? candidateFrames : [{ frameId: 0, url: '' }];
      while (true) {
        const readyFrames = await ensurePlusCheckoutFramesReady(tabId, frames);
        const inspections = await inspectCheckoutFrames(tabId, readyFrames);
        const picked = pickSubscribeFrame(inspections);
        if (picked) {
          return picked.frame;
        }
        await sleepWithStop(250);
      }
    }

    async function getCheckoutTabId(state = {}) {
      const registeredTabId = await getTabId(PLUS_CHECKOUT_SOURCE);
      if (registeredTabId && await isTabAlive(PLUS_CHECKOUT_SOURCE)) {
        const aliveRegisteredTabId = await getAlivePlusCheckoutTabId(registeredTabId);
        if (aliveRegisteredTabId) {
          return aliveRegisteredTabId;
        }
      }
      const storedTabId = Number(state.plusCheckoutTabId) || 0;
      if (storedTabId) {
        const aliveStoredTabId = await getAlivePlusCheckoutTabId(storedTabId);
        if (aliveStoredTabId) {
          return aliveStoredTabId;
        }
      }
      const currentCheckoutTabId = await getCurrentPlusCheckoutTabId();
      if (currentCheckoutTabId) {
        await addLog('步骤 7：检测到当前已在 Plus Checkout 页面，直接接管当前标签页。', 'info');
        return currentCheckoutTabId;
      }
      throw new Error('步骤 7：未找到 Plus Checkout 标签页。请先打开 Plus Checkout 页面，或完成步骤 6。');
    }

    async function executePlusCheckoutBilling(state = {}) {
      const tabId = await getCheckoutTabId(state);
      await addLog('步骤 7：正在等待 Plus Checkout 页面加载完成...', 'info');
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);

      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: '步骤 7：Checkout 页面仍在加载，等待账单填写脚本就绪...',
      });
      const readyFrames = await getReadyCheckoutFrames(tabId);
      const paymentFrame = await resolvePaymentFrame(tabId, readyFrames);
      if (paymentFrame.frameId === null) {
        const frameSummary = buildFrameSummary(paymentFrame.inspections);
        throw new Error(`步骤 7：未在主页面或 iframe 中发现 PayPal DOM，无法自动切换付款方式。frame 摘要：${frameSummary}`);
      }
      if (!paymentFrame.ready) {
        throw new Error(`步骤 7：已定位到 PayPal 所在 iframe（frameId=${paymentFrame.frameId}），但账单脚本无法注入该 iframe。请提供该 iframe 的控制台结构或截图。`);
      }

      if (paymentFrame.frameId !== 0) {
        await addLog(`步骤 7：PayPal 位于 checkout iframe（frameId=${paymentFrame.frameId}），将改为在该 frame 内操作。`, 'info');
      }

      const randomName = generateRandomName();
      const fullName = [randomName.firstName, randomName.lastName].filter(Boolean).join(' ');

      await addLog('步骤 7：正在切换 PayPal 付款方式...', 'info');
      const paymentResult = await sendFrameMessage(tabId, paymentFrame.frameId, {
        type: 'PLUS_CHECKOUT_SELECT_PAYPAL',
        source: 'background',
        payload: {},
      });
      if (paymentResult?.error) {
        throw new Error(paymentResult.error);
      }

      const billingFrame = await waitForBillingFrame(tabId);
      if (!billingFrame.ready) {
        throw new Error(`步骤 7：已定位到账单地址 iframe（frameId=${billingFrame.frameId}），但账单脚本无法注入该 iframe。请提供该 iframe 的控制台结构或截图。`);
      }
      if (billingFrame.frameId !== paymentFrame.frameId) {
        await addLog(`步骤 7：账单地址位于 checkout iframe（frameId=${billingFrame.frameId}），将改为在该 frame 内填写。`, 'info');
      }

      const addressSeed = await resolveBillingAddressSeed(state, billingFrame.countryText);
      if (!addressSeed) {
        throw new Error('步骤 7：未找到可用的本地账单地址种子。');
      }

      await addLog(`步骤 7：正在填写账单地址（${addressSeed.countryCode} / ${addressSeed.query}）...`, 'info');
      const autocompleteFrame = await resolveOptionalFrameByUrl(tabId, isAutocompleteFrameUrl);
      let result = null;
      if (!addressSeed.skipAutocomplete && autocompleteFrame?.frame && autocompleteFrame.frame.frameId !== billingFrame.frameId) {
        if (!autocompleteFrame.ready) {
          throw new Error('步骤 7：发现 Google 地址推荐 iframe，但无法注入账单脚本。请提供该 iframe 的控制台结构。');
        }
        await addLog(`步骤 7：Google 地址推荐位于独立 iframe（frameId=${autocompleteFrame.frame.frameId}），将拆分输入与选择动作。`, 'info');

        const queryResult = await sendFrameMessage(tabId, billingFrame.frameId, {
          type: 'PLUS_CHECKOUT_FILL_ADDRESS_QUERY',
          source: 'background',
          payload: {
            fullName,
            addressSeed,
          },
        });
        if (queryResult?.error) {
          throw new Error(queryResult.error);
        }

        const suggestionResult = await sendFrameMessage(tabId, autocompleteFrame.frame.frameId, {
          type: 'PLUS_CHECKOUT_SELECT_ADDRESS_SUGGESTION',
          source: 'background',
          payload: {
            addressSeed,
          },
        });
        if (suggestionResult?.error) {
          throw new Error(suggestionResult.error);
        }

        const structuredResult = await sendFrameMessage(tabId, billingFrame.frameId, {
          type: 'PLUS_CHECKOUT_ENSURE_BILLING_ADDRESS',
          source: 'background',
          payload: {
            addressSeed,
          },
        });
        if (structuredResult?.error) {
          throw new Error(structuredResult.error);
        }

        result = {
          ...structuredResult,
          selectedAddressText: suggestionResult?.selectedAddressText || '',
        };
      } else {
        result = await sendFrameMessage(tabId, billingFrame.frameId, {
          type: 'PLUS_CHECKOUT_FILL_BILLING_ADDRESS',
          source: 'background',
          payload: {
            fullName,
            addressSeed,
          },
        });

        if (result?.error) {
          throw new Error(result.error);
        }
      }

      await addLog('步骤 7：账单地址已填写完成，正在定位订阅按钮...', 'info');
      const subscribeFrame = await waitForSubscribeFrame(tabId, [
        { frameId: 0, url: '' },
        { frameId: paymentFrame.frameId, url: paymentFrame.frameUrl || '' },
        { frameId: billingFrame.frameId, url: billingFrame.frameUrl || '' },
      ]);
      const subscribeResult = await sendFrameMessage(tabId, subscribeFrame.frameId, {
        type: 'PLUS_CHECKOUT_CLICK_SUBSCRIBE',
        source: 'background',
        payload: {},
      });
      if (subscribeResult?.error) {
        throw new Error(subscribeResult.error);
      }

      await setState({
        plusCheckoutTabId: tabId,
        plusBillingCountryText: result?.countryText || '',
        plusBillingAddress: result?.structuredAddress || null,
      });

      await addLog('步骤 7：账单地址已提交，正在等待跳转到 PayPal...', 'info');
      await waitForTabUrlMatchUntilStopped(tabId, (url) => /paypal\./i.test(url));
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);

      await completeStepFromBackground(7, {
        plusBillingCountryText: result?.countryText || '',
      });
    }

    return {
      executePlusCheckoutBilling,
    };
  }

  return {
    createPlusCheckoutBillingExecutor,
  };
});
