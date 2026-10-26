import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const OUT = 'artifacts';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://127.0.0.1:5173/';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--force-device-scale-factor=1'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (message) => {
  logs.push(`${message.type()}: ${message.text()}`);
});
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.screenshot({ path: `${OUT}/01-empty.png` });

console.log(
  'initial:',
  await page.evaluate(() => ({
    emptyHidden: document.querySelector('#empty').hidden,
    hasDoc: document.body.classList.contains('has-doc'),
  })),
);

const fileInput = await page.$('#file');
await fileInput.uploadFile('sample.pdf');
await page.waitForFunction(() => document.body.classList.contains('has-doc'), {
  timeout: 20000,
});
await wait(1600);

const state = () =>
  page.evaluate(() => {
    const viewer = document.querySelector('#viewer');
    const page = document.querySelector('.page');
    const canvas = document.querySelector('.page canvas');
    return {
      title: document.title,
      pages: document.querySelectorAll('.page').length,
      ready: document.querySelectorAll('.page[data-state="ready"]').length,
      indicator: document.querySelector('#page-indicator').textContent,
      scrollLeft: viewer.scrollLeft,
      maxScroll: viewer.scrollWidth - viewer.clientWidth,
      clientWidth: viewer.clientWidth,
      playing: document.body.classList.contains('playing'),
      rtl: document.querySelector('#pages').classList.contains('rtl'),
      pageBox: page
        ? {
            w: Math.round(page.getBoundingClientRect().width),
            h: Math.round(page.getBoundingClientRect().height),
          }
        : null,
      canvasBox: canvas
        ? {
            w: Math.round(canvas.getBoundingClientRect().width),
            h: Math.round(canvas.getBoundingClientRect().height),
          }
        : null,
      rotation: document.querySelector('#rotate').getAttribute('aria-pressed'),
      direction: document
        .querySelector('#direction')
        .getAttribute('aria-pressed'),
      speed: document.querySelector('#speed').value,
      dim: document.querySelector('#dim').value,
    };
  });

const opened = await state();
console.log('opened (right-to-left default):', opened);
console.log(
  'starts on page 1 at right edge:',
  opened.scrollLeft === opened.maxScroll && opened.indicator === '1 / 12',
);
await page.screenshot({ path: `${OUT}/02-reading.png` });

const orient = async () =>
  page.evaluate(() => {
    const viewer = document.querySelector('#viewer');
    return {
      scrollLeft: viewer.scrollLeft,
      indicator: document.querySelector('#page-indicator').textContent,
      playing: document.body.classList.contains('playing'),
      rtl: document.querySelector('#pages').classList.contains('rtl'),
      direction: document
        .querySelector('#direction')
        .getAttribute('aria-pressed'),
    };
  });

await page.keyboard.press('Space');
await wait(150);
const before = await orient();
await wait(3000);
const after = await orient();
console.log('auto-scroll (rightward flow):', {
  before: before.scrollLeft,
  after: after.scrollLeft,
  movedForward: Number((before.scrollLeft - after.scrollLeft).toFixed(2)),
  playing: after.playing,
});

// Flip direction while playing: pages should now drift the other way.
await page.keyboard.press('d');
await wait(900);
const flipped = await orient();
await wait(1500);
const afterFlip = await orient();
console.log('auto-scroll (flipped flow):', {
  before: flipped.scrollLeft,
  after: afterFlip.scrollLeft,
  movedForward: Number((afterFlip.scrollLeft - flipped.scrollLeft).toFixed(2)),
  rtl: afterFlip.rtl,
  playing: afterFlip.playing,
});
await page.screenshot({ path: `${OUT}/03-flipped.png` });

// Back to right-to-left for the sideways screenshot.
await page.keyboard.press('d');
await wait(700);

// Rotate 90 degrees while playing continues.
await page.click('#rotate');
await wait(1200);
console.log('rotated:', await state());
await wait(1500);
console.log(
  'auto-scroll (sideways):',
  await page.evaluate(() => ({
    scrollLeft: document.querySelector('#viewer').scrollLeft,
    playing: document.body.classList.contains('playing'),
  })),
);

// Shift+R rotates back the other way; R returns to sideways.
await page.keyboard.down('Shift');
await page.keyboard.press('KeyR');
await page.keyboard.up('Shift');
await wait(900);
console.log(
  'reverse rotation:',
  await page.evaluate(() => ({
    pressed: document.querySelector('#rotate').getAttribute('aria-pressed'),
    pageBox: (() => {
      const r = document.querySelector('.page').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
  })),
);
await page.keyboard.press('KeyR');
await wait(900);
await page.screenshot({ path: `${OUT}/04-sideways.png` });

// Manual controls.
await page.evaluate(() => {
  const speed = document.querySelector('#speed');
  speed.value = '40';
  speed.dispatchEvent(new Event('input', { bubbles: true }));
});
console.log(
  'speed label:',
  await page.evaluate(() => document.querySelector('#speed-out').textContent),
);

await page.keyboard.press('Space');
await page.mouse.click(720, 450);
await wait(250);
console.log(
  'click toggles play:',
  await page.evaluate(() => document.body.classList.contains('playing')),
);
await page.keyboard.press('Space');
await wait(500);

// Jump-to-page: click the page counter, type a page, press Enter.
await page.click('#page-indicator');
await wait(180);
console.log(
  'goto open:',
  await page.evaluate(() => ({
    hidden: document.querySelector('#goto').hidden,
    value: document.querySelector('#goto-input').value,
    total: document.querySelector('#goto-total').textContent,
    focused: document.activeElement === document.querySelector('#goto-input'),
    playing: document.body.classList.contains('playing'),
  })),
);
await page.screenshot({ path: `${OUT}/05-goto-open.png` });
await page.keyboard.type('7');
await page.keyboard.press('Enter');
await wait(500);
console.log('goto page 7:', await state());
console.log(
  'goto closed:',
  await page.evaluate(() => document.querySelector('#goto').hidden),
);
await page.screenshot({ path: `${OUT}/06-goto-jumped.png` });

await page.evaluate(() => {
  const dim = document.querySelector('#dim');
  dim.value = '75';
  dim.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.screenshot({ path: `${OUT}/07-dim-sideways.png` });
const savedPosition = await page.evaluate(
  () => document.querySelector('#viewer').scrollLeft,
);

// Reload: PDF, position, rotation, direction and sliders should all come back.
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.body.classList.contains('has-doc'), {
  timeout: 20000,
});
await wait(1600);
console.log('after reload:', await state(), 'savedPosition:', savedPosition);
await page.screenshot({ path: `${OUT}/08-reloaded-sideways.png` });

const errors = logs.filter(
  (line) => line.startsWith('error') || line.startsWith('pageerror'),
);
console.log('console errors:', errors);

await browser.close();
