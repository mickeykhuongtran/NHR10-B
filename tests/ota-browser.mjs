import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { installBleFixture } from './ota-browser-fixture.mjs';

const base = process.env.OTA_TEST_URL ?? 'http://127.0.0.1:3187';
if (!process.env.NHR_OTA_PACKAGE) throw new Error('Set NHR_OTA_PACKAGE to a built REV-B .nhrota package. Start Vite on port 3187 first.');
const bytes = await readFile(process.env.NHR_OTA_PACKAGE);
const target = bytes.subarray(44, 76).toString('ascii').split('\0')[0];
const imageHash = createHash('sha256').update(bytes.subarray(108)).digest('hex');
assert.equal(bytes[6], 2, 'A real REV-B package is required');
const upload = { name: `NHR10-B-${target}.nhrota`, mimeType: 'application/octet-stream', buffer: bytes };
await mkdir('test-results/ota', { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
const results = [];
const errors = [];
const pages = [];
async function setup(options = {}, mobile = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(installBleFixture, options);
  await page.goto(base);
  await page.getByRole('banner').getByRole('button', { name: 'Connect device', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  if (mobile) await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Upgrade firmware', exact: true }).filter({ visible: true }).click();
  await page.getByRole('heading', { name: 'UPGRADE FIRMWARE', exact: true }).waitFor();
  await page.locator('#ota-package').setInputFiles(upload);
  await page.getByText('Package integrity verified', { exact: true }).waitFor();
  return page;
}
async function prepare(page) {
  await page.getByRole('button', { name: 'Prepare & review' }).click();
  await page.getByRole('heading', { name: 'Ready to install' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Install firmware' }).isEnabled(), false);
  assert.equal(await page.evaluate(() => __otaFixture.writes.length), 0, 'Review must not write a manifest');
}
async function install(page) {
  await page.getByRole('checkbox', { name: /I confirm this firmware/ }).check();
  await page.getByRole('button', { name: 'Install firmware' }).click();
}
try {
  const page = await setup();
  await prepare(page);
  await page.screenshot({ path: 'test-results/ota/desktop-review.png', fullPage: true });
  await install(page);
  await page.getByRole('heading', { name: 'Restarting and checking firmware' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Cancel update' }).count(), 0);
  await page.screenshot({ path: 'test-results/ota/desktop-restarting.png', fullPage: true });
  await page.getByRole('heading', { name: 'Update confirmed', exact: true }).waitFor({ timeout: 30000 });
  const actual = await page.evaluate(() => __otaFixture);
  assert.equal(actual.bytes, bytes.length - 108); assert.equal(actual.imageHash, imageHash);
  assert.equal(actual.requestCount, 1); assert.equal(actual.collisions, 0);
  assert.deepEqual(actual.commandsDuringOta, []);
  assert.equal(actual.info.fw, target); assert.equal(actual.info.pending, false);
  assert.equal(new Set(actual.writes.map(w => w.seq)).size, actual.writes.length);
  await page.getByRole('button', { name: /Scan tags$/ }).click();
  await page.getByRole('button', { name: 'Start scan', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  await page.waitForFunction(() => __otaFixture.commands.includes('S'));
  results.push({ case: 'real package through production App/GATT, exact SHA-256, startup and RFID recovery', bytes: actual.bytes, frames: actual.writes.length, result: 'PASS' });
  await page.close();

  const mobile = await setup({}, true);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await prepare(mobile);
  await mobile.screenshot({ path: 'test-results/ota/mobile-review.png', fullPage: true });
  await mobile.getByRole('button', { name: 'Cancel', exact: true }).click();
  await mobile.getByRole('heading', { name: 'Update cancelled' }).waitFor();
  assert.equal(await mobile.evaluate(() => __otaFixture.writes.length), 0);
  results.push({ case: 'mobile navigation, no horizontal overflow, consent, cancel review', result: 'PASS' });
  await mobile.close();

  const wrong = await setup();
  const revc = Buffer.from(bytes); revc[6] = 3;
  await wrong.locator('#ota-package').setInputFiles({ ...upload, name: 'REV-C.nhrota', buffer: revc });
  await wrong.getByRole('alert').filter({ hasText: 'Not an NHR10-B REV-B' }).waitFor();
  assert.equal(await wrong.getByRole('button', { name: 'Prepare & review' }).isEnabled(), false);
  assert.equal(await wrong.evaluate(() => __otaFixture.writes.length), 0);
  results.push({ case: 'REV-C package rejected before any OTA write', result: 'PASS' });
  await wrong.close();

  for (const [name, options, expected] of [
    ['low power', { lowPower: true }, 'Power not sufficient'],
    ['rollback', { rollback: true }, 'may have rolled back'],
    ['lost FINISH reply', { loseFinishReply: true }, 'Update confirmed'],
  ]) {
    const test = await setup(options); await prepare(test); await install(test);
    await test.getByText(expected, { exact: name === 'lost FINISH reply' }).first().waitFor({ timeout: 30000 });
    const trace = await test.evaluate(() => __otaFixture);
    if (options.lowPower) assert.equal(trace.bytes, 0);
    else assert.equal(trace.writes.filter(w => w.op === 5).length, 0, 'No ABORT after possibly committed FINISH');
    assert.equal(trace.collisions, 0); assert.deepEqual(trace.commandsDuringOta, []);
    results.push({ case: name, result: 'PASS' }); await test.close();
  }
  const cancel = await setup({ holdDataAck: true }); await prepare(cancel); await install(cancel);
  await cancel.waitForFunction(() => __otaFixture.writes.some(w => w.op === 3));
  await cancel.getByRole('button', { name: 'Cancel update' }).click();
  await cancel.getByRole('heading', { name: 'Update cancelled' }).waitFor();
  assert.equal(await cancel.evaluate(() => __otaFixture.writes.some(w => w.op === 4)), false);
  results.push({ case: 'cancel while waiting for durable DATA ACK, no FINISH', result: 'PASS' }); await cancel.close();

  for (const pending of [false, true]) {
    const blocked = await setup();
    await blocked.evaluate(pending => { __otaFixture.info.ready = false; __otaFixture.info.pending = pending; }, pending);
    await blocked.getByRole('button', { name: 'Prepare & review' }).click();
    await blocked.getByText(pending ? /awaiting startup confirmation/ : /read RF power again/).waitFor();
    const downloading = blocked.waitForEvent('download');
    await blocked.getByRole('button', { name: 'Download diagnostics' }).click();
    const downloaded = await downloading;
    const diagnostic = JSON.parse(await readFile(await downloaded.path(), 'utf8'));
    assert.equal(diagnostic.state.info.ready, false);
    assert.equal(diagnostic.state.info.pending, pending);
    assert.equal(diagnostic.state.info.fw, '1.2.0-dev.0');
    assert.ok(diagnostic.events.some(e => e.event === 'installed-info'));
    assert.equal(await blocked.evaluate(() => __otaFixture.writes.length), 0);
    results.push({ case: `preflight blocked, pending=${pending}, downloaded device diagnostics, no OTA writes`, result: 'PASS' });
    await blocked.close();
  }
  const legacy = await setup({ legacyFirmware: true });
  await legacy.getByRole('button', { name: 'Prepare & review' }).click();
  await legacy.getByText(/Install the OTA-enabled REV-B application and bootloader/).waitFor();
  results.push({ case: 'firmware without OTA service explains initial installation', result: 'PASS' }); await legacy.close();
  assert.deepEqual(errors, [], 'No browser page errors');
  await writeFile('test-results/ota/results.json', JSON.stringify({ target, imageHash, results, errors }, null, 2));
  console.log(JSON.stringify({ target, results, errors }, null, 2));
} catch (error) {
  const last = pages.findLast(page => !page.isClosed());
  if (last) {
    await last.screenshot({ path: 'test-results/ota/failure.png', fullPage: true });
    await writeFile('test-results/ota/failure.txt', await last.locator('body').innerText());
  }
  throw error;
} finally { await browser.close(); }
