import { describe, expect, it } from 'vitest';

import { diffCost, diffSnapshots, flattenSnapshot, preferDiff, snapshotCost } from '../src/runtime/diff.js';
import type { DiffEntry, PageSnapshot, SnapNode } from '../src/types.js';

function snap(tree: SnapNode, overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'http://localhost:3000/settings',
    title: 'Acme Admin',
    version: 1,
    tree,
    stats: { interactive: 3, emitted: 5, elided: 0, captureMs: 8 },
    ...overrides,
  };
}

function form(children: SnapNode[]): SnapNode {
  return { role: 'form', name: 'smtp', children };
}

function find(entries: DiffEntry[], kind: DiffEntry['kind'], ref?: string): DiffEntry | undefined {
  return entries.find((e) => e.kind === kind && (ref === undefined || e.ref === ref));
}

describe('flattenSnapshot', () => {
  it('indexes every ref-bearing node and ignores the rest', () => {
    const tree = form([
      { ref: 'e1', role: 'textbox', name: 'Host' },
      { role: 'text', name: 'help' },
      { ref: 'e2', role: 'group', children: [{ ref: 'e3', role: 'button', name: 'Save' }] },
    ]);
    const map = flattenSnapshot(tree);
    expect([...map.keys()]).toEqual(['e1', 'e2', 'e3']);
    expect(map.get('e1')?.name).toBe('Host');
  });

  it('keeps the first node when a ref is duplicated', () => {
    const tree = form([
      { ref: 'e1', role: 'textbox', name: 'First' },
      { ref: 'e1', role: 'textbox', name: 'Second' },
    ]);
    expect(flattenSnapshot(tree).get('e1')?.name).toBe('First');
  });
});

describe('diffSnapshots', () => {
  it('reports value changes', () => {
    const before = snap(form([{ ref: 'e12', role: 'textbox', name: 'Port', value: '8080' }]));
    const after = snap(form([{ ref: 'e12', role: 'textbox', name: 'Port', value: '9090' }]), { version: 2 });
    const diff = diffSnapshots(before, after);
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.entries).toEqual([
      { kind: 'value', ref: 'e12', role: 'textbox', name: 'Port', from: '8080', to: '9090' },
    ]);
  });

  it('reports state changes as compact from -> to words', () => {
    const before = snap(
      form([
        { ref: 'e30', role: 'button', name: 'Save', state: { disabled: true } },
        { ref: 'e31', role: 'checkbox', name: 'TLS', state: { checked: false } },
        { ref: 'e32', role: 'section', name: 'Advanced', state: { expanded: false } },
      ]),
    );
    const after = snap(
      form([
        { ref: 'e30', role: 'button', name: 'Save', state: { disabled: false } },
        { ref: 'e31', role: 'checkbox', name: 'TLS', state: { checked: true } },
        { ref: 'e32', role: 'section', name: 'Advanced', state: { expanded: true } },
      ]),
      { version: 2 },
    );
    const diff = diffSnapshots(before, after);
    expect(diff.entries).toEqual([
      { kind: 'state', ref: 'e30', role: 'button', name: 'Save', from: 'disabled', to: 'enabled' },
      { kind: 'state', ref: 'e31', role: 'checkbox', name: 'TLS', from: 'unchecked', to: 'checked' },
      { kind: 'state', ref: 'e32', role: 'section', name: 'Advanced', from: 'collapsed', to: 'expanded' },
    ]);
  });

  it('joins several state changes on one entry', () => {
    const before = snap(form([{ ref: 'e1', role: 'textbox', name: 'Port', state: { invalid: true, required: true } }]));
    const after = snap(form([{ ref: 'e1', role: 'textbox', name: 'Port', state: { invalid: false, required: false } }]), {
      version: 2,
    });
    const entry = find(diffSnapshots(before, after).entries, 'state');
    expect(entry?.from).toBe('required, invalid');
    expect(entry?.to).toBe('optional, valid');
  });

  it('ignores scroll-induced offscreen churn but reports focus being gained', () => {
    const before = snap(
      form([
        { ref: 'e1', role: 'button', name: 'A', state: { offscreen: true } },
        { ref: 'e2', role: 'textbox', name: 'B', state: { focused: false } },
      ]),
    );
    const after = snap(
      form([
        { ref: 'e1', role: 'button', name: 'A', state: { offscreen: false } },
        { ref: 'e2', role: 'textbox', name: 'B', state: { focused: true } },
      ]),
      { version: 2 },
    );
    const diff = diffSnapshots(before, after);
    expect(diff.entries).toEqual([
      { kind: 'state', ref: 'e2', role: 'textbox', name: 'B', from: 'unfocused', to: 'focused' },
    ]);
  });

  it('reports added and removed nodes, added first', () => {
    const before = snap(form([{ ref: 'e44', role: 'textbox', name: 'Old field' }]));
    const after = snap(form([{ ref: 'e91', role: 'button', name: 'Save', value: 'go' }]), { version: 2 });
    const diff = diffSnapshots(before, after);
    expect(diff.entries).toEqual([
      { kind: 'added', ref: 'e91', role: 'button', name: 'Save', to: 'go' },
      { kind: 'removed', ref: 'e44', role: 'textbox', name: 'Old field' },
    ]);
  });

  it('notices ref-less named nodes appearing and disappearing', () => {
    const before = snap(form([{ role: 'text', name: 'All good' }]));
    const after = snap(form([{ role: 'alert', name: 'Port must be a number' }]), { version: 2 });
    const diff = diffSnapshots(before, after);
    expect(find(diff.entries, 'added')?.name).toBe('Port must be a number');
    expect(find(diff.entries, 'removed')?.name).toBe('All good');
  });

  it('reports name changes with both sides', () => {
    const before = snap(form([{ ref: 'e5', role: 'heading', name: 'Before' }]));
    const after = snap(form([{ ref: 'e5', role: 'heading', name: 'After' }]), { version: 2 });
    expect(diffSnapshots(before, after).entries).toEqual([
      { kind: 'name', ref: 'e5', role: 'heading', name: 'After', from: 'Before', to: 'After' },
    ]);
  });

  it('reports url, title, tab and overlay transitions', () => {
    const before = snap(form([]), {
      tabPath: ['Settings', 'General'],
    });
    const after = snap(form([]), {
      version: 2,
      url: 'http://localhost:3000/settings/advanced',
      title: 'Acme Admin — Advanced',
      tabPath: ['Settings', 'Advanced'],
      overlay: { kind: 'dialog', ref: 'e7', name: 'Confirm delete' },
    });
    const diff = diffSnapshots(before, after);
    expect(diff.urlChanged).toEqual({
      from: 'http://localhost:3000/settings',
      to: 'http://localhost:3000/settings/advanced',
    });
    expect(diff.titleChanged).toEqual({ from: 'Acme Admin', to: 'Acme Admin — Advanced' });
    expect(diff.tabChanged).toEqual({ from: ['Settings', 'General'], to: ['Settings', 'Advanced'] });
    expect(diff.overlayOpened).toEqual({ kind: 'dialog', ref: 'e7', name: 'Confirm delete' });
    expect(diff.overlayClosed).toBeUndefined();
  });

  it('reports an overlay closing', () => {
    const before = snap(form([]), { overlay: { kind: 'dialog', name: 'Confirm delete' } });
    const after = snap(form([]), { version: 2 });
    const diff = diffSnapshots(before, after);
    expect(diff.overlayClosed).toEqual({ kind: 'dialog', name: 'Confirm delete' });
    expect(diff.overlayOpened).toBeUndefined();
  });

  it('leaves an unchanged page with an empty diff', () => {
    const tree = form([{ ref: 'e1', role: 'textbox', name: 'Port', value: '8080' }]);
    const diff = diffSnapshots(snap(tree), snap(tree, { version: 2 }));
    expect(diff.entries).toEqual([]);
    expect(diff.tooLarge).toBeUndefined();
    expect(diff.urlChanged).toBeUndefined();
    expect(diff.tabChanged).toBeUndefined();
  });

  it('flags tooLarge and truncates to maxEntries', () => {
    const before = snap(form([]));
    const children: SnapNode[] = [];
    for (let i = 0; i < 100; i++) children.push({ ref: `e${i}`, role: 'button', name: `Btn ${i}` });
    const after = snap(form(children), { version: 2 });

    const diff = diffSnapshots(before, after);
    expect(diff.tooLarge).toBe(true);
    expect(diff.entries).toHaveLength(60);

    const small = diffSnapshots(before, after, { maxEntries: 5 });
    expect(small.tooLarge).toBe(true);
    expect(small.entries).toHaveLength(5);
    expect(small.entries[0]?.ref).toBe('e0');

    const roomy = diffSnapshots(before, after, { maxEntries: 500 });
    expect(roomy.tooLarge).toBeUndefined();
    expect(roomy.entries).toHaveLength(100);
  });
});

describe('cost model', () => {
  it('grows the snapshot cost with the tree', () => {
    const small = snap(form([{ ref: 'e1', role: 'button', name: 'Save' }]));
    const children: SnapNode[] = [];
    for (let i = 0; i < 50; i++) children.push({ ref: `e${i}`, role: 'button', name: `Action ${i}` });
    const big = snap(form(children));
    expect(snapshotCost(small)).toBeLessThan(snapshotCost(big));
    expect(snapshotCost(small)).toBeGreaterThan(0);
  });

  it('costs a diff roughly in proportion to its entries', () => {
    const one = diffCost({
      fromVersion: 1,
      toVersion: 2,
      entries: [{ kind: 'value', ref: 'e1', role: 'textbox', name: 'Port', from: '8080', to: '9090' }],
    });
    const many = diffCost({
      fromVersion: 1,
      toVersion: 2,
      entries: Array.from({ length: 10 }, (): DiffEntry => ({
        kind: 'value',
        ref: 'e1',
        role: 'textbox',
        name: 'Port',
        from: '8080',
        to: '9090',
      })),
    });
    expect(many).toBeGreaterThan(one * 5);
  });
});

describe('preferDiff', () => {
  function bigPage(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
    const children: SnapNode[] = [];
    for (let i = 0; i < 80; i++) {
      children.push({ ref: `e${i}`, role: 'textbox', name: `Some field number ${i}`, value: `value ${i}` });
    }
    return snap(form(children), { version: 2, ...overrides });
  }

  it('prefers a small diff over a large tree', () => {
    const next = bigPage();
    const diff = diffSnapshots(snap(form([])), next, { maxEntries: 500 });
    // A one-line change against an 80-control page.
    const tiny = { ...diff, entries: diff.entries.slice(0, 1) };
    delete tiny.tooLarge;
    expect(preferDiff(tiny, next)).toBe(true);
  });

  it('refuses when the diff is truncated', () => {
    const next = bigPage();
    const diff = diffSnapshots(snap(form([])), next);
    expect(diff.tooLarge).toBe(true);
    expect(preferDiff(diff, next)).toBe(false);
  });

  it('refuses across a navigation, because refs are regenerated', () => {
    const next = bigPage({ url: 'http://localhost:3000/other' });
    const diff = diffSnapshots(snap(form([])), next, { maxEntries: 500 });
    const tiny = { ...diff, entries: diff.entries.slice(0, 1) };
    expect(tiny.urlChanged).toBeDefined();
    expect(preferDiff(tiny, next)).toBe(false);
  });

  it('refuses when an overlay just opened, so its structure survives', () => {
    const next = bigPage({ overlay: { kind: 'dialog', name: 'Confirm delete' } });
    const diff = diffSnapshots(snap(form([])), next, { maxEntries: 500 });
    const tiny = { ...diff, entries: diff.entries.slice(0, 1) };
    expect(preferDiff(tiny, next)).toBe(false);
  });

  it('refuses on a tiny page, where the whole tree is cheap anyway', () => {
    const before = snap(form([{ ref: 'e1', role: 'textbox', name: 'Port', value: '8080' }]));
    const next = snap(form([{ ref: 'e1', role: 'textbox', name: 'Port', value: '9090' }]), { version: 2 });
    expect(preferDiff(diffSnapshots(before, next), next)).toBe(false);
  });

  it('refuses when the diff is nearly as expensive as the tree', () => {
    const before = bigPage({ version: 1 });
    const children: SnapNode[] = [];
    for (let i = 0; i < 80; i++) {
      children.push({ ref: `e${i}`, role: 'textbox', name: `Some field number ${i}`, value: `changed ${i}` });
    }
    const next = snap(form(children), { version: 2 });
    const diff = diffSnapshots(before, next, { maxEntries: 500 });
    expect(diff.entries).toHaveLength(80);
    expect(preferDiff(diff, next)).toBe(false);
  });
});
