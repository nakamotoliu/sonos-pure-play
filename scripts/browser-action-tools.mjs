import { SkillError } from './normalize.mjs';

export function press(runner, targetId, key) {
  runner.oc(['press', key, '--target-id', targetId], { parseJson: false });
}

export function click(runner, targetId, ref) {
  runner.oc(['click', ref, '--target-id', targetId], { parseJson: false });
}

export function typeRef(runner, targetId, ref, text, { submit = false } = {}) {
  const args = ['type', ref, text, '--target-id', targetId];
  if (submit) args.push('--submit');
  const raw = runner.oc(args, { parseJson: false });
  return { ok: true, ref, text, submit, raw: String(raw || '').trim() };
}

export function fillRef(runner, targetId, ref, value) {
  const raw = runner.oc(
    ['fill', '--fields', JSON.stringify([{ ref, value }]), '--target-id', targetId],
    { parseJson: false }
  );
  return { ok: true, ref, value, raw: String(raw || '').trim() };
}

export function type(runner, targetId, text) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const active = document.activeElement;
      const readValue = (el) => ('value' in el ? el.value : (el?.textContent || '')) || '';
      if (!active) return { ok: false, reason: 'no-active-element' };
      active.focus?.();
      active.click?.();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      const current = String(readValue(active) || '');
      const next = current + ${JSON.stringify(text)};
      if (setter && ('value' in active)) setter.call(active, next);
      else if ('value' in active) active.value = next;
      else active.textContent = next;
      active.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        activeTag: active?.tagName || '',
        activeRole: active?.getAttribute?.('role') || '',
        activeValue: readValue(active),
      };
    }`
  );
  const typed = result?.result || result;
  if (!typed?.ok) {
    throw new SkillError('browser-action', 'TYPE_FAILED', 'Failed to type into the active browser element.', { targetId, text, typed });
  }
  return typed;
}

export function clickButtonByLabel(runner, targetId, labels = []) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const labels = ${JSON.stringify(['__LABELS__'])};
      const wanted = labels.filter((value) => value !== '__LABELS__');
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const buttons = [...document.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible);
      for (const label of wanted) {
        const target = buttons.find((el) => textOf(el) === label);
        if (target) {
          target.click();
          return { ok: true, clicked: label };
        }
      }
      return {
        ok: false,
        reason: 'button-not-found',
        labels: wanted,
        visibleButtons: buttons.map((el) => textOf(el)).filter(Boolean).slice(0, 40),
      };
    }`
      .replace(JSON.stringify(['__LABELS__']), JSON.stringify(labels))
  );
  return result?.result || result;
}

export function clickRoomActivate(runner, targetId, room) {
  const result = runner.evaluate(
    targetId,
    `() => {
      const targetRoom = ${JSON.stringify(room)};
      const exactActivateLabel = '将' + targetRoom + '设置为有效';
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const textOf = (el) => normalize(el?.getAttribute('aria-label') || el?.textContent || '');
      const mentionNodes = [...document.querySelectorAll('button,[role="button"],a,[role="link"],li,article,section,div,span')]
        .filter(visible)
        .filter((el) => textOf(el).includes(targetRoom));
      const cardRootOf = (el) => {
        if (!el) return null;
        for (let current = el, depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          const txt = textOf(current);
          if (!txt.includes(targetRoom)) continue;
          if (/设置为有效|输出选择器|播放群组|暂停群组/.test(txt)) return current;
        }
        return null;
      };
      const candidateCards = [...new Set(mentionNodes.map((el) => cardRootOf(el)).filter(Boolean))];
      const scored = candidateCards.map((card) => {
        const buttons = [...card.querySelectorAll('button,[role="button"],a,[role="link"]')].filter(visible);
        const labels = buttons.map((el) => textOf(el)).filter(Boolean);
        const targetButton = buttons.find((el) => textOf(el) === exactActivateLabel) || null;
        const rect = card.getBoundingClientRect();
        const score = (textOf(card).includes(targetRoom) ? 10 : 0) + (targetButton ? 20 : 0);
        return { labels, targetButton, rect, score };
      }).sort((a, b) => b.score - a.score);
      const best = scored[0] || null;
      if (!best) return { ok: false, reason: 'room-card-not-found', exactActivateLabel };
      if (!best.targetButton) {
        return {
          ok: true,
          skipped: true,
          reason: 'target-room-already-active',
          exactActivateLabel,
          roomCardButtons: best.labels.slice(0, 20),
        };
      }
      best.targetButton.click();
      return {
        ok: true,
        skipped: false,
        clicked: exactActivateLabel,
        roomCardButtons: best.labels.slice(0, 20),
        roomCardRect: { x: Math.round(best.rect.x), y: Math.round(best.rect.y), w: Math.round(best.rect.width), h: Math.round(best.rect.height) },
      };
    }`
  );
  return result?.result || result;
}
