const { chromium } = require(process.env.PW);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const out = {};
  for (const skin of ['nebula', 'sepia']) {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    await page.goto(`http://127.0.0.1:${process.env.PORT}/?skin=${skin}`);
    const f = await (await page.waitForSelector('#f')).contentFrame();
    await f.waitForSelector('[data-source="hermes"]');
    await page.waitForTimeout(800);
    out[skin] = { tile: await f.textContent('[data-source="hermes"]'), skinOnApp: await f.evaluate(() => document.documentElement.dataset.skin),
      base: await f.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--wz-base')) };
    await page.screenshot({ path: `${skin}-1-home.png` });
    await f.click('[data-file]');
    await f.waitForSelector('[data-job="brief"]');
    await f.click('[data-job="brief"]');
    await page.waitForTimeout(300);
    out[skin].preview = await f.evaluate(() => [...document.querySelectorAll('.imp-option b, .imp-jobs b, .imp-history p')].map(n => n.textContent));
    await f.evaluate(() => document.querySelector('.imp-history').scrollIntoView());
    await page.screenshot({ path: `${skin}-2-preview.png` });
    await f.evaluate(() => document.querySelector('.imp-jobs').scrollIntoView());
    await page.screenshot({ path: `${skin}-3-jobs.png` });
    await f.click('#import');
    await f.waitForSelector('.imp-knows');
    out[skin].done = await f.evaluate(() => [...document.querySelectorAll('.imp-knows li')].map(n => n.textContent));
    await page.screenshot({ path: `${skin}-4-done.png` });
    await page.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
