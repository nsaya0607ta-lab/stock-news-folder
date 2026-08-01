/** HTMLをA4のPDFへ変換する（定期処理用）。 */
import puppeteer from 'puppeteer';

export async function htmlToPdf(html) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');
    return Buffer.from(
      await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      }),
    );
  } finally {
    await browser.close();
  }
}
