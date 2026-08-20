const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath:
      "/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "load", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));

  const result = await page.evaluate(() => {
    const out = [];
    const docWidth = document.documentElement.scrollWidth;
    out.push("document.scrollWidth=" + docWidth + " innerWidth=" + window.innerWidth);
    // walk all elements, find those whose scrollWidth notably exceeds viewport
    const all = document.querySelectorAll("*");
    const offenders = [];
    all.forEach((el) => {
      const w = el.scrollWidth;
      if (w > window.innerWidth + 5) {
        offenders.push({
          tag: el.tagName,
          cls: el.className && el.className.toString().slice(0, 80),
          scrollWidth: w,
          clientWidth: el.clientWidth,
          text: el.textContent ? el.textContent.slice(0, 40) : "",
        });
      }
    });
    return { docWidth, innerWidth: window.innerWidth, offenders: offenders.slice(0, 15) };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
