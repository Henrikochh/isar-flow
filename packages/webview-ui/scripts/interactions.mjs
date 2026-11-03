/* global document, window, getComputedStyle, NodeFilter */
/**
 * Behavior checks for the webviews: drives the browser harness like a user and asserts what happens (edits
 * that reach the YAML, selection and focus that follow, runs that finish). Looks are scripts/visual.mjs' job.
 *
 *   node scripts/interactions.mjs                   # every flow
 *   node scripts/interactions.mjs --only=sidebar    # flows whose name contains "sidebar"
 *   node scripts/interactions.mjs --only=resume,simulat  # containing any of the comma-separated parts
 *   node scripts/interactions.mjs --headed --slow=150
 *
 * Every flow also fails on page errors and console errors; React reports key collisions and bad updates there.
 * `latency` flows delay host messages (harness ?latency=) to catch edits that a slow host would lose.
 *
 * Every scripts/flows/*.mjs adds flows: its default export receives the assertion helpers
 * ({ check, checkEqual, until, pause, lowContrast, segmentEdges, unnamedControls }) and returns an array of
 * { name, options, run(h) }, where `h` is the same page helper object the flows below get.
 */
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = arg('only')?.split(',').filter(Boolean);
const slowMo = Number(arg('slow') ?? 0);
const headed = process.argv.includes('--headed');

/* ---------------- assertions ---------------- */

class CheckFailed extends Error {}

function check(condition, message) {
  if (!condition) throw new CheckFailed(message);
}

function checkEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new CheckFailed(`${message}\n      expected ${e}\n      actual   ${a}`);
}

/** Polls `probe` until it returns a truthy value; fails with `message` (and the last value) after `timeout`. */
async function until(probe, message, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new CheckFailed(`${message} (after ${timeout} ms; last: ${detail})`);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- page helpers ---------------- */

function helpers(page) {
  const h = {
    page,
    /** Messages the webview posted to the mock host, optionally of one type. */
    posted: (type) =>
      page.evaluate((t) => window.__harness.posted.filter((m) => !t || m.type === t), type ?? null),
    workflowYaml: () => page.evaluate(() => window.__harness.probe.workflowText?.() ?? ''),
    agentYaml: () => page.evaluate(() => window.__harness.probe.agentText?.() ?? ''),
    card: (id) => page.locator(`[data-wf-card][data-step-id="${id}"]`),
    /** Ids of the blocks in a list: the root (owner null), a loop body or an If lane ('then' / 'else'). */
    listIds: (owner = null, slot = 'steps') =>
      page.evaluate(
        ([owner, slot]) => {
          const blockId = (el) =>
            el.matches('[data-wf-card]')
              ? el.dataset.stepId
              : (el.querySelector(':scope > [data-wf-card]')?.dataset.stepId ?? '?');
          let list;
          if (!owner) list = document.querySelector('.wf-river > .wf-list');
          else {
            const head = [...document.querySelectorAll('[data-wf-card]')].find(
              (el) => el.dataset.stepId === owner,
            );
            const container = head?.closest('.wf-loop, .wf-if');
            if (container?.classList.contains('wf-loop'))
              list = container.querySelector(':scope > .wf-loop__body > .wf-list');
            else if (container)
              list = container.querySelector(
                `:scope > .wf-split > .wf-lanes > .wf-lane[aria-label="${slot === 'else' ? 'Else' : 'Then'}"] > .wf-list`,
              );
          }
          return list ? [...list.children].filter((el) => !el.classList.contains('wf-seg')).map(blockId) : [];
        },
        [owner, slot],
      ),
    /** What has the keyboard focus: a block id, else an accessible name or tag. */
    focused: () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'body';
        return (
          el.getAttribute('data-step-id') ??
          el.getAttribute('aria-label') ??
          el.textContent?.trim().slice(0, 40) ??
          el.tagName
        );
      }),
    /** Center of the river segment (drop slot) right above a block. */
    slotAbove: (id) => () =>
      page.evaluate((id) => {
        const head = [...document.querySelectorAll('[data-wf-card]')].find((el) => el.dataset.stepId === id);
        let block = head;
        while (block?.parentElement && !block.parentElement.classList.contains('wf-list'))
          block = block.parentElement;
        const seg = block?.previousElementSibling;
        if (!seg?.classList.contains('wf-seg')) throw new Error(`no slot above ${id}`);
        const r = seg.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, id),
    /** Drags `source` with the mouse and drops it on the point `target()` returns once the drag has started. */
    async drag(source, target) {
      await source.scrollIntoViewIfNeeded();
      const box = await source.boundingBox();
      const sx = box.x + Math.min(24, box.width / 2);
      const sy = box.y + box.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 14, sy + 10, { steps: 5 });
      await until(() => page.locator('.wf-canvas--dragging').count(), 'the drag starts');
      // Slots open with a transition; aim at where they end up.
      await pause(250);
      let point = await target();
      await page.mouse.move(point.x, point.y, { steps: 12 });
      await pause(200);
      point = await target();
      await page.mouse.move(point.x, point.y, { steps: 3 });
      await until(
        () => page.locator('.wf-slot--over, .wf-placeholder--over, .wf-empty-root--over').count(),
        'the slot under the pointer highlights',
      );
      await page.mouse.up();
      await until(async () => !(await page.locator('.wf-canvas--dragging').count()), 'the drag ends');
    },
  };
  return h;
}

/** Event listeners on window and document, by type (via the DevTools protocol). */
async function listeners(page) {
  const client = await page.context().newCDPSession(page);
  const counts = {};
  for (const expression of ['window', 'document']) {
    const { result } = await client.send('Runtime.evaluate', { expression });
    const { listeners: list } = await client.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId,
    });
    for (const l of list) counts[`${expression}:${l.type}`] = (counts[`${expression}:${l.type}`] ?? 0) + 1;
  }
  await client.detach();
  return counts;
}

const CONTROL_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/** Controls in the accessibility tree without an accessible name, described by tag and class. */
async function unnamedControls(page) {
  const client = await page.context().newCDPSession(page);
  const { nodes } = await client.send('Accessibility.getFullAXTree');
  const bad = [];
  for (const node of nodes) {
    if (node.ignored || !CONTROL_ROLES.has(node.role?.value)) continue;
    if ((node.name?.value ?? '').trim()) continue;
    let where = '';
    if (node.backendDOMNodeId) {
      const { node: dom } = await client.send('DOM.describeNode', { backendNodeId: node.backendDOMNodeId });
      const attrs = dom.attributes ?? [];
      const cls = attrs[attrs.indexOf('class') + 1];
      where = `${dom.nodeName.toLowerCase()}${attrs.includes('class') ? `.${cls.split(' ').join('.')}` : ''}`;
    }
    bad.push(`${node.role.value} ${where}`);
  }
  await client.detach();
  return bad;
}

/**
 * Puts color helpers on `window.__colors` (WCAG luminance and ratio, alpha blending, the opaque background behind
 * an element). Chromium reports color-mix() results as `color(srgb r g b / a)`, so both that and rgb() parse.
 */
async function installColorTools(page) {
  await page.evaluate(() => {
    if (window.__colors) return;
    const channels = (list) =>
      list
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
    const parse = (c) => {
      const rgb = c.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const [r, g, b, a = 1] = channels(rgb[1]);
        return { r, g, b, a };
      }
      const srgb = c.match(/color\(srgb ([^)]+)\)/);
      if (srgb) {
        const [r, g, b, a = 1] = channels(srgb[1]);
        return { r: r * 255, g: g * 255, b: b * 255, a };
      }
      return null;
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (x, y) => {
      const [hi, lo] = [lum(x), lum(y)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };
    const blend = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const background = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.backgroundImage !== 'none') return null;
        const c = parse(style.backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 1) break;
        }
      }
      if (!layers.length) return null;
      return layers.reduceRight((acc, layer) => blend(layer, acc));
    };
    window.__colors = { parse, lum, ratio, blend, background };
  });
}

/** Visible text whose contrast against its (opaque) background is below `min`, as "ratio text (.class)". */
async function lowContrast(page, min) {
  // Slide-ins fade from transparent; measure once they have settled (spinners and pulses never end).
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await installColorTools(page);
  return page.evaluate((min) => {
    const { parse, ratio: contrast, blend, background } = window.__colors;
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent.trim()) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.visibility !== 'visible' || rect.width === 0 || rect.height === 0) continue;
      if (el.closest('[aria-hidden="true"], [inert], .wf-river--stale, [disabled], [aria-disabled="true"]'))
        continue;
      let opacity = 1;
      for (let e = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
      const bg = background(el);
      const fg = parse(style.color);
      if (!bg || !fg) continue;
      const ratio = contrast(blend({ ...fg, a: fg.a * opacity }, bg), bg);
      const large =
        parseFloat(style.fontSize) >= 18.66 ||
        (parseFloat(style.fontSize) >= 14 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? Math.min(min, 3) : min)) {
        const where = [...el.classList].slice(0, 2).join('.') || el.tagName.toLowerCase();
        out.push(`${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 40)}" (.${where})`);
      }
    }
    return out;
  }, min);
}

/**
 * Segmented controls on the page, each with the contrast of its selected segment's edge (the inset ring over the
 * fill, else the fill) against the track; WCAG 1.4.11 asks 3:1 for the visual that marks a state.
 */
async function segmentEdges(page) {
  await installColorTools(page);
  return page.evaluate(() => {
    const { parse, ratio, blend, background } = window.__colors;
    return [...document.querySelectorAll('.if-segmented')].map((track) => {
      const item = track.querySelector('[aria-checked="true"], [aria-selected="true"]');
      const name = track.getAttribute('aria-label');
      if (!item) return { name, ratio: 0, selected: '(none)' };
      const trackBg = background(track);
      const fill = background(item);
      // Behind a gradient or image the colors cannot be measured; NaN fails the check and says so.
      if (!trackBg || !fill) return { name, ratio: NaN, selected: item.textContent.trim() };
      const ring = getComputedStyle(item)
        .boxShadow.split(/,(?![^(]*\))/)
        .find((shadow) => /\binset\b/.test(shadow));
      const ringColor = ring ? parse(ring) : null;
      const edge = ringColor ? blend(ringColor, fill) : fill;
      return {
        name,
        selected: item.textContent.trim(),
        ratio: Math.max(ratio(edge, trackBg), ratio(fill, trackBg)),
      };
    });
  });
}

/* ---------------- flows ---------------- */

const FLOWS = [];
/** Registers a flow: `options` picks the harness page (view, scenario, viewport, latency, theme). */
const flow = (name, options, run) => FLOWS.push({ name, options, run });

/* ---- workflow editor ---- */

flow('workflow: palette click inserts a block after the selection', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('implement').click();
  await page.locator('.wf-pal-item', { hasText: 'Console' }).click();
  await until(async () => (await h.listIds()).length === 3, 'a third block appears at the top level');
  checkEqual(
    await h.listIds(),
    ['implement', 'console_1', 'review_loop'],
    'the console block lands after the selection',
  );
  check((await h.card('console_1').getAttribute('aria-pressed')) === 'true', 'the new block is selected');
  check((await h.workflowYaml()).includes('id: console_1'), 'the YAML has the new block');
  // Break only fits inside a loop: the palette says so instead of inserting it at the top level.
  const breakItem = page.locator('.wf-pal-item', { hasText: 'Break' });
  check((await breakItem.getAttribute('aria-disabled')) === 'true', 'Break is unavailable outside a loop');
  await h.card('tests').click();
  await until(
    async () => (await breakItem.getAttribute('aria-disabled')) === null,
    'Break is offered inside a loop',
  );
  await breakItem.click();
  await until(async () => (await h.listIds('review_loop')).includes('break_1'), 'Break lands in the loop');
  checkEqual(
    (await h.listIds('review_loop')).slice(0, 2),
    ['tests', 'break_1'],
    'Break lands after the selection',
  );
});

flow('workflow: drag a palette item onto a slot', { view: 'workflow', height: 1200 }, async (h) => {
  const { page } = h;
  await h.drag(page.locator('.wf-pal-item', { hasText: 'Approval' }), h.slotAbove('review'));
  await until(
    async () => (await h.listIds('review_loop')).includes('approval_1'),
    'the approval block is inserted',
  );
  checkEqual(
    await h.listIds('review_loop'),
    ['tests', 'approval_1', 'review', 'needs_fix'],
    'it lands in the slot',
  );
  check(
    (await h.card('approval_1').getAttribute('aria-pressed')) === 'true',
    'the dropped block is selected',
  );
  // An agent from the palette becomes an agent block that uses it.
  await h.drag(page.locator('.wf-pal-item', { hasText: 'Docs writer' }), h.slotAbove('review_loop'));
  await until(async () => (await h.listIds()).includes('agent_1'), 'the agent block is inserted');
  check(
    /id: agent_1\s+type: agent\s+agent: docs-writer/.test(await h.workflowYaml()),
    'the block uses the agent',
  );
});

flow('workflow: drag a card into a loop', { view: 'workflow', height: 1200 }, async (h) => {
  await h.drag(h.card('implement'), h.slotAbove('tests'));
  await until(async () => (await h.listIds()).length === 1, 'implement leaves the top level');
  checkEqual(
    await h.listIds('review_loop'),
    ['implement', 'tests', 'review', 'needs_fix'],
    'implement is first in the loop',
  );
  // A container cannot move into itself: no slot inside the loop opens while the loop is dragged.
  const { page } = h;
  const head = h.card('review_loop');
  const box = await head.boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + box.height / 2 + 10, { steps: 5 });
  await until(() => page.locator('.wf-canvas--dragging').count(), 'the loop drag starts');
  const insideOpen = await page.locator('.wf-loop__body .wf-seg--open').count();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  checkEqual(insideOpen, 0, 'no slot inside the dragged loop opens');
});

flow('workflow: Move to… menu moves a block', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('tests').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const targets = await page.getByRole('menu', { name: 'Move to' }).getByRole('menuitem').allInnerTexts();
  check(
    targets.some((t) => t.includes('Top level')),
    'the top level is offered',
  );
  await page.getByRole('menuitem', { name: /Top level/ }).click();
  await until(async () => (await h.listIds()).includes('tests'), 'tests moves to the top level');
  checkEqual(await h.listIds(), ['implement', 'review_loop', 'tests'], 'it lands at the end of the workflow');
  await until(async () => (await h.focused()) === 'tests', 'focus stays on the moved block');
  // The inspector's Move button offers the same targets.
  await page.getByRole('button', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: /Then/ }).first().click();
  await until(async () => (await h.listIds('needs_fix', 'then')).includes('tests'), 'tests moves into Then');
});

flow('workflow: keyboard selection, Ctrl+D, Alt+arrows and Delete', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('implement').click();
  await page.keyboard.press('ArrowDown');
  await until(async () => (await h.focused()) === 'review_loop', 'ArrowDown moves to the loop');
  await page.keyboard.press('ArrowDown');
  await until(async () => (await h.focused()) === 'tests', 'ArrowDown moves into the loop');
  check((await h.card('tests').getAttribute('aria-pressed')) === 'true', 'the focused block is selected');

  await page.keyboard.press('Control+d');
  await until(async () => (await h.listIds('review_loop')).length === 4, 'Ctrl+D duplicates the block');
  const [first, copy] = await h.listIds('review_loop');
  check(first === 'tests' && copy !== 'tests', `the copy follows the original (${copy})`);
  await until(async () => (await h.focused()) === 'tests', 'focus stays on the original');

  await page.keyboard.press('Alt+ArrowDown');
  await until(async () => (await h.listIds('review_loop'))[1] === 'tests', 'Alt+Down moves the block down');
  await until(async () => (await h.focused()) === 'tests', 'focus follows the moved block');
  await page.keyboard.press('Alt+ArrowUp');
  await until(async () => (await h.listIds('review_loop'))[0] === 'tests', 'Alt+Up moves it back');

  await page.keyboard.press('Delete');
  await until(async () => !(await h.listIds('review_loop')).includes('tests'), 'Delete removes the block');
  await until(async () => (await h.focused()) === copy, 'focus moves to the next block');
  check((await h.card(copy).getAttribute('aria-pressed')) === 'true', 'the next block is selected');
  await page.keyboard.press('Escape');
  await until(
    async () => (await page.locator('[data-wf-card][aria-pressed="true"]').count()) === 0,
    'Escape clears',
  );
  check((await h.focused()) === 'Workflow canvas', 'focus returns to the canvas');
});

flow('workflow: editing the task updates the card after the pause', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('implement').click();
  const task = page.getByLabel('Task', { exact: true });
  await task.fill('Write the release notes for ${{ inputs.task }}');
  check((await h.posted('ops')).length === 0, 'nothing is sent while typing');
  await until(
    async () => (await h.card('implement').innerText()).includes('Write the release notes'),
    'the card shows the task',
  );
  check(
    (await h.workflowYaml()).includes('Write the release notes for ${{ inputs.task }}'),
    'the YAML has the task',
  );
  // Typing and switching blocks before the pause must not lose the text.
  await task.fill('Ship it');
  await h.card('review').click();
  await until(
    async () => (await h.card('implement').innerText()).includes('Ship it'),
    'the edit survives a block switch',
  );
});

for (const latency of [0, 300]) {
  flow(
    `workflow: pausing after a space keeps the space${latency ? ' (slow host)' : ''}`,
    { view: 'workflow', latency },
    async (h) => {
      const { page } = h;
      await h.card('implement').click();
      const name = page.getByLabel('Block name');
      await name.click();
      await page.keyboard.type('Build ');
      await pause(700 + latency);
      await page.keyboard.type('it');
      check((await name.inputValue()) === 'Build it', `the field reads "${await name.inputValue()}"`);
      await page.keyboard.press('Tab');
      await until(async () => /name: Build it\n/.test(await h.workflowYaml()), 'the YAML has the name', 3000);
      await until(
        async () => (await h.card('implement').innerText()).includes('Build it'),
        'the card shows it',
      );
    },
  );
}

flow('workflow: renaming an id updates its references', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('tests').click();
  const id = page.getByLabel('Id', { exact: true });
  await id.fill('unit_tests');
  await id.press('Enter');
  await until(() => h.card('unit_tests').count(), 'the card has the new id');
  // The canvas shows the new id before the host has written the YAML.
  const yaml = await until(async () => {
    const text = await h.workflowYaml();
    return text.includes('steps.unit_tests.exitCode') && text;
  }, 'the YAML uses the new id');
  check(!yaml.includes('steps.tests.'), 'references use the new id');
  check((await h.card('unit_tests').getAttribute('aria-pressed')) === 'true', 'the block stays selected');
  check((await id.inputValue()) === 'unit_tests', 'the inspector shows the new id');
  await id.fill('review');
  check(
    (await page.getByText("Another block already uses the id 'review'.").count()) === 1,
    'a taken id is refused',
  );
  await id.press('Enter');
  await pause(300);
  check(
    !(await h.posted('ops')).some((m) => m.ops.some((op) => op.newId === 'review')),
    'nothing is sent for it',
  );
});

flow('workflow: condition builder adds a rule and the summary follows', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('review_loop').click();
  const summary = page.locator('.wf-cond-summary');
  const before = await summary.innerText();
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.getByRole('button', { name: 'Rule 3 value' }).click();
  await page.getByLabel('Filter options').fill('implement status');
  await page.keyboard.press('Enter');
  await until(async () => (await summary.innerText()) !== before, 'the summary includes the new rule');
  const operand = page.getByLabel('Rule 3 compare with');
  await operand.fill('success');
  await operand.press('Enter');
  await until(
    async () => (await summary.innerText()).includes('success'),
    'the summary shows the compared value',
  );
  await until(
    async () => (await h.card('review_loop').innerText()).includes('success'),
    'the loop header shows it too',
  );
  const yaml = await h.workflowYaml();
  check(/steps\.implement\.status/.test(yaml) && /to: "?success"?/.test(yaml), 'the rule is in the YAML');
  // Removing a rule rewrites the condition without it.
  await page.getByRole('button', { name: 'Remove rule 3' }).click();
  await until(async () => !(await summary.innerText()).includes('success'), 'the rule is removed');
});

flow(
  'workflow: Run asks for inputs and the simulated run finishes',
  { view: 'workflow', timeout: 90_000 },
  async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Run Review until approved' });
    await dialog.waitFor();
    const runButton = dialog.getByRole('button', { name: 'Run workflow' });
    check(await runButton.isDisabled(), 'Run workflow waits for the required input');
    await dialog.getByLabel('task').fill('Add voucher codes');
    await runButton.click();
    await until(async () => (await h.posted('run')).length === 1, 'the run is requested');
    checkEqual((await h.posted('run'))[0].inputs, { task: 'Add voucher codes' }, 'with the inputs');
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    check(await page.getByRole('timer', { name: 'Elapsed time' }).isVisible(), 'the elapsed time shows');
    await until(
      async () =>
        (
          await page
            .locator('.wf-marker__outcome')
            .innerText()
            .catch(() => '')
        ).includes('Succeeded'),
      'the run succeeds',
      60_000,
    );
    for (const id of ['implement', 'review_loop', 'tests', 'review']) {
      const glyph = h.card(id).locator('[role="img"][aria-label="Succeeded"]');
      const inLoopAside = page.locator('.wf-loop__aside [role="img"][aria-label="Succeeded"]');
      check(
        (await glyph.count()) > 0 || (id === 'review_loop' && (await inLoopAside.count()) > 0),
        `${id} shows Succeeded`,
      );
    }
    check((await page.getByRole('button', { name: 'Run', exact: true }).count()) === 1, 'Run is back');
    // A second run starts from the remembered inputs.
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    checkEqual(
      await dialog.getByLabel('task').inputValue(),
      'Add voucher codes',
      'the inputs are remembered',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  },
);

flow('workflow: Stop cancels a live run', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('task').fill('Anything');
  await dialog.getByLabel('task').press('Control+Enter');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await until(async () => (await h.posted('cancelRun')).length === 1, 'cancel is sent');
  await until(
    async () =>
      (
        await page
          .locator('.wf-marker__outcome')
          .innerText()
          .catch(() => '')
      ).includes('Cancelled'),
    'the run ends as cancelled',
    10_000,
  );
});

flow('workflow: Run dialog keeps the focus inside', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  check(await dialog.evaluate((el) => el.contains(document.activeElement)), 'focus starts in the dialog');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    check(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      `Tab ${i + 1} stays in the dialog`,
    );
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+Tab');
    check(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
      `Shift+Tab ${i + 1} stays in the dialog`,
    );
  }
  await page.keyboard.press('Escape');
  await until(async () => !(await dialog.count()), 'Escape closes the dialog');
  check((await h.focused()) === 'Run', 'focus returns to Run');
});

flow(
  'workflow: approval banner approves and rejects',
  { view: 'workflow', scenario: 'approval' },
  async (h) => {
    const { page } = h;
    await page.getByText('Approval needed').waitFor();
    await page.getByLabel('Comment').fill('Looks good');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await until(async () => (await h.posted('approval')).length === 1, 'the answer is sent');
    checkEqual(
      (await h.posted('approval'))[0],
      { type: 'approval', requestId: 'approval-1', approved: true, comment: 'Looks good' },
      'approved with the comment',
    );
    await until(async () => !(await page.getByText('Approval needed').count()), 'the banner goes away');
  },
);

flow(
  'workflow: a live approval rejected fails the run',
  { view: 'workflow', scenario: 'approval-live', timeout: 90_000 },
  async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('task').fill('Ship vouchers');
    await dialog.getByRole('button', { name: 'Run workflow' }).click();
    await page.getByText('Approval needed').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await until(
      async () =>
        (
          await page
            .locator('.wf-marker__outcome')
            .innerText()
            .catch(() => '')
        ).includes('Failed'),
      'the run fails after the rejection',
      15_000,
    );
    check((await h.posted('approval')).at(-1).approved === false, 'the rejection was sent');
  },
);

flow(
  'workflow: invalid file lists its problems and selects the block',
  { view: 'workflow', scenario: 'invalid' },
  async (h) => {
    const { page } = h;
    const run = page.getByRole('button', { name: 'Run', exact: true });
    check(await run.isDisabled(), 'Run is disabled');
    await page.getByRole('button', { name: /problem/ }).click();
    const items = page.getByRole('menu', { name: 'Problems' }).getByRole('menuitem');
    check((await items.count()) > 0, 'the problems are listed');
    await items.filter({ hasText: 'implement' }).first().click();
    await until(
      async () => (await h.card('implement').getAttribute('aria-pressed')) === 'true',
      'the block is selected',
    );
    check(
      (await page.locator('[data-wf-inspector] .wf-insp-name').getAttribute('placeholder')) === 'implement',
      'the inspector shows it',
    );
  },
);

flow('workflow: Add ids gives every block an id', { view: 'workflow', scenario: 'noids' }, async (h) => {
  const { page } = h;
  check((await page.getByText('No id', { exact: true }).count()) === 2, 'two blocks have no id');
  await page.getByRole('button', { name: 'Add ids' }).click();
  await until(
    async () => (await page.getByText('No id', { exact: true }).count()) === 0,
    'the badges go away',
  );
  check((await page.locator('[data-wf-card]:not([data-step-id])').count()) === 0, 'every card has an id');
  check((await page.getByRole('button', { name: 'Add ids' }).count()) === 0, 'the banner goes away');
});

flow('workflow: Runs menu shows a past run', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await page.getByRole('button', { name: /Runs/ }).click();
  const menu = page.getByRole('menu', { name: 'Runs' });
  // Indented items are actions of the run above them ("Run from tests" under the failed run).
  const items = menu.locator('[role="menuitem"]:not(.if-menu__item--indent)');
  checkEqual(await items.count(), 6, 'six past runs');
  checkEqual(
    (await menu.locator('.if-menu__item--indent').allInnerTexts()).map((text) => text.trim()),
    ['Run from tests'],
    'the failed run offers to run from where it stopped',
  );
  check((await items.nth(0).innerText()).includes('2 to review'), 'the newest run has files to review');
  check(
    (await items.nth(1).innerText()).includes('3 kept, 1 reverted'),
    'the run before says what was decided',
  );
  const failed = items.filter({ has: page.locator('[aria-label="Failed"]') });
  await failed.click();
  await until(async () => (await h.posted('selectRun')).length === 1, 'the run is requested');
  checkEqual((await h.posted('selectRun'))[0].runId, 'run-3', 'the failed run');
  await until(
    async () => (await page.locator('.wf-runs').innerText()).includes('Failed'),
    'the run button names it',
  );
  check((await h.card('tests').locator('[aria-label="Failed"]').count()) === 1, 'the failed block is marked');
  check(
    (await page.getByRole('tab', { name: 'Run summary' }).getAttribute('aria-selected')) === 'true',
    'the summary shows',
  );
  await page.locator('.wf-runs').click();
  check((await failed.getAttribute('aria-current')) === 'true', 'the shown run is marked current');
  await page.keyboard.press('Escape');
  check((await h.focused()).includes('Failed'), 'Escape returns focus to the runs button');
});

flow('workflow: Escape closes popovers and returns focus', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('review').click();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Block actions' }).waitFor();
  await until(
    async () => (await h.focused()) === 'Move to…' || (await h.focused()).startsWith('Move to'),
    'the menu takes focus',
  );
  await page.keyboard.press('Escape');
  await until(async () => (await h.focused()) === 'review', 'focus returns to the block');
  await page.getByRole('button', { name: 'Insert variable' }).first().click();
  await page.getByLabel('Search variables').waitFor();
  await page.keyboard.press('Escape');
  await until(async () => (await h.focused()) === 'Insert variable', 'focus returns to the variable button');
});

flow(
  'workflow: Tab out of a menu closes it and continues after its button',
  { view: 'workflow' },
  async (h) => {
    const { page } = h;
    await page.locator('.wf-runs').click();
    await page.getByRole('menu', { name: 'Runs' }).waitFor();
    await until(async () => (await h.focused()) !== 'body', 'the menu takes focus');
    await page.keyboard.press('Tab');
    await until(async () => !(await page.getByRole('menu', { name: 'Runs' }).count()), 'Tab closes the menu');
    check(
      (await h.focused()) === 'Open YAML',
      `focus moves to the next control, not the top of the page (${await h.focused()})`,
    );
    // The block picker on the river: Shift+Tab goes back to the "+" that opened it.
    await page.locator('.wf-insert').nth(1).click();
    await page.getByRole('menu', { name: 'Add block' }).waitFor();
    await page.keyboard.press('Shift+Tab');
    await until(
      async () => !(await page.getByRole('menu', { name: 'Add block' }).count()),
      'Shift+Tab closes the picker',
    );
    check((await h.focused()) !== 'body', 'focus stays on the canvas');
  },
);

flow('workflow: menus and popovers leave no listeners behind', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('review').click();
  const before = await listeners(page);
  // Each popover moves the focus inside on the next frame; Escape is pressed once it has.
  const openAndEscape = async (open) => {
    await open();
    await until(
      () => page.evaluate(() => Boolean(document.activeElement?.closest('.if-popover'))),
      'the popover takes the focus',
    );
    await page.keyboard.press('Escape');
    await until(async () => !(await page.locator('.if-popover').count()), 'Escape closes it');
  };
  for (let i = 0; i < 3; i++) {
    await openAndEscape(() => h.card('review').click({ button: 'right' }));
    await openAndEscape(() => page.locator('.wf-runs').click());
    await openAndEscape(() => page.getByRole('button', { name: 'Insert variable' }).first().click());
    await openAndEscape(() => page.locator('.wf-insert').first().click());
  }
  await pause(200);
  checkEqual(await listeners(page), before, 'listener counts are unchanged');
});

flow('workflow: Tab reaches the palette, the canvas and the inspector', { view: 'workflow' }, async (h) => {
  const { page } = h;
  await h.card('review').click();
  await page.locator('.wf-name').focus();
  const seen = [];
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { where: 'body' };
        const r = el.getBoundingClientRect();
        return {
          where: el.closest('.wf-palette')
            ? 'palette'
            : el.closest('[data-wf-inspector]')
              ? 'inspector'
              : el.matches('[data-wf-card]')
                ? 'card'
                : el.closest('.wf-topbar')
                  ? 'topbar'
                  : 'other',
          // Checkbox and switch inputs are hidden; their label draws the box and the focus ring.
          visible: (r.width > 0 && r.height > 0) || Boolean(el.closest('.if-check, .if-switch')),
          label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30),
        };
      }),
    );
  }
  for (const where of ['topbar', 'palette', 'card', 'inspector'])
    check(
      seen.some((s) => s.where === where),
      `Tab reaches the ${where}`,
    );
  const hidden = seen.filter((s) => s.where !== 'body' && !s.visible);
  check(hidden.length === 0, `Tab never lands on invisible elements: ${JSON.stringify(hidden.slice(0, 3))}`);
  check(
    seen.filter((s) => s.where === 'card').length <= 3,
    'the canvas is one tab stop (roving focus), not one per block',
  );
});

flow('workflow: edits under a slow host are not lost', { view: 'workflow', latency: 350 }, async (h) => {
  const { page } = h;
  await h.card('review_loop').click();
  await page.getByRole('button', { name: 'Add rule' }).waitFor();
  // Typing in one rule and removing another right after must keep both changes.
  const operand = page.getByLabel('Rule 1 compare with');
  await operand.fill('7');
  await page.getByRole('button', { name: 'Remove rule 2' }).click();
  await until(
    async () => (await page.locator('.wf-cond-rules > li').count()) === 1,
    'the removed rule goes',
    3000,
  );
  await pause(1200);
  const yaml = await h.workflowYaml();
  const condition = yaml.slice(yaml.indexOf('until:'), yaml.indexOf('maxIterations:'));
  check(/to: 7/.test(condition), `the typed value survives the removal of another rule:\n${condition}`);
  check(!condition.includes('approved'), 'rule 2 is gone');
  check((await operand.inputValue()) === '7', 'the field still shows the typed value');
});

flow('workflow: every control has an accessible name', { view: 'workflow' }, async (h) => {
  const { page } = h;
  const bad = await unnamedControls(page);
  await h.card('review').click();
  await page.getByRole('button', { name: 'Advanced' }).click();
  bad.push(...(await unnamedControls(page)));
  await h.card('review_loop').click();
  bad.push(...(await unnamedControls(page)));
  check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
});

/* ---- sidebar ---- */

flow(
  'sidebar: tabs switch with the mouse and the arrow keys',
  { view: 'sidebar', width: 340, height: 820 },
  async (h) => {
    const { page } = h;
    await page.getByRole('tab', { name: /Workflows/ }).click();
    check(
      (await page.getByRole('tabpanel').getAttribute('aria-label')) === 'Workflows',
      'the workflows panel shows',
    );
    await until(
      async () => (await h.posted('setTab')).some((m) => m.tab === 'workflows'),
      'the host hears about it',
    );
    await page.keyboard.press('ArrowLeft');
    await until(
      async () => (await page.getByRole('tab', { name: /Agents/ }).getAttribute('aria-selected')) === 'true',
      'ArrowLeft selects Agents',
    );
    check((await h.focused()).startsWith('Agents'), 'focus follows the tab');
    check(
      (await page.getByRole('tabpanel').getAttribute('aria-label')) === 'Agents',
      'the agents panel shows',
    );
  },
);

flow('sidebar: create an agent inline', { view: 'sidebar', width: 340, height: 820 }, async (h) => {
  const { page } = h;
  await page.getByRole('button', { name: 'New agent' }).click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await until(
    async () =>
      (await h.focused()) !== 'body' && (await name.evaluate((el) => el === document.activeElement)),
    'the name field takes focus',
  );
  await name.fill('Coder');
  await page.getByRole('button', { name: 'Create agent' }).click();
  check(
    (await page.getByText('This workspace already has an agent named Coder').count()) === 1,
    'a taken name is explained',
  );
  check((await h.posted('createAgent')).length === 0, 'nothing is created');
  await name.fill('Translator');
  await page.getByRole('radio', { name: 'Reviewer' }).click();
  check((await name.inputValue()) === 'Translator', 'a typed name survives picking a starter');
  await page.getByRole('button', { name: 'Create agent' }).click();
  await until(async () => (await h.posted('createAgent')).length === 1, 'the agent is created');
  checkEqual(
    (await h.posted('createAgent'))[0],
    { type: 'createAgent', name: 'Translator', scope: 'workspace', starter: 'reviewer' },
    'with the choices',
  );
  await until(() => page.locator('.sb-row__name', { hasText: 'Translator' }).count(), 'it is listed');
  check((await h.focused()) === 'New agent', 'focus returns to New');
  await page.keyboard.press('Enter');
  await name.waitFor();
  await page.keyboard.press('Escape');
  await until(async () => !(await name.count()), 'Escape closes the card');
  check((await h.focused()) === 'New agent', 'focus returns to New after Escape');
});

flow(
  'sidebar: delete an agent after confirming inline',
  { view: 'sidebar', width: 340, height: 820 },
  async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Delete Docs writer' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    check((await h.focused()) === 'Delete Docs writer', 'Cancel returns focus to Delete');
    await page.getByRole('button', { name: 'Delete Docs writer' }).click();
    await page.getByRole('button', { name: 'Delete agent' }).click();
    await until(async () => (await h.posted('deleteAgent')).length === 1, 'the delete is sent once');
    await until(
      async () => !(await page.locator('.sb-row__name', { hasText: 'Docs writer' }).count()),
      'the row goes',
    );
  },
);

flow(
  'sidebar: create a workflow inline',
  { view: 'sidebar', scenario: 'workflows', width: 340, height: 900 },
  async (h) => {
    const { page } = h;
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Nightly checks');
    await page.getByRole('radio', { name: /Test and fix/ }).click();
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await until(async () => (await h.posted('createWorkflow')).length === 1, 'the workflow is created');
    checkEqual(
      (await h.posted('createWorkflow'))[0],
      { type: 'createWorkflow', name: 'Nightly checks', template: 'test-fix' },
      'with the template',
    );
    await until(() => page.locator('.sb-row__name', { hasText: 'Nightly checks' }).count(), 'it is listed');
  },
);

flow(
  'sidebar: run and stop a workflow',
  { view: 'sidebar', scenario: 'workflows', width: 340, height: 900 },
  async (h) => {
    const { page } = h;
    const first = (await page.locator('.sb-row__name').first().innerText()).trim();
    await page.getByRole('button', { name: `Run ${first}` }).click();
    await until(async () => (await h.posted('runWorkflow')).length === 1, 'the run is requested');
    const stop = page.getByRole('button', { name: `Stop ${first}` });
    await stop.waitFor();
    await until(async () => (await h.focused()) === `Stop ${first}`, 'focus moves to Stop');
    check(
      (await page.locator('.sb-run').first().innerText()).includes('Running'),
      'Recent runs lists it first',
    );
    await page.keyboard.press('Enter');
    await until(async () => (await h.posted('cancelRun')).length === 1, 'the stop is sent');
    await until(async () => (await h.focused()) === `Run ${first}`, 'focus moves back to Run');
    check(
      (await page.locator('.sb-run').first().getByRole('img', { name: 'Cancelled' }).count()) === 1,
      'the run is cancelled',
    );
  },
);

flow(
  'sidebar: every control has an accessible name',
  { view: 'sidebar', width: 340, height: 820 },
  async (h) => {
    const { page } = h;
    const bad = await unnamedControls(page);
    await page.getByRole('tab', { name: /Workflows/ }).click();
    bad.push(...(await unnamedControls(page)));
    await page.getByRole('button', { name: 'New workflow' }).click();
    bad.push(...(await unnamedControls(page)));
    check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
  },
);

/* ---- agent editor ---- */

flow('agent: editing fields writes the file', { view: 'agent', width: 1280, height: 900 }, async (h) => {
  const { page } = h;
  const name = page.getByRole('textbox', { name: 'Agent name' });
  await name.fill('Strict reviewer');
  await name.press('Enter');
  await until(async () => (await h.agentYaml()).includes('name: Strict reviewer'), 'the name is saved');
  const prompt = page.getByLabel('System prompt');
  await prompt.fill('Review like a hawk.');
  await page.keyboard.press('Tab');
  await until(
    async () => (await h.agentYaml()).includes('Review like a hawk.'),
    'the system prompt is saved',
  );
  const temperature = page.getByLabel('Temperature');
  await temperature.fill('0.7');
  await temperature.blur();
  await until(async () => (await h.agentYaml()).includes('temperature: 0.7'), 'the temperature is saved');
  await temperature.fill('warm');
  await temperature.blur();
  await page.getByText('Enter a number.').waitFor();
  check((await h.agentYaml()).includes('temperature: 0.7'), 'a typo is not written');
  const always = page
    .locator('.ag-permission', { hasText: 'Edit files' })
    .getByRole('radio', { name: 'Always' });
  check(await always.isDisabled(), 'Edit files permission waits for an edit tool');
  await page.locator('.if-check', { hasText: 'Edit files' }).click();
  await until(async () => /tools: \[.*editFile/.test(await h.agentYaml()), 'the tool is added');
  await until(async () => !(await always.isDisabled()), 'the permission can be set');
  await always.click();
  await until(async () => /edits: auto/.test(await h.agentYaml()), 'the permission is saved');
});

flow('agent: Try it streams an answer', { view: 'agent', width: 1280, height: 900 }, async (h) => {
  const { page } = h;
  const box = page.getByRole('textbox', { name: 'Message to the agent' });
  await box.fill('Review my change');
  await box.press('Enter');
  await until(async () => (await h.posted('tryIt')).length === 1, 'the prompt is sent');
  checkEqual((await h.posted('tryIt'))[0].prompt, 'Review my change', 'with the text');
  check((await box.inputValue()) === '', 'the composer clears');
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  await until(
    async () => (await page.getByRole('log').innerText()).includes('No test covers expired vouchers'),
    'the answer streams in',
    8000,
  );
  await page.getByRole('button', { name: 'Send' }).waitFor();
  check((await page.getByRole('log').getAttribute('aria-busy')) === 'false', 'the log is no longer busy');
  check((await page.locator('.ag-user__bubble').innerText()) === 'Review my change', 'the question is shown');
});

flow(
  'agent: Stop ends the answer and keeps the focus in the composer',
  { view: 'agent', width: 1280, height: 900 },
  async (h) => {
    const { page } = h;
    const box = page.getByRole('textbox', { name: 'Message to the agent' });
    await box.fill('Review my change');
    await page.getByRole('button', { name: 'Send' }).click();
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await stop.waitFor();
    await stop.click();
    await until(async () => (await h.posted('cancelTryIt')).length === 1, 'cancel is sent');
    await pause(1500);
    check(
      !(await page.getByRole('log').innerText()).includes('No test covers expired vouchers'),
      'the answer stops',
    );
    await page.getByRole('button', { name: 'Send' }).waitFor();
    check((await h.focused()) === 'Message to the agent', 'focus goes to the composer, not the page');
  },
);

flow('agent: Used by opens the workflow', { view: 'agent', width: 1280, height: 900 }, async (h) => {
  const { page } = h;
  await page
    .getByRole('button', { name: 'Open workflow .isarflow/workflows/review-loop.workflow.yaml' })
    .click();
  await until(async () => (await h.posted('openWorkflow')).length === 1, 'the workflow is opened');
  checkEqual(
    (await h.posted('openWorkflow'))[0].path,
    '.isarflow/workflows/review-loop.workflow.yaml',
    'by its path',
  );
});

flow(
  'agent: quick tool toggles under a slow host are not lost',
  { view: 'agent', width: 1280, height: 900, latency: 400 },
  async (h) => {
    const { page } = h;
    await page.locator('.if-check', { hasText: 'Edit files' }).click();
    await page.locator('.if-check', { hasText: 'Write files' }).click();
    await pause(1500);
    const yaml = await h.agentYaml();
    check(
      /editFile/.test(yaml) && /writeFile/.test(yaml),
      `both tools are on: ${yaml.match(/tools:.*/)?.[0]}`,
    );
  },
);

flow('agent: pickers leave no listeners behind', { view: 'agent', width: 1280, height: 900 }, async (h) => {
  const { page } = h;
  const before = await listeners(page);
  // The picker focuses its filter on the next frame; Escape is pressed once it has.
  const openAndEscape = async (trigger) => {
    await trigger.click();
    await until(
      () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Filter options'),
      'the filter takes the focus',
    );
    await page.keyboard.press('Escape');
    await until(async () => !(await page.locator('.if-select__popover').count()), 'Escape closes it');
  };
  for (let i = 0; i < 3; i++) {
    await openAndEscape(page.getByLabel('Main model'));
    await openAndEscape(page.getByRole('button', { name: /^Fallback models/ }));
  }
  await pause(200);
  checkEqual(await listeners(page), before, 'listener counts are unchanged');
});

flow(
  'agent: every control has an accessible name',
  { view: 'agent', width: 1280, height: 900 },
  async (h) => {
    const bad = await unnamedControls(h.page);
    check(bad.length === 0, `unnamed controls: ${[...new Set(bad)].join(', ')}`);
  },
);

/* ---- contrast, all views and themes ---- */

// Dimmed states (skipped blocks, quiet run rows, hidden agents) fade their frame and stone, never their text, so
// they are measured like everything else. `dimmed` lists the ones a scenario must show, so the check stays real.
for (const theme of ['dark', 'light', 'hc', 'hcl']) {
  for (const [view, scenario, width, dimmed = []] of [
    ['workflow', 'selected', 1440],
    ['workflow', 'running', 1440],
    ['workflow', 'failed', 1440],
    ['workflow', 'history', 1440],
    ['workflow', 'approval', 1440, ['.wf-card--skipped', '.wf-run-river-item--quiet']],
    ['workflow', 'nested-run', 1440, ['.wf-if--skipped', '.wf-card--skipped', '.wf-run-river-item--quiet']],
    ['workflow', 'invalid', 1440],
    ['workflow', 'noids', 1440],
    ['sidebar', 'default', 340],
    ['sidebar', 'wide-running', 400],
    ['sidebar', 'narrow-messy', 240, ['.sb-row--dimmed']],
    ['sidebar', 'narrow-messy-workflows', 240],
    ['sidebar', 'untrusted', 340],
    ['sidebar', 'workflows-markers', 340, ['.codicon-beaker', '.codicon-run-below']],
    ['agent', 'default', 1280],
    ['agent', 'tryit', 1280],
    ['agent', 'invalid', 1280],
  ]) {
    flow(
      `contrast: ${view} ${scenario} (${theme})`,
      { view, scenario, theme, width, height: 900 },
      async (h) => {
        for (const selector of dimmed)
          check((await h.page.locator(selector).count()) > 0, `the scenario shows ${selector}`);
        const low = await lowContrast(h.page, 4.5);
        check(
          low.length === 0,
          `text below 4.5:1 (3:1 when large):\n      ${low.slice(0, 12).join('\n      ')}`,
        );
      },
    );
  }
}

/* ---- loop heads: a title that slides under the chips is hidden, not printed through them ---- */

// A narrow loop scrolled partly out of view keeps its stone and titles in view (sticky), so they slide under the
// iteration chip and status on the right. Those sit on the header color and must cover every text line they meet.
for (const [scenario, width] of [
  ['nested-run', 1440],
  ['nested-run', 900],
]) {
  flow(
    `workflow: loop chips cover the title that slides under them (${scenario}, ${width} px)`,
    { view: 'workflow', scenario, width, height: 1700 },
    async (h) => {
      const heads = await h.page.evaluate(() =>
        [...document.querySelectorAll('.wf-loop__head')].map((head) => {
          const aside = head.querySelector(':scope > .wf-loop__aside');
          const a = aside.getBoundingClientRect();
          const lines = [];
          const walker = document.createTreeWalker(
            head.querySelector('.wf-loop__lead'),
            NodeFilter.SHOW_TEXT,
          );
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const r of range.getClientRects())
              if (r.width > 0 && r.right > a.left + 1 && r.left < a.right - 1)
                lines.push({ text: node.textContent.trim(), top: r.top, bottom: r.bottom });
          }
          return {
            title: head.querySelector('.wf-loop__title')?.textContent ?? '?',
            aside: { top: a.top, bottom: a.bottom },
            lines,
          };
        }),
      );
      const reached = heads.filter((head) => head.lines.length > 0);
      check(reached.length > 0, 'the scenario shows a loop whose title slides under its chips');
      const shown = reached.flatMap((head) =>
        head.lines
          .filter((l) => l.top < head.aside.top - 0.5 || l.bottom > head.aside.bottom + 0.5)
          .map(
            (l) =>
              `"${l.text}" in loop ${head.title}: text ${Math.round(l.top)}–${Math.round(l.bottom)}, ` +
              `chips ${Math.round(head.aside.top)}–${Math.round(head.aside.bottom)}`,
          ),
      );
      check(shown.length === 0, `text shows through the loop chips:\n      ${shown.join('\n      ')}`);
    },
  );
}

/* ---- segmented controls: the selected choice stands out in every theme ---- */

for (const theme of ['dark', 'light', 'hc', 'hcl']) {
  for (const [view, scenario, width] of [
    ['sidebar', 'narrow-newagent', 240], // tabs, Starter, Scope
    ['agent', 'noperms', 1280], // permission levels
    ['workflow', 'selected', 1440], // Answer format
    ['workflow', 'failed', 1440], // Settings / Run output
    ['workflow', 'condition', 1440], // Rules / Expression
  ]) {
    flow(
      `segmented: selected choice stands out in ${view} ${scenario} (${theme})`,
      { view, scenario, theme, width, height: 900 },
      async (h) => {
        const controls = await segmentEdges(h.page);
        check(controls.length > 0, 'the page shows a segmented control');
        const faint = controls.filter((c) => !(c.ratio >= 3));
        check(
          faint.length === 0,
          `selected segment edge below 3:1 against its track:\n      ${faint
            .map((c) => `${c.ratio.toFixed(2)} "${c.selected}" in ${c.name}`)
            .join('\n      ')}`,
        );
      },
    );
  }
}

/* ---- flows from scripts/flows/*.mjs ---- */

/** Flows of scripts/flows/*.mjs in alphabetical file order; a missing folder adds nothing. */
async function loadFlowFiles() {
  const dir = resolve(here, 'flows');
  const files = await readdir(dir).catch(() => []);
  const tools = { check, checkEqual, until, pause, lowContrast, segmentEdges, unnamedControls };
  for (const file of files.filter((f) => f.endsWith('.mjs')).sort()) {
    const make = (await import(pathToFileURL(resolve(dir, file)).href)).default;
    if (typeof make !== 'function') throw new Error(`scripts/flows/${file} must export a function`);
    const added = await make(tools);
    if (!Array.isArray(added)) throw new Error(`scripts/flows/${file} must return an array of flows`);
    for (const f of added) flow(f.name, f.options, f.run);
  }
}

await loadFlowFiles();

/* ---------------- runner ---------------- */

const flows = FLOWS.filter((f) => !only || only.some((part) => f.name.includes(part)));
// No file watching: an edit elsewhere in the repo (core is served from source) must not reload a page mid-flow.
const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  server: { port: 0, strictPort: false, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: !headed, slowMo });
const failures = [];
const started = Date.now();

try {
  for (const f of flows) {
    const {
      view,
      scenario = 'default',
      width = 1440,
      height = 900,
      latency,
      theme = 'dark',
      timeout = 30_000,
    } = f.options;
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(Math.min(timeout, 15_000));
    const errors = [];
    page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
    });
    const query = new URLSearchParams({
      view,
      scenario,
      theme,
      bare: '1',
      ...(latency ? { latency: String(latency) } : {}),
    });
    const t0 = Date.now();
    let error;
    try {
      await page.goto(`${base}harness/index.html?${query}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('body[data-harness-ready="true"]', { timeout: 15_000 });
      if (latency) await pause(latency + 100);
      // A stalled font request must not hang the run; the flow's own timeout starts after this.
      await page.evaluate(() =>
        Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]),
      );
      let timer;
      await Promise.race([
        f.run(helpers(page)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new CheckFailed(`timed out after ${timeout} ms`)), timeout);
        }),
      ]).finally(() => clearTimeout(timer));
      await pause(50);
      if (errors.length) throw new CheckFailed(errors.join('\n      '));
    } catch (e) {
      error = e;
    }
    const ms = Date.now() - t0;
    if (error) {
      failures.push(f.name);
      const message = error instanceof CheckFailed ? error.message : (error.stack ?? String(error));
      console.log(`✗ ${f.name} (${ms} ms)\n      ${message.split('\n').join('\n      ')}`);
      if (errors.length && !(error instanceof CheckFailed && error.message.startsWith('console')))
        console.log(`      also: ${errors.join('\n      ')}`);
    } else console.log(`✓ ${f.name} (${ms} ms)`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(
  `\n${flows.length - failures.length} of ${flows.length} flows passed in ${Math.round((Date.now() - started) / 1000)} s.`,
);
if (failures.length) {
  console.log(`Failed:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
}
