const puppeteer = require("puppeteer-core");

const CHROME = "/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome";

const targets = [
  { name: "dashboard", path: "/", viewport: { width: 1440, height: 900 }, full: true },
  { name: "dashboard_mobile", path: "/", viewport: { width: 390, height: 844 }, full: true },
  { name: "describe_job", path: "/describe-job", viewport: { width: 1440, height: 900 }, full: false },
  { name: "describe_job_mobile", path: "/describe-job", viewport: { width: 390, height: 844 }, full: false },
  { name: "recommendations", path: "/recommendations", viewport: { width: 1440, height: 900 }, full: true },
  { name: "equipment_details", path: "/equipment/eq-101", viewport: { width: 1440, height: 900 }, full: true },
  { name: "booking", path: "/booking/bk-1042", viewport: { width: 1440, height: 900 }, full: true },
  { name: "profile", path: "/profile", viewport: { width: 1440, height: 900 }, full: false },
];

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 90);
    });
  });
  // settle back at top for the shot, animations already fired (once: true)
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 500));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  for (const t of targets) {
    const page = await browser.newPage();
    await page.setViewport(t.viewport);
    await page.goto(`http://127.0.0.1:4173${t.path}`, { waitUntil: "load", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 800));
    await autoScroll(page);
    if (t.full) {
      const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewport({ width: t.viewport.width, height: Math.min(fullHeight, 9000) });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: `/home/claude/shots/${t.name}.png` });
    } else {
      await page.screenshot({ path: `/home/claude/shots/${t.name}.png` });
    }
    console.log("captured", t.name);
    await page.close();
  }

  await browser.close();
})();
