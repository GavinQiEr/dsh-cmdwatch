"""Render packaging.html with Playwright and snapshot the box + extras."""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

HTML = Path(r"C:\Users\admin\dsh-plugin\dsh-cmdwatch\design\packaging.html").resolve()
OUT_DIR = Path(r"C:\Users\admin\dsh-plugin\dsh-cmdwatch\design")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1300, "height": 2200}, device_scale_factor=2)
        page = await ctx.new_page()
        await page.goto(HTML.as_uri())
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(800)

        # Whole page
        await page.screenshot(path=str(OUT_DIR / "preview_full.png"), full_page=True)

        # Just the box (clip)
        box = await page.query_selector(".box")
        if box:
            await box.screenshot(path=str(OUT_DIR / "preview_box.png"))

        await browser.close()
        print("ok")

asyncio.run(main())
