"""Render index.html (deterministic Web-Animations timeline) to an mp4 with Playwright + ffmpeg.

  python3 render.py preview OUT_DIR t1 t2 ...   # PNG stills at the given seconds (QA)
  python3 render.py video OUT.mp4 [fps]         # full render, frames piped straight into ffmpeg
"""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1920, 1080


def open_page(p):
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    page.goto("file://" + os.path.join(HERE, "index.html"))
    page.evaluate("document.fonts.ready")
    time.sleep(1.0)
    ok = page.evaluate("[document.fonts.check('16px \"Pretendard Variable\"'), document.fonts.check('16px \"JetBrains Mono\"')]")
    print("fonts loaded (Pretendard, JetBrains Mono):", ok, file=sys.stderr)
    return browser, page


def main():
    mode = sys.argv[1]
    with sync_playwright() as p:
        browser, page = open_page(p)
        if mode == "preview":
            out = sys.argv[2]; os.makedirs(out, exist_ok=True)
            for t in sys.argv[3:]:
                page.evaluate(f"window.seek({float(t)})")
                page.screenshot(path=os.path.join(out, f"t{float(t):05.2f}.png"), type="png")
            browser.close(); return
        out, fps = sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 30
        dur = page.evaluate("window.DURATION")
        n = int(round(dur * fps))
        ff = subprocess.Popen([
            "ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps), "-c:v", "png", "-i", "-",
            "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", str(fps), out,
        ], stdin=subprocess.PIPE)
        t_start = time.time()
        for i in range(n):
            page.evaluate(f"window.seek({i / fps})")
            ff.stdin.write(page.screenshot(type="png"))
            if i % 60 == 0: print(f"frame {i}/{n}  {time.time() - t_start:.0f}s", file=sys.stderr)
        ff.stdin.close(); ff.wait()
        browser.close()
        print("done", out, n, "frames", file=sys.stderr)


if __name__ == "__main__":
    main()
