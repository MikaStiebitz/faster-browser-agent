/**
 * Smart screenshots.
 *
 * A screenshot is the single most expensive observation this system can
 * produce: it costs browser paint time, transfer, and — dominating everything —
 * image tokens in the model's context on every later turn it stays visible.
 * The text snapshot is ~20x cheaper and usually complete, so screenshots are
 * strictly an escape hatch for genuinely visual questions (canvas, WebGL,
 * layout bugs, image content).
 *
 * "Smart" here is a stack of defaults that each cut cost without a quality
 * decision from the caller:
 *   - JPEG, not PNG (3-6x smaller on real UI content; PNG only on request)
 *   - viewport clip, never full page unless asked — and full page is height-
 *     capped so an infinite feed cannot produce a 40k-pixel-tall image
 *   - element clips when a target is given (a chart crop is a fraction of a
 *     viewport in both bytes and image tokens)
 *   - animations disabled during capture, so we never wait for a paint that
 *     only exists to look pretty
 */

import type { Locator, Page } from 'playwright-core';

import { FbaError, toFbaError } from '../util/errors.js';

export interface CaptureOptions {
  /** Clip to this locator instead of the viewport. */
  locator?: Locator;
  /** Capture the whole document, height-capped. Ignored when `locator` set. */
  fullPage?: boolean;
  format?: 'jpeg' | 'png';
  /** JPEG quality 1-100. The default is tuned for "readable UI text". */
  quality?: number;
  timeoutMs?: number;
}

export interface CaptureResult {
  data: string; // base64
  mimeType: 'image/jpeg' | 'image/png';
  bytes: number;
  width: number;
  height: number;
  clipped: 'element' | 'viewport' | 'page';
}

/**
 * Full-page height cap in CSS pixels. Anything taller is almost never a page
 * the model needs to *see* end-to-end — it is a feed, and feeds are what the
 * text snapshot's repeat compression is for.
 */
const MAX_FULLPAGE_HEIGHT = 4_000;

/** Default JPEG quality: text stays readable, bytes stay small. */
const DEFAULT_QUALITY = 60;

export async function capture(page: Page, options: CaptureOptions = {}): Promise<CaptureResult> {
  const format = options.format ?? 'jpeg';
  const timeout = options.timeoutMs ?? 5_000;
  const common = {
    type: format,
    timeout,
    // A capture must never wait out a CSS transition; we want pixels now.
    animations: 'disabled' as const,
    // Keep the caret out of screenshots — it flickers, and a flickering pixel
    // is a diff the model might chase.
    caret: 'hide' as const,
    ...(format === 'jpeg' ? { quality: clampQuality(options.quality) } : {}),
  };

  try {
    if (options.locator) {
      const box = await options.locator.boundingBox({ timeout });
      if (!box) {
        throw new FbaError('TARGET_NOT_ACTIONABLE', 'element has no visible bounding box to screenshot', {
          hint: 'is it hidden or in a collapsed section? snapshot first, or drop the target for a viewport shot',
        });
      }
      const buffer = await options.locator.screenshot(common);
      return result(buffer, format, Math.round(box.width), Math.round(box.height), 'element');
    }

    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

    if (options.fullPage) {
      // Cap the height by clipping rather than passing fullPage:true blindly.
      const docHeight = await page
        .evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0))
        .catch(() => viewport.height);
      const height = Math.min(Math.max(docHeight, viewport.height), MAX_FULLPAGE_HEIGHT);
      const buffer = await page.screenshot({
        ...common,
        fullPage: false,
        clip: { x: 0, y: 0, width: viewport.width, height },
      });
      return result(buffer, format, viewport.width, height, 'page');
    }

    const buffer = await page.screenshot(common);
    return result(buffer, format, viewport.width, viewport.height, 'viewport');
  } catch (e) {
    throw toFbaError(e, 'STEP_FAILED');
  }
}

function result(
  buffer: Buffer,
  format: 'jpeg' | 'png',
  width: number,
  height: number,
  clipped: CaptureResult['clipped'],
): CaptureResult {
  return {
    data: buffer.toString('base64'),
    mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    bytes: buffer.length,
    width,
    height,
    clipped,
  };
}

function clampQuality(quality: number | undefined): number {
  if (quality === undefined || !Number.isFinite(quality)) return DEFAULT_QUALITY;
  return Math.min(100, Math.max(1, Math.round(quality)));
}

/** One-line cost report appended to every screenshot result. */
export function describeCapture(result: CaptureResult): string {
  const kb = Math.round(result.bytes / 1024);
  return `${result.clipped} ${result.width}x${result.height} ${result.mimeType.slice(6)} ${kb}KB — coordinates in this image are valid for clickAt {x,y}`;
}
