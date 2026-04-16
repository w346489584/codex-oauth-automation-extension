(function attachBackgroundStep2(root, factory) {
  root.MultiPageBackgroundStep2 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep2Module() {
  function createStep2Executor(deps = {}) {
    const {
      addLog,
      chrome,
      completeStepFromBackground,
      ensureContentScriptReadyOnTab,
      ensureSignupEntryPageReady,
      ensureSignupPostEmailPageReadyInTab,
      getTabId,
      isTabAlive,
      resolveSignupEmailForFlow,
      sendToContentScriptResilient,
      SIGNUP_PAGE_INJECT_FILES,
    } = deps;

    async function executeStep2(state) {
      const resolvedEmail = await resolveSignupEmailForFlow(state);

      let signupTabId = await getTabId('signup-page');
      if (!signupTabId || !(await isTabAlive('signup-page'))) {
        await addLog('步骤 2：未发现可用的注册页标签，正在重新打开 ChatGPT 官网...', 'warn');
        signupTabId = (await ensureSignupEntryPageReady(2)).tabId;
      } else {
        await chrome.tabs.update(signupTabId, { active: true });
        await ensureContentScriptReadyOnTab('signup-page', signupTabId, {
          inject: SIGNUP_PAGE_INJECT_FILES,
          injectSource: 'signup-page',
          timeoutMs: 45000,
          retryDelayMs: 900,
          logMessage: '步骤 2：注册入口页内容脚本未就绪，正在等待页面恢复...',
        });
      }

      const step2Result = await sendToContentScriptResilient('signup-page', {
        type: 'EXECUTE_STEP',
        step: 2,
        source: 'background',
        payload: { email: resolvedEmail },
      }, {
        timeoutMs: 20000,
        retryDelayMs: 700,
        logMessage: '步骤 2：官网注册入口正在切换，等待页面恢复后继续输入邮箱...',
      });

      if (step2Result?.error) {
        throw new Error(step2Result.error);
      }

      if (!step2Result?.alreadyOnPasswordPage) {
        await addLog(`步骤 2：邮箱 ${resolvedEmail} 已提交，正在等待页面加载并确认下一步入口...`);
      }

      const landingResult = await ensureSignupPostEmailPageReadyInTab(signupTabId, 2, {
        skipUrlWait: Boolean(step2Result?.alreadyOnPasswordPage),
      });

      await completeStepFromBackground(2, {
        email: resolvedEmail,
        nextSignupState: landingResult?.state || 'password_page',
        nextSignupUrl: landingResult?.url || step2Result?.url || '',
        skippedPasswordStep: landingResult?.state === 'verification_page',
      });
    }

    return { executeStep2 };
  }

  return { createStep2Executor };
});
