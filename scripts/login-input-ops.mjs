function findLoginInputCode(kindLiteral = '') {
  return `(() => {
    const kind = ${JSON.stringify(kindLiteral)};
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const readValue = (el) => ('value' in el ? el.value : (el.textContent || '')) || '';
    const candidates = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].filter(visible);
    const score = (el) => {
      const type = (el.getAttribute('type') || '').trim().toLowerCase();
      const name = (el.getAttribute('name') || '').trim().toLowerCase();
      const autocomplete = (el.getAttribute('autocomplete') || '').trim().toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      let points = 0;
      const haystack = [name, autocomplete, placeholder, aria].join(' ').toLowerCase();
      if (kind === 'email') {
        if (type === 'email') points += 60;
        if (autocomplete.includes('email')) points += 50;
        if (haystack.includes('email') || haystack.includes('电子邮件')) points += 40;
      }
      if (kind === 'password') {
        if (type === 'password') points += 80;
        if (autocomplete.includes('current-password')) points += 50;
        if (haystack.includes('password') || haystack.includes('密码')) points += 40;
      }
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < window.innerHeight * 0.7) points += 10;
      return points;
    };
    const target = candidates
      .map((el, index) => ({ el, score: score(el) - index }))
      .sort((a, b) => b.score - a.score)[0]?.el || null;
    return { target, readValue };
  })()`;
}

export function focusVisibleLoginInput(runner, targetId, kind) {
  const helper = findLoginInputCode(kind);
  const result = runner.evaluate(
    targetId,
    `() => {
      const { target, readValue } = ${helper};
      if (!target) return { ok: false, reason: '${kind}-input-not-found' };
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.focus();
      target.click?.();
      const active = document.activeElement;
      return {
        ok: active === target,
        reason: active === target ? '' : 'focus-did-not-stick',
        tag: target.tagName,
        type: target.getAttribute('type') || '',
        placeholder: target.getAttribute('placeholder') || '',
        aria: target.getAttribute('aria-label') || '',
        beforeValue: readValue(target),
        activeTag: active?.tagName || '',
        activeType: active?.getAttribute?.('type') || '',
        activeValue: active ? readValue(active) : '',
      };
    }`
  );
  return result?.result || result;
}

export function replaceVisibleLoginValue(runner, targetId, kind, value) {
  const focusResult = focusVisibleLoginInput(runner, targetId, kind);
  if (!focusResult?.ok) return focusResult;

  runner.press(targetId, 'Meta+A');
  runner.press(targetId, 'Backspace');
  runner.type(targetId, value);

  const helper = findLoginInputCode(kind);
  const result = runner.evaluate(
    targetId,
    `() => {
      const expected = ${JSON.stringify(value)};
      const { target, readValue } = ${helper};
      if (!target) return { ok: false, reason: '${kind}-input-not-found' };
      const active = document.activeElement;
      const targetValue = readValue(target);
      return {
        ok: String(targetValue || '') === String(expected || ''),
        reason: String(targetValue || '') === String(expected || '') ? '' : 'typed-value-did-not-stick',
        targetTag: target.tagName || '',
        targetType: target.getAttribute('type') || '',
        targetValue,
        activeTag: active?.tagName || '',
        activeType: active?.getAttribute?.('type') || '',
        activeValue: active ? readValue(active) : '',
        same: active === target,
      };
    }`
  );
  return result?.result || result;
}

export function clickLoginButton(runner, targetId) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => String(el?.getAttribute('aria-label') || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
      const target = buttons.find((el) => textOf(el) === '登录');
      if (!target) return { ok: false, reason: 'login-button-not-found', buttons: buttons.map(textOf).filter(Boolean).slice(0, 20) };
      const disabled = target.disabled || target.getAttribute('aria-disabled') === 'true';
      if (disabled) return { ok: false, reason: 'login-button-disabled' };
      target.click();
      return { ok: true, clicked: '登录' };
    }`
  );
  runner.waitMs(1200);
  return result?.result || result;
}
