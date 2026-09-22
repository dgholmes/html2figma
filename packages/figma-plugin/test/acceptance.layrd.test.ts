/// <reference types="node" />
// This file alone needs Node's ambient types (Buffer, node:fs/os/path, process) for reading the
// capture written by the sibling Playwright script; the package's tsconfig deliberately
// restricts `types` to just @figma/plugin-typings so plugin source code can't accidentally
// reference Node APIs unavailable in the Figma sandbox. A file-scoped triple-slash reference
// pulls in @types/node for this file only, without widening that restriction package-wide.
//
// Second half of the layrd.pro acceptance test (see ../../capture/test-acceptance/layrd.mjs for
// the first half, which captures the live site and writes its H2FDocument here). This half feeds
// that same document through the plugin's real Builder against the plugin's existing figma mock,
// proving the import path — not just the capture path — works end to end on real-world content.
//
// This file is a plain Vitest test (per the controller's Task 20 instructions) so it runs both
// standalone (`npm test`, where it skips gracefully if no capture is on disk) and as the second
// half of `npm run test:acceptance`, which layrd.mjs spawns directly (not via a shell `&&`)
// after a successful capture, passing H2F_ACCEPTANCE_RUN_ID so this half can confirm the file it
// reads is the one *this* run just wrote — see "Stale-capture handling" in layrd.mjs. Reading
// from the OS temp dir rather than a repo path keeps a stale capture out of git and out of a
// from-scratch `npm test` run in CI/a fresh checkout.
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countNodes, type H2FDocument } from '@h2f/schema';
import { describe, expect, it } from 'vitest';
import { Builder, type BuilderDeps } from '../src/main/builder';
import { FontResolver } from '../src/main/fonts';
import { installFigmaMock, type MockNode } from './figmaMock';

// Must match packages/capture/test-acceptance/layrd.mjs's CAPTURE_PATH.
const CAPTURE_PATH = join(tmpdir(), 'h2f-acceptance', 'layrd.captured.json');
const hasCapture = existsSync(CAPTURE_PATH);
// Set only when layrd.mjs itself spawns this test (the `npm run test:acceptance` path). Absent
// under a plain `npm test` or a standalone `vitest run` — those trust file presence alone, which
// layrd.mjs already guarantees is either fresh or absent (it deletes any existing file before
// starting a new capture, and only ever writes a new one after that capture's own checks pass).
const expectedRunId = process.env.H2F_ACCEPTANCE_RUN_ID;

interface CaptureEnvelope { runId: string; capturedAt: string; document: H2FDocument }

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function countBuilt(node: MockNode): number {
  let n = 1;
  for (const c of node.children) n += countBuilt(c);
  return n;
}

function placeholderNames(node: MockNode, out: string[] = []): string[] {
  if (/\(import failed/.test(node.name)) out.push(node.name);
  for (const c of node.children) placeholderNames(c, out);
  return out;
}

function walkBuilt(node: MockNode, visit: (n: MockNode) => void): void {
  visit(node);
  for (const c of node.children) walkBuilt(c, visit);
}

// D1: a leftover capture file from an older format (missing `document` on the envelope) must be
// skipped cleanly rather than throwing a TypeError when something downstream dereferences it —
// which would otherwise break a plain `npm test` run on a machine with a stale temp file.
export function documentFromEnvelope(raw: unknown): H2FDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = (raw as { document?: unknown }).document;
  return doc && typeof doc === 'object' ? (doc as H2FDocument) : null;
}

describe('documentFromEnvelope', () => {
  it('returns null for an older-format capture file missing envelope.document, instead of throwing', () => {
    expect(documentFromEnvelope({ someOldField: true })).toBeNull();
    expect(documentFromEnvelope(null)).toBeNull();
    expect(documentFromEnvelope('not an object')).toBeNull();
    expect(documentFromEnvelope(42)).toBeNull();
  });

  it('returns the document for a well-formed envelope', () => {
    const doc = { version: 1 } as unknown as H2FDocument;
    expect(documentFromEnvelope({ runId: 'r1', capturedAt: 'now', document: doc })).toBe(doc);
  });
});

describe.skipIf(!hasCapture)('layrd.pro acceptance: Figma import', () => {
  it('builds the live-captured document through the real Builder without throwing, with a matching node count and zero placeholders', async () => {
    const envelope = JSON.parse(readFileSync(CAPTURE_PATH, 'utf8')) as unknown;

    // D1: an older-format leftover file (missing envelope.document) is skipped cleanly rather
    // than dereferencing `.document` and throwing a TypeError, so a stale file from a previous
    // schema version can never break a plain `npm test` run.
    const doc = documentFromEnvelope(envelope);
    if (!doc) {
      console.log(`[acceptance] skipping: capture at ${CAPTURE_PATH} is missing "document" (an older-format leftover file); run npm run test:acceptance to refresh it.`);
      return;
    }

    // Fail loudly — not skip — when this test was launched by layrd.mjs (H2F_ACCEPTANCE_RUN_ID
    // set) but the file on disk carries a different run's id. That combination should be
    // impossible given layrd.mjs deletes-then-rewrites the file itself before spawning this
    // test, so a mismatch here means something outside the normal flow raced or reused the temp
    // path; either way, a silent pass against unrelated data would be worse than a clear failure.
    const runId = (envelope as Partial<CaptureEnvelope>).runId;
    const capturedAt = (envelope as Partial<CaptureEnvelope>).capturedAt;
    if (expectedRunId) {
      expect(runId, `capture at ${CAPTURE_PATH} has runId "${runId}" but this run of npm run test:acceptance expected "${expectedRunId}" — it is stale data, not the capture this run just produced.`).toBe(expectedRunId);
    }

    const mock = installFigmaMock();
    const images = new Map<string, string>();
    const svgs = new Map<string, { svg: string; fallback?: Uint8Array }>();
    for (const asset of Object.values(doc.assets)) {
      if (asset.kind === 'image') images.set(asset.id, figma.createImage(base64ToBytes(asset.data)).hash);
      else {
        // D2: also register a fallback image for every svg asset, mirroring what main/index.ts's
        // real 'svg' handler does whenever the UI supplies fallback bytes — the previous version
        // only ever populated `svgs`, so a real page whose svg backs an ImagePaint (CSS
        // background-image on an svg, the same case svgImageFill.test.ts covers directly) would
        // never actually exercise that registration path here.
        const fallback = new Uint8Array([0]);
        svgs.set(asset.id, { svg: asset.svg, fallback });
        images.set(asset.id, figma.createImage(fallback).hash);
      }
    }
    const fonts = new FontResolver(await figma.listAvailableFontsAsync());
    const warnings: string[] = [...doc.warnings];
    const deps: BuilderDeps = { images, svgs, fonts, warnings, onProgress: () => {} };
    const builder = new Builder(deps);

    // Must not throw: Builder.build() catches per-node failures and turns them into placeholder
    // frames instead, so a throw escaping here means a bug outside that per-node safety net.
    const root = (await builder.build(doc.root, mock.currentPage as unknown as PageNode)) as unknown as MockNode;

    const expectedCount = countNodes(doc.root);
    const builtCount = countBuilt(root);
    console.log(`[acceptance] built ${builtCount} figma nodes from ${expectedCount} captured nodes (captured ${capturedAt}), ${Object.keys(doc.assets).length} assets, ${warnings.length} warnings`);
    expect(builtCount).toBe(expectedCount);

    const placeholders = placeholderNames(root);
    expect(placeholders, `placeholder "import failed" frame(s) found:\n${placeholders.join('\n')}`).toEqual([]);

    // D2: sanity-check the BUILT tree, not the source document — the previous version walked
    // `doc.root` (the captured document) and counted nodes there, so it would pass even if the
    // Builder produced nothing for them. Walking the built MockNode tree instead actually proves
    // text nodes got `characters` set and image-paint fills resolved to real IMAGE fills.
    let builtTextNodes = 0;
    let builtImageFills = 0;
    walkBuilt(root, (n) => {
      if (n.type === 'TEXT' && typeof n.characters === 'string' && n.characters.length > 0) builtTextNodes++;
      if ((n.fills as { type?: string }[]).some((f) => f.type === 'IMAGE')) builtImageFills++;
    });
    expect(builtTextNodes).toBeGreaterThan(0);
    expect(builtImageFills).toBeGreaterThan(0);
  });
});
