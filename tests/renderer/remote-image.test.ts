/**
 * @fileoverview Tests for the shared remote-image fetch helper.
 * @module tests/renderer/remote-image.test
 */

import * as fs from 'node:fs/promises';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRemoteImageToTempPng, isRemoteSource } from '@/renderer/remote-image.js';

/** 1×1 transparent PNG, the smallest payload sharp will re-encode. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const written: string[] = [];

afterEach(async () => {
  await Promise.all(written.splice(0).map((p) => fs.unlink(p).catch(() => undefined)));
});

describe('isRemoteSource', () => {
  it('distinguishes URLs from local paths', () => {
    expect(isRemoteSource('https://example.test/a.png')).toBe(true);
    expect(isRemoteSource('http://example.test/a.png')).toBe(true);
    expect(isRemoteSource('/tmp/a.png')).toBe(false);
    expect(isRemoteSource('./a.png')).toBe(false);
  });
});

describe('fetchRemoteImageToTempPng', () => {
  it('writes the fetched image to a temp PNG', async () => {
    const http = createFetchMock([
      {
        match: 'https://images.test/pixel.png',
        respond: () =>
          new Response(new Uint8Array(PNG_1X1), { headers: { 'content-type': 'image/png' } }),
      },
    ]);
    http.install();
    try {
      const tmpPath = await fetchRemoteImageToTempPng(
        'https://images.test/pixel.png',
        createMockContext(),
      );
      written.push(tmpPath);
      expect(tmpPath.endsWith('.png')).toBe(true);
      await expect(fs.access(tmpPath)).resolves.toBeUndefined();
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('rejects a non-https URL as asset_not_found before any network call', async () => {
    const http = createFetchMock();
    http.install();
    try {
      await expect(
        fetchRemoteImageToTempPng('http://images.test/pixel.png', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'asset_not_found' } });
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });

  it('maps an upstream failure to asset_not_found', async () => {
    const http = createFetchMock([
      {
        match: 'https://images.test/missing.png',
        respond: () => new Response('nope', { status: 404 }),
      },
    ]);
    http.install();
    try {
      await expect(
        fetchRemoteImageToTempPng('https://images.test/missing.png', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'asset_not_found' } });
    } finally {
      http.restore();
    }
  });

  it('rejects a response that declares more than the byte ceiling', async () => {
    const http = createFetchMock([
      {
        match: 'https://images.test/huge.png',
        respond: () =>
          new Response(new Uint8Array(PNG_1X1), {
            headers: { 'content-length': String(11 * 1024 * 1024) },
          }),
      },
    ]);
    http.install();
    try {
      await expect(
        fetchRemoteImageToTempPng('https://images.test/huge.png', createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'asset_not_found' } });
    } finally {
      http.restore();
    }
  });
});
