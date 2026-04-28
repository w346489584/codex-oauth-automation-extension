(function attachSidepanelFormDialog(globalScope) {
  function createFormDialog(context = {}) {
    const {
      overlay = null,
      titleNode = null,
      closeButton = null,
      messageNode = null,
      alertNode = null,
      fieldsContainer = null,
      cancelButton = null,
      confirmButton = null,
      documentRef = globalScope.document,
    } = context;

    let resolver = null;
    let currentConfig = null;
    let currentInputs = [];

    function setHidden(node, hidden) {
      if (!node) return;
      node.hidden = Boolean(hidden);
    }

    function resetAlert() {
      if (!alertNode) return;
      alertNode.textContent = '';
      alertNode.className = 'modal-alert modal-form-alert';
      alertNode.hidden = true;
    }

    function setAlert(message = '', tone = 'danger') {
      if (!alertNode) return;
      const text = String(message || '').trim();
      if (!text) {
        resetAlert();
        return;
      }
      alertNode.textContent = text;
      alertNode.className = `modal-alert modal-form-alert${tone === 'danger' ? ' is-danger' : ''}`;
      alertNode.hidden = false;
    }

    function close(result = null) {
      if (resolver) {
        resolver(result);
        resolver = null;
      }
      currentConfig = null;
      currentInputs = [];
      resetAlert();
      if (fieldsContainer) {
        fieldsContainer.innerHTML = '';
      }
      if (overlay) {
        overlay.hidden = true;
      }
    }

    function buildFieldNode(field, values) {
      const wrapper = documentRef.createElement('div');
      wrapper.className = 'modal-form-row';

      const label = documentRef.createElement('label');
      label.className = 'modal-form-label';
      label.textContent = String(field.label || field.key || '').trim();
      wrapper.appendChild(label);

      let input = null;
      if (field.type === 'textarea') {
        input = documentRef.createElement('textarea');
        input.className = 'data-textarea';
      } else if (field.type === 'select') {
        input = documentRef.createElement('select');
        input.className = 'data-select';
        const options = Array.isArray(field.options) ? field.options : [];
        options.forEach((option) => {
          const optionNode = documentRef.createElement('option');
          optionNode.value = String(option?.value || '');
          optionNode.textContent = String(option?.label || option?.value || '');
          input.appendChild(optionNode);
        });
      } else {
        input = documentRef.createElement('input');
        input.type = field.type === 'password' ? 'password' : 'text';
        input.className = 'data-input';
      }

      const normalizedValue = Object.prototype.hasOwnProperty.call(values, field.key)
        ? values[field.key]
        : field.value;
      if (normalizedValue !== undefined && normalizedValue !== null) {
        input.value = String(normalizedValue);
      }
      if (field.placeholder) {
        input.placeholder = String(field.placeholder);
      }
      if (field.autocomplete) {
        input.autocomplete = String(field.autocomplete);
      }
      if (field.inputMode) {
        input.inputMode = String(field.inputMode);
      }
      if (field.rows && field.type === 'textarea') {
        input.rows = Number(field.rows) || 3;
      }
      input.dataset.fieldKey = String(field.key || '');
      label.htmlFor = field.key;
      input.id = field.key;
      wrapper.appendChild(input);

      if (field.type !== 'textarea') {
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') {
            return;
          }
          event.preventDefault();
          void handleConfirm();
        });
      }

      currentInputs.push({ field, input });
      return wrapper;
    }

    function collectValues() {
      return currentInputs.reduce((result, item) => {
        result[item.field.key] = item.input.value;
        return result;
      }, {});
    }

    async function handleConfirm() {
      if (!currentConfig) {
        close(null);
        return;
      }

      const values = collectValues();
      resetAlert();

      for (const item of currentInputs) {
        const { field, input } = item;
        const rawValue = values[field.key];
        const textValue = String(rawValue || '').trim();
        if (field.required && !textValue) {
          setAlert(field.requiredMessage || `${field.label || field.key}不能为空。`);
          input.focus?.();
          return;
        }
        if (typeof field.validate === 'function') {
          const validationMessage = await field.validate(rawValue, values);
          if (validationMessage) {
            setAlert(validationMessage);
            input.focus?.();
            return;
          }
        }
      }

      close(values);
    }

    function bindEvents() {
      overlay?.addEventListener('click', (event) => {
        if (event.target === overlay) {
          close(null);
        }
      });
      closeButton?.addEventListener('click', () => close(null));
      cancelButton?.addEventListener('click', () => close(null));
      confirmButton?.addEventListener('click', () => {
        void handleConfirm();
      });
    }

    async function open(config = {}) {
      if (!overlay || !titleNode || !fieldsContainer || !confirmButton) {
        return null;
      }
      if (resolver) {
        close(null);
      }

      currentConfig = config || {};
      currentInputs = [];
      titleNode.textContent = String(currentConfig.title || '填写表单');
      if (messageNode) {
        const message = String(currentConfig.message || '').trim();
        messageNode.textContent = message;
        setHidden(messageNode, !message);
      }
      resetAlert();
      if (currentConfig.alert?.text) {
        setAlert(currentConfig.alert.text, currentConfig.alert.tone || 'danger');
      }

      confirmButton.textContent = String(currentConfig.confirmLabel || '确认');
      confirmButton.className = `btn ${currentConfig.confirmVariant || 'btn-primary'} btn-sm`;
      fieldsContainer.innerHTML = '';

      const initialValues = currentConfig.initialValues && typeof currentConfig.initialValues === 'object'
        ? currentConfig.initialValues
        : {};
      const fields = Array.isArray(currentConfig.fields) ? currentConfig.fields : [];
      fields.forEach((field) => {
        fieldsContainer.appendChild(buildFieldNode(field, initialValues));
      });

      overlay.hidden = false;
      const firstInput = currentInputs[0]?.input || null;
      if (firstInput && typeof globalScope.requestAnimationFrame === 'function') {
        globalScope.requestAnimationFrame(() => firstInput.focus?.());
      } else {
        firstInput?.focus?.();
      }

      return new Promise((resolve) => {
        resolver = resolve;
      });
    }

    bindEvents();

    return {
      close,
      open,
    };
  }

  globalScope.SidepanelFormDialog = {
    createFormDialog,
  };
})(window);
