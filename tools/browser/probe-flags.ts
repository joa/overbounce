/**
 * Which Chrome flags actually give us a WebGPU adapter?
 *
 * CLAUDE.md is explicit that this must be determined empirically rather than
 * copied from a list, because the answer depends on the machine, the driver and
 * the Chrome build. So this tries candidates and reports what really works.
 */
import puppeteer from 'puppeteer';
import type { LaunchOptions } from 'puppeteer';

interface Candidate {
  name: string;
  options: LaunchOptions;
}

const BASE = ['--no-sandbox', '--disable-dev-shm-usage'];

const candidates: Candidate[] = [
  { name: 'headless + unsafe-webgpu', options: { headless: true, args: [...BASE, '--enable-unsafe-webgpu'] } },
  {
    name: 'headless + unsafe-webgpu + vulkan',
    options: { headless: true, args: [...BASE, '--enable-unsafe-webgpu', '--enable-features=Vulkan'] },
  },
  {
    name: 'headless + unsafe-webgpu + angle=d3d11',
    options: { headless: true, args: [...BASE, '--enable-unsafe-webgpu', '--use-angle=d3d11'] },
  },
  {
    name: 'headless + swiftshader (software)',
    options: {
      headless: true,
      args: [...BASE, '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
    },
  },
  { name: 'headful + unsafe-webgpu', options: { headless: false, args: [...BASE, '--enable-unsafe-webgpu'] } },
];

for (const c of candidates) {
  let browser;
  try {
    browser = await puppeteer.launch(c.options);
    const page = await browser.newPage();
    const info = await page.evaluate(async () => {
      if (!('gpu' in navigator)) {
        return { ok: false, why: 'navigator.gpu absent' };
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          return { ok: false, why: 'requestAdapter() returned null' };
        }
        const i = adapter.info ?? {};
        return { ok: true, vendor: i.vendor ?? '?', architecture: i.architecture ?? '?' };
      } catch (e) {
        return { ok: false, why: String(e) };
      }
    });
    console.log(`${info.ok ? 'OK  ' : 'FAIL'}  ${c.name.padEnd(38)} ${JSON.stringify(info)}`);
  } catch (e) {
    console.log(`FAIL  ${c.name.padEnd(38)} launch: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await browser?.close();
  }
}
