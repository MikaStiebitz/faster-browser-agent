import { describe, expect, it } from 'vitest';

import {
  serializeDiff,
  serializeObservation,
  serializeSnapshot,
  serializeTree,
  summarize,
} from '../src/runtime/serialize.js';
import type { Observation, PageSnapshot, SnapNode, SnapshotDiff } from '../src/types.js';

function snap(tree: SnapNode, overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'http://localhost:3000/settings/advanced',
    title: 'Acme Admin',
    version: 1,
    tree,
    stats: { interactive: 312, emitted: 180, elided: 132, captureMs: 14 },
    ...overrides,
  };
}

function lines(out: string): string[] {
  return out.split('\n');
}

describe('serializeTree', () => {
  it('renders ref, aliased role, name and value on one line', () => {
    const tree: SnapNode = {
      role: 'form',
      name: 'smtp',
      children: [
        { ref: 'e12', role: 'textbox', name: 'Port', value: '8080' },
        { ref: 'e13', role: 'button', name: 'Save' },
      ],
    };
    expect(serializeTree(tree)).toBe(['form "smtp"', '  e12 text "Port" = 8080', '  e13 btn "Save"'].join('\n'));
  });

  it('omits refs and aliases on request', () => {
    const tree: SnapNode = { ref: 'e1', role: 'button', name: 'Save' };
    expect(serializeTree(tree, { showRefs: false })).toBe('btn "Save"');
    expect(serializeTree(tree, { roleAliases: false })).toBe('e1 button "Save"');
  });

  it('quotes values only when they contain spaces', () => {
    const tree: SnapNode = {
      role: 'group',
      children: [
        { ref: 'e1', role: 'textbox', name: 'Host', value: 'localhost' },
        { ref: 'e2', role: 'textbox', name: 'Note', value: 'two words' },
      ],
    };
    const out = lines(serializeTree(tree));
    expect(out[1]).toBe('  e1 text "Host" = localhost');
    expect(out[2]).toBe('  e2 text "Note" = "two words"');
  });

  it('truncates values to 60 characters', () => {
    const long = 'x'.repeat(200);
    const out = serializeTree({ ref: 'e1', role: 'textbox', name: 'Body', value: long });
    const rendered = out.slice(out.indexOf('= ') + 2);
    expect(rendered.length).toBe(60);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('drops empty values entirely', () => {
    expect(serializeTree({ ref: 'e1', role: 'textbox', name: 'Port', value: '' })).toBe('e1 text "Port"');
  });

  it('renders only meaningful flags, in one bracket group', () => {
    const tree: SnapNode = {
      role: 'group',
      children: [
        { ref: 'e1', role: 'button', name: 'Save', state: { disabled: true, required: true } },
        { ref: 'e2', role: 'checkbox', name: 'TLS', state: { checked: false } },
        { ref: 'e3', role: 'checkbox', name: 'All', state: { checked: 'mixed' } },
        { ref: 'e4', role: 'textbox', name: 'Port', state: { invalid: true, readonly: true, focused: true } },
        { ref: 'e5', role: 'tab', name: 'General', state: { selected: true, offscreen: true } },
        { ref: 'e6', role: 'button', name: 'Plain', state: { disabled: false, checked: undefined } },
      ],
    };
    const out = lines(serializeTree(tree));
    expect(out[1]).toBe('  e1 btn "Save" [disabled required]');
    expect(out[2]).toBe('  e2 check "TLS" [unchecked]');
    expect(out[3]).toBe('  e3 check "All" [mixed]');
    expect(out[4]).toBe('  e4 text "Port" [invalid readonly focused]');
    expect(out[5]).toBe('  e5 tab "General" [selected offscreen]');
    expect(out[6]).toBe('  e6 btn "Plain"');
  });

  it('renders repeat compression and collapsed containers', () => {
    const tree: SnapNode = {
      role: 'list',
      children: [
        { role: 'listitem', name: 'Row 4', meta: { repeated: 37 } },
        { ref: 'e9', role: 'section', name: 'Advanced', meta: { collapsed: true, truncated: 12 } },
      ],
    };
    const out = lines(serializeTree(tree));
    expect(out[1]).toBe('  li "Row 4" … +37 similar');
    expect(out[2]).toBe('  e9 section "Advanced" [collapsed] (12 hidden)');
  });

  it('renders testId only when there is no name, plus href, options and src', () => {
    const tree: SnapNode = {
      role: 'nav',
      children: [
        { ref: 'e1', role: 'button', meta: { testId: 'save-btn' } },
        { ref: 'e2', role: 'button', name: 'Save', meta: { testId: 'save-btn' } },
        { ref: 'e3', role: 'link', name: 'Docs', meta: { href: 'http://localhost:3000/docs/intro' } },
        {
          ref: 'e4',
          role: 'combobox',
          name: 'Mode',
          meta: { options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], src: 'src/Settings.tsx:42' },
        },
      ],
    };
    const out = lines(serializeSnapshot(snap(tree)));
    expect(out).toContain('  e1 btn #save-btn');
    expect(out).toContain('  e2 btn "Save"');
    expect(out).toContain('  e3 link "Docs" -> /docs/intro');
    expect(out).toContain('  e4 select "Mode" (a|b|c|d|e|f|…) @src/Settings.tsx:42');
  });

  it('keeps a foreign origin on hrefs', () => {
    const tree: SnapNode = {
      role: 'nav',
      children: [{ ref: 'e1', role: 'link', name: 'Status', meta: { href: 'https://status.acme.com/' } }],
    };
    expect(serializeSnapshot(snap(tree))).toContain('-> https://status.acme.com/');
  });

  it('hoists anonymous wrapper containers instead of spending a line on them', () => {
    const tree: SnapNode = {
      role: 'form',
      name: 'smtp',
      children: [
        { role: 'generic', children: [{ ref: 'e1', role: 'button', name: 'Save' }] },
      ],
    };
    expect(serializeTree(tree)).toBe(['form "smtp"', '  e1 btn "Save"'].join('\n'));
  });
});

describe('maxChars budget', () => {
  function bigTree(): SnapNode {
    const children: SnapNode[] = [];
    for (let i = 0; i < 60; i++) {
      children.push({ role: 'text', name: `Offscreen row ${i}`, state: { offscreen: true } });
    }
    for (let i = 0; i < 20; i++) {
      children.push({ ref: `e${i}`, role: 'button', name: `Action ${i}` });
    }
    return { role: 'main', name: 'Body', children };
  }

  it('drops offscreen lines first and never truncates mid-line', () => {
    const out = serializeTree(bigTree(), { maxChars: 900 });
    expect(out.length).toBeLessThanOrEqual(900);
    // Interactive, on-screen nodes survive; the budget is paid out of the
    // offscreen text nodes.
    for (let i = 0; i < 20; i++) expect(out).toContain(`btn "Action ${i}"`);
    const survivingOffscreen = lines(out).filter((l) => l.includes('offscreen'));
    expect(survivingOffscreen.length).toBeLessThan(60);
    expect(out).toMatch(/… \d+ lines omitted \(raise maxChars or narrow scope\)/);
    // Every surviving line is a complete rendering, not a cut-off fragment.
    for (const line of lines(out)) expect(line.endsWith('…')).toBe(false);
  });

  it('drops nothing when the budget is generous', () => {
    const out = serializeTree(bigTree(), { maxChars: 100_000 });
    expect(out).not.toContain('omitted');
    expect(lines(out)).toHaveLength(81);
  });

  it('re-indents survivors onto their nearest surviving ancestor', () => {
    const children: SnapNode[] = [];
    for (let i = 0; i < 40; i++) {
      children.push({ role: 'text', name: `Offscreen row ${i}`, state: { offscreen: true } });
    }
    // Last child, so it is the first offscreen line the budget reaches.
    children.push({
      role: 'generic',
      name: 'wrapper',
      state: { offscreen: true },
      children: [{ ref: 'e1', role: 'button', name: 'Deep' }],
    });
    const out = serializeTree({ role: 'main', children }, { maxChars: 1000 });
    expect(out).not.toContain('"wrapper"');
    expect(out).toContain('\n  e1 btn "Deep"');
    expect(out).not.toContain('    e1');
  });
});

describe('serializeSnapshot', () => {
  it('emits a compact header, the tree and a stats footer', () => {
    const tree: SnapNode = { role: 'main', children: [{ ref: 'e1', role: 'button', name: 'Save' }] };
    const out = lines(
      serializeSnapshot(
        snap(tree, { tabPath: ['Settings', 'Advanced'], notes: ['3 validation errors'] }),
      ),
    );
    expect(out[0]).toBe('url: /settings/advanced  |  title: Acme Admin');
    expect(out[1]).toBe('tab: Settings > Advanced');
    expect(out[2]).toBe('! 3 validation errors');
    expect(out[3]).toBe('main');
    expect(out[4]).toBe('  e1 btn "Save"');
    expect(out[5]).toBe('[312 interactive, 180 shown, 132 elided, 14ms]');
  });

  it('announces an open overlay in the header', () => {
    const out = serializeSnapshot(
      snap({ role: 'dialog', name: 'Confirm delete' }, { overlay: { kind: 'dialog', ref: 'e7', name: 'Confirm delete' } }),
    );
    expect(out).toContain('overlay: e7 dialog "Confirm delete"');
  });
});

describe('summarize', () => {
  it('reports location, controls, form and tab', () => {
    const tree: SnapNode = {
      role: 'main',
      children: [
        {
          role: 'form',
          name: 'smtp',
          children: [
            { ref: 'e1', role: 'textbox', name: 'Host' },
            { ref: 'e2', role: 'textbox', name: 'Port' },
            { ref: 'e3', role: 'button', name: 'Save' },
            { role: 'text', name: 'not a control' },
          ],
        },
      ],
    };
    expect(summarize(snap(tree, { tabPath: ['Settings', 'Advanced'] }))).toBe(
      'settings/advanced — 3 controls, form "smtp", tab Settings > Advanced',
    );
  });

  it('reports an open dialog and validation errors', () => {
    const tree: SnapNode = {
      role: 'dialog',
      children: [{ ref: 'e1', role: 'textbox', name: 'Port', state: { invalid: true } }],
    };
    expect(
      summarize(snap(tree, { url: 'http://localhost:3000/', overlay: { kind: 'dialog', name: 'Confirm delete' } })),
    ).toBe('/ — 1 control, dialog "Confirm delete", 1 validation error');
  });
});

describe('serializeDiff', () => {
  const diff: SnapshotDiff = {
    fromVersion: 1,
    toVersion: 2,
    urlChanged: { from: 'http://localhost:3000/', to: 'http://localhost:3000/settings' },
    tabChanged: { from: ['Settings', 'General'], to: ['Settings', 'Advanced'] },
    overlayOpened: { kind: 'dialog', name: 'Confirm delete' },
    entries: [
      { kind: 'added', ref: 'e91', role: 'button', name: 'Save' },
      { kind: 'removed', ref: 'e44', role: 'textbox', name: 'Old field' },
      { kind: 'value', ref: 'e12', role: 'textbox', name: 'Port', from: '8080', to: '9090' },
      { kind: 'state', ref: 'e30', role: 'button', name: 'Save', from: 'disabled', to: 'enabled' },
      { kind: 'name', ref: 'e5', role: 'heading', name: 'After', from: 'Before', to: 'After' },
    ],
  };

  it('renders one prefixed line per change, structural facts first', () => {
    expect(serializeDiff(diff)).toBe(
      [
        '@ url / -> /settings',
        '@ tab Settings > General -> Settings > Advanced',
        '@ dialog opened "Confirm delete"',
        '+ e91 btn "Save"',
        '- e44 text "Old field"',
        '~ e12 text "Port" 8080 -> 9090',
        '~ e30 btn "Save" [disabled -> enabled]',
        '~ e5 h "Before" -> "After"',
      ].join('\n'),
    );
  });

  it('renders an empty diff as one short line', () => {
    expect(serializeDiff({ fromVersion: 1, toVersion: 2, entries: [] })).toBe('(no changes)');
  });

  it('tells the caller to ask for a full snapshot when the diff was truncated', () => {
    const out = serializeDiff({
      fromVersion: 1,
      toVersion: 2,
      tooLarge: true,
      entries: [{ kind: 'added', ref: 'e1', role: 'button', name: 'Save' }],
    });
    expect(out).toContain('request a full snapshot');
  });

  it('keeps both origins when navigation crossed origins', () => {
    const out = serializeDiff({
      fromVersion: 1,
      toVersion: 2,
      urlChanged: { from: 'http://localhost:3000/login', to: 'https://auth.acme.com/oauth' },
      entries: [],
    });
    expect(out).toBe('@ url /login -> https://auth.acme.com/oauth');
  });
});

describe('serializeObservation', () => {
  it('renders header, diff and problems without repeating the summary', () => {
    const observation: Observation = {
      url: 'http://localhost:3000/settings',
      title: 'Acme Admin',
      summary: 'settings — 2 controls',
      diff: {
        fromVersion: 1,
        toVersion: 2,
        entries: [{ kind: 'value', ref: 'e12', role: 'textbox', name: 'Port', from: '8080', to: '9090' }],
      },
      notes: ['saved'],
      problems: ['GET /api/health 500'],
      stats: { interactive: 12, emitted: 10, elided: 0, captureMs: 7 },
    };
    expect(serializeObservation(observation)).toBe(
      [
        'url: /settings  |  title: Acme Admin',
        '! saved',
        '!! GET /api/health 500',
        '~ e12 text "Port" 8080 -> 9090',
        '[12 interactive, 10 shown, 0 elided, 7ms]',
      ].join('\n'),
    );
    expect(serializeObservation(observation)).not.toContain('settings — 2 controls');
  });

  it('renders a native dialog and a full tree', () => {
    const observation: Observation = {
      url: 'http://localhost:3000/',
      title: '',
      summary: '',
      tree: { role: 'main', children: [{ ref: 'e1', role: 'button', name: 'OK' }] },
      nativeDialog: { type: 'confirm', message: 'Delete this?' },
    };
    const out = lines(serializeObservation(observation));
    expect(out[0]).toBe('url: /');
    expect(out[1]).toBe('! native confirm: "Delete this?"');
    expect(out[3]).toBe('  e1 btn "OK"');
  });
});
