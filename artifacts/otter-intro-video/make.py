"""Otter intro video renderer. Python + Pillow + numpy + ffmpeg, macOS `say -v Yuna` Korean TTS.

Run from repo root: python3 artifacts/otter-intro-video/make.py   (reads /tmp/otter-video/status.txt)
Everything is rendered at 2x (S) into cached sprites, downscaled with LANCZOS, then composited per frame.
"""
import os, re, math, json, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageChops, ImageFilter

OUT = "/tmp/otter-video"
W, H, FPS = 1920, 1080, 30
S = 2  # supersampling factor
SD = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"
XFADE = 0.3  # half-width of the scene crossfade (s)

# palette
FG = (242, 244, 248); DIM = (150, 158, 176); MUT = (98, 106, 126)
ACC = (255, 138, 76); ACC2 = (255, 96, 128); IND = (124, 131, 255); IND2 = (168, 112, 255)
TEAL = (52, 211, 190); SKY = (70, 160, 255)
GRN = (126, 224, 150); BLU = (122, 188, 255); AMB = (255, 204, 112); PNK = (255, 126, 200); CYA = (110, 222, 204)
TONES = [(ACC, ACC2), (IND, IND2), (TEAL, SKY)]

_fonts = {}
def _font(path, idx, size):
    k = (path, idx, size)
    if k not in _fonts: _fonts[k] = ImageFont.truetype(path, int(size * S), index=idx)
    return _fonts[k]
WT = {"r": 0, "m": 2, "s": 4, "b": 6, "l": 8}
def sd(size, w="m"): return _font(SD, WT[w], size)
def mono(size, bold=False): return _font(MONO, 1 if bold else 0, size)

GH = "github.com/KimJiSeong1994/AgentFramework"
CURL = "curl -fsSL https://raw.githubusercontent.com/KimJiSeong1994/AgentFramework/master/install.sh | bash"

def wiki_tree():
    root = "knowledge"
    lines = ["knowledge/"]
    for sub in ["raw/tool-runs", "raw/documents", "wiki/concepts", "wiki/entities", "wiki/reports"]:
        names = sorted(os.listdir(os.path.join(root, sub)))
        lines.append(f"  {sub}/  ({len(names)})")
        for n in names[:3]:
            lines.append(f"    {n[:46] + '…' if len(n) > 47 else n}")
    return lines

status_lines = open(f"{OUT}/status.txt").read().strip().splitlines()[:6]
wiki_status = subprocess.run(["bun", "scripts/otter-wiki.ts", "status"], capture_output=True, text=True).stdout.strip().splitlines()[:7]

# scene: (narration, kind, payload)
SCENES = [
    ("에이전트 프레임워크, 오터. 에이전트의 실행 이력을 버리지 않고, 자산으로 쌓는 코딩 에이전트입니다.",
     "title", ("AgentFramework  ·  otter", "에이전트 실행 이력을 자산으로 쌓는 코딩 에이전트")),
    ("에이전트와의 대화는 끝나면 사라집니다. 하지만 어떤 계획을 세웠고, 무엇을 승인했고, 어떤 도구가 성공하고 실패했는지는 다음 작업의 근거가 되어야 합니다.",
     "bullets", ("왜 필요한가", ["대화는 끝나면 사라진다", "계획 · 승인 · 도구 실행 결과는 남아야 한다", "남은 이력 = 다음 작업의 근거"])),
    ("설치는 한 줄입니다. 맥오에스나 리눅스에서 이 명령을 실행하면, 번 런타임까지 확인하고 오터 명령을 만들어 줍니다.",
     "term", ("설치", [("$ ", CURL)], ["macOS / Linux · git 필요 · bun 없으면 자동 설치", "다시 실행하면 업데이트 · --uninstall 로 제거"])),
    ("작업할 깃 저장소에서 오터 챗을 실행하고, 슬래시 모델로 엔진을 고릅니다. 로컬 올라마, 코덱스, 클로드 중 무엇을 써도 이력은 같은 형식으로 쌓입니다.",
     "term", ("시작하기", [("$ ", "cd my-project"), ("$ ", "otter chat"), ("› ", "/model"), ("› ", "/model codex gpt-5.6-sol")], ["엔진: local(Ollama) · codex · claude", "엔진이 달라도 이력 형식은 동일"])),
    ("오터는 바로 실행하지 않습니다. 슬래시 플랜으로 계획을 만들고, 사람이 슬래시 어프루브로 승인한 뒤에만 실행합니다. 승인과 실행은 원장에 기록됩니다.",
     "flow", ("통제된 실행", ["/plan", "/approve", "실행", "원장 기록"])),
    ("실행하는 동안 도구 호출 결과가 추가 전용 에스큐엘라이트 로그에 남습니다. 인자나 출력 본문은 저장하지 않고, 성공과 실패의 메타데이터만 기록합니다.",
     "bullets", ("실행 이력 기록", ["tool-outcomes.sqlite — 추가 전용(append-only)", "도구 · 세션 · 결과 · 시간만 저장", "인자 · 출력 본문은 저장하지 않음"])),
    ("쌓인 이력은 위키 캡처 명령으로 자산이 됩니다. 변하지 않는 원본 스냅샷과 집계 리포트가 만들어지고, 에이전트가 이를 출처가 연결된 개념과 엔티티 페이지로 정리합니다.",
     "termtree", ("이력 → 지식 자산", [("$ ", "bun scripts/otter-wiki.ts capture")], wiki_tree())),
    ("위키 스테이터스로 등록된 출처와 정리 상태를 확인하고, 린트로 링크와 해시 무결성을 검사합니다. 이 위키가 다음 작업의 컨텍스트가 됩니다.",
     "termout", ("자산 확인", [("$ ", "bun scripts/otter-wiki.ts status")], wiki_status)),
    ("지난 작업은 슬래시 세션즈로 보고, 슬래시 리쥼으로 복원합니다. 오터 스테이터스는 엔진 없이도 현재 워크플로와 원장 상태를 보여 줍니다.",
     "termout", ("세션과 상태", [("› ", "/sessions"), ("› ", "/resume <sid>"), ("$ ", "otter status --worktree .")], status_lines)),
    ("실행할수록 쌓이는 에이전트, 오터. 깃허브에서 엠아이티 라이선스로 공개되어 있습니다.",
     "title", ("실행할수록 쌓이는 에이전트", GH + "  ·  MIT")),
]


ICONS = {1: ["bubble", "clipboard", "loop"], 5: ["db", "tag", "lock"]}

# ----------------------------------------------------------------------------------------------
# Toolkit
# ----------------------------------------------------------------------------------------------
MX = 96
TXT = (208, 214, 226)
WINTITLE = {2: "~ — zsh — 100×30", 3: "my-project — otter", 6: "AgentFramework — zsh", 7: "AgentFramework — zsh", 8: "AgentFramework — zsh"}


def ease(p):
    p = min(1.0, max(0.0, p)); return 1 - (1 - p) ** 3
def smooth(p):
    p = min(1.0, max(0.0, p)); return p * p * (3 - 2 * p)
def tl(font, text): return font.getlength(text) / S
def mix(a, b, k): return tuple(int(round(a[i] + (b[i] - a[i]) * k)) for i in range(3))


def grad_img(w, h, c0, c1, mode="diag"):
    x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    t = {"diag": (x + y) / 2, "h": x + 0 * y, "v": y + 0 * x}[mode]
    arr = np.zeros((h, w, 4), np.uint8)
    for k in range(3): arr[..., k] = (c0[k] + (c1[k] - c0[k]) * t).astype(np.uint8)
    arr[..., 3] = 255
    return Image.fromarray(arr, "RGBA")


class G:
    """Supersampled sprite canvas; coordinates in 1x units."""
    def __init__(s, w, h):
        s.w, s.h = int(w), int(h)
        s.im = Image.new("RGBA", (s.w * S, s.h * S), (0, 0, 0, 0)); s.d = ImageDraw.Draw(s.im)
    def _b(s, box): return [v * S for v in box]
    def rrect(s, box, r, fill=None, outline=None, width=1, corners=None):
        s.d.rounded_rectangle(s._b(box), r * S, fill=fill, outline=outline, width=max(1, int(width * S)), corners=corners)
    def ellipse(s, box, fill=None, outline=None, width=1):
        s.d.ellipse(s._b(box), fill=fill, outline=outline, width=max(1, int(width * S)))
    def poly(s, pts, fill): s.d.polygon([(x * S, y * S) for x, y in pts], fill=fill)
    def line(s, pts, fill, width=2):
        s.d.line([(x * S, y * S) for x, y in pts], fill=fill, width=int(width * S), joint="curve")
    def arc(s, box, a0, a1, fill, width=2): s.d.arc(s._b(box), a0, a1, fill=fill, width=int(width * S))
    def text(s, xy, t, font, fill, anchor="la"): s.d.text((xy[0] * S, xy[1] * S), t, font=font, fill=fill, anchor=anchor)
    def gtext(s, xy, t, font, c0, c1, anchor="la", mode="h"):
        m = Image.new("L", s.im.size, 0); ImageDraw.Draw(m).text((xy[0] * S, xy[1] * S), t, font=font, fill=255, anchor=anchor)
        s.im.paste(grad_img(*s.im.size, c0, c1, mode), (0, 0), m)
    def gfill(s, box, r, c0, c1, mode="diag", alpha=255):
        m = Image.new("L", s.im.size, 0); ImageDraw.Draw(m).rounded_rectangle(s._b(box), r * S, fill=alpha)
        s.im.paste(grad_img(*s.im.size, c0, c1, mode), (0, 0), m)
    def out(s): return s.im.resize((s.w, s.h), Image.LANCZOS)


def blur_sprite(w, h, r, blur, color, alpha, dy=0):
    """Soft rounded-rect shadow/glow. Returns (sprite, pad)."""
    pad = int(blur * 3)
    m = Image.new("L", (w + 2 * pad, h + 2 * pad), 0)
    ImageDraw.Draw(m).rounded_rectangle([pad, pad + dy, pad + w, pad + h + dy], r, fill=alpha)
    m = m.filter(ImageFilter.GaussianBlur(blur))
    im = Image.new("RGBA", m.size, tuple(color) + (0,)); im.putalpha(m)
    return im, pad


def put(cv, spr, x, y, alpha=1.0):
    x, y = int(round(x)), int(round(y)); sw, sh = spr.size
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + sw), min(H, y + sh)
    if x1 <= x0 or y1 <= y0: return
    sp = spr.crop((x0 - x, y0 - y, x1 - x, y1 - y))
    if alpha < 0.996: sp.putalpha(sp.getchannel("A").point([int(v * alpha) for v in range(256)]))
    cv.alpha_composite(sp, (x0, y0))


def enter(t0, d=0.6, dx=0, dy=28):
    def f(t):
        p = ease((t - t0) / d); return p, (1 - p) * dx, (1 - p) * dy
    return f
def fade(t0, d=0.4): return lambda t: (smooth((t - t0) / d), 0, 0)


class Lay:
    def __init__(s, spr, x, y, fn=None): s.spr, s.x, s.y, s.fn = spr, x, y, fn


def draw_layers(cv, layers, t):
    for l in layers:
        a, ox, oy = l.fn(t) if l.fn else (1, 0, 0)
        if a <= 0.004: continue
        spr = l.spr(t) if callable(l.spr) else l.spr
        if spr is not None: put(cv, spr, l.x + ox, l.y + oy, a)


def wrap_words(text, font, maxw):
    lines, cur = [], ""
    for w in text.split(" "):
        trial = f"{cur} {w}" if cur else w
        if tl(font, trial) <= maxw: cur = trial
        else:
            if cur: lines.append(cur)
            cur = w
    lines.append(cur); return lines


def wrap_chars(text, font, maxw):
    lines, cur = [], ""
    for ch in text:
        if tl(font, cur + ch) > maxw: lines.append(cur); cur = ch
        else: cur += ch
    lines.append(cur); return lines


def make_bg(glows, seed=0):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    v = (yy / H)[..., None]
    img = np.array((14, 16, 28), np.float32) * (1 - v) + np.array((7, 8, 15), np.float32) * v
    for cx, cy, rad, col, st in glows:
        d2 = ((xx - cx * W) ** 2 + (yy - cy * H) ** 2) / (rad * W) ** 2
        img = img + (np.exp(-d2 * 2.2) * st)[..., None] * np.array(col, np.float32)
    r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    img = img * (1 - 0.42 * np.clip(r - 0.45, 0, 1) ** 1.6)[..., None]
    dots = (((xx % 48) < 2) & ((yy % 48) < 2)) * 14 * np.clip(1.1 - r, 0, 1)
    img = img + dots[..., None] + np.random.RandomState(seed).uniform(-1.2, 1.2, (H, W, 1)).astype(np.float32)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB").convert("RGBA")


GLOWS = [
    [(0.88, 0.05, 0.45, IND, 0.24), (0.08, 1.0, 0.5, ACC2, 0.14)],
    [(0.90, 0.10, 0.45, ACC, 0.20), (0.05, 0.95, 0.5, IND, 0.18)],
    [(0.85, 0.05, 0.45, TEAL, 0.17), (0.10, 1.0, 0.5, IND, 0.18)],
]


def logo_sprite(size, glow=True):
    pad = int(size * 0.6) if glow else 0
    g = G(size + 2 * pad, size + 2 * pad)
    g.gfill([pad, pad, pad + size, pad + size], size * 0.28, ACC, ACC2)
    cx, cy = pad + size / 2, pad + size / 2
    w, hh, gap = size * 0.58, size * 0.27, size * 0.17
    for k, a in ((1, 150), (0, 215), (-1, 255)):
        y = cy + k * gap
        g.poly([(cx, y - hh / 2), (cx + w / 2, y), (cx, y + hh / 2), (cx - w / 2, y)], (255, 255, 255, a))
    spr = g.out()
    if glow:
        sh, _ = blur_sprite(size, size, int(size * 0.28), size * 0.2, ACC, 120)
        sh2 = Image.new("RGBA", spr.size, (0, 0, 0, 0)); sh2.alpha_composite(sh, (pad - _, pad - _)); sh2.alpha_composite(spr); spr = sh2
    return spr


def icon(g, name, cx, cy, col=(255, 255, 255, 255), hole=(60, 40, 120, 255)):
    w = 3.2
    if name == "bubble":
        g.rrect([cx - 17, cy - 15, cx + 17, cy + 9], 8, outline=col, width=w)
        g.poly([(cx - 8, cy + 8), (cx - 12, cy + 18), (cx + 2, cy + 8)], col)
        for dx in (-8, 0, 8): g.ellipse([cx + dx - 2, cy - 5, cx + dx + 2, cy - 1], fill=col)
    elif name == "clipboard":
        g.rrect([cx - 14, cy - 16, cx + 14, cy + 18], 5, outline=col, width=w)
        g.rrect([cx - 7, cy - 21, cx + 7, cy - 12], 3, fill=col)
        g.line([(cx - 7, cy + 2), (cx - 2, cy + 8), (cx + 8, cy - 4)], col, w)
    elif name == "loop":
        g.arc([cx - 16, cy - 16, cx + 16, cy + 16], 40, 330, col, w)
        g.poly([(cx + 14, cy - 17), (cx + 20, cy - 3), (cx + 6, cy - 6)], col)
        g.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=col)
    elif name == "db":
        g.line([(cx - 16, cy - 14), (cx - 16, cy + 14)], col, w); g.line([(cx + 16, cy - 14), (cx + 16, cy + 14)], col, w)
        g.arc([cx - 16, cy - 8, cx + 16, cy + 4], 0, 180, col, w)
        g.arc([cx - 16, cy + 2, cx + 16, cy + 20], 0, 180, col, w)
        g.ellipse([cx - 16, cy - 20, cx + 16, cy - 8], outline=col, width=w)
    elif name == "tag":
        pts = [(cx - 17, cy - 3), (cx - 5, cy - 17), (cx + 17, cy - 17), (cx + 17, cy + 5), (cx + 3, cy + 17)]
        g.poly(pts, col); g.ellipse([cx + 5, cy - 12, cx + 12, cy - 5], fill=hole)
    elif name == "lock":
        g.rrect([cx - 15, cy - 3, cx + 15, cy + 17], 5, fill=col)
        g.arc([cx - 10, cy - 20, cx + 10, cy + 2], 180, 360, col, w)
        g.line([(cx - 10, cy - 10), (cx - 10, cy - 2)], col, w); g.line([(cx + 10, cy - 10), (cx + 10, cy - 2)], col, w)
        g.ellipse([cx - 3, cy + 3, cx + 3, cy + 9], fill=hole)
    elif name == "check":
        g.line([(cx - 9, cy), (cx - 3, cy + 7), (cx + 9, cy - 7)], col, 4)
    elif name == "gear":
        g.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], outline=col, width=5)
        for a in range(0, 360, 45):
            dx, dy = math.cos(math.radians(a)), math.sin(math.radians(a))
            g.line([(cx + dx * 14, cy + dy * 14), (cx + dx * 20, cy + dy * 20)], col, 5)
    elif name == "doc":
        g.rrect([cx - 14, cy - 18, cx + 14, cy + 18], 5, outline=col, width=w)
        for k in range(3): g.line([(cx - 7, cy - 8 + k * 8), (cx + 7, cy - 8 + k * 8)], col, 2.6)


def pill_sprite(text, font, pad=20, h=48, fill=(255, 255, 255, 22), outline=(255, 255, 255, 40), col=DIM):
    w = int(tl(font, text)) + pad * 2
    g = G(w, h); g.rrect([0, 0, w - 1, h - 1], h / 2, fill=fill, outline=outline, width=1.5)
    g.text((w / 2, h / 2 + 1), text, font, col, "mm"); return g.out()


def card_base(w, h, r=28, tint=None, glow=None):
    """Glass card with shadow; returns sprite with padding PAD."""
    pad = 70
    sh, p0 = blur_sprite(w, h, r, 22, (0, 0, 0), 120, 14)
    out = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    out.alpha_composite(sh, (pad - p0, pad - p0))
    if glow:
        gl, q = blur_sprite(w, h, r, 26, glow, 70); out.alpha_composite(gl, (pad - q, pad - q))
    g = G(w, h)
    g.gfill([0, 0, w - 1, h - 1], r, (30, 34, 54), (20, 23, 38), "v")
    if tint: g.gfill([0, 0, w - 1, h - 1], r, tint, tint, "v", alpha=26)
    g.rrect([0, 0, w - 1, h - 1], r, outline=(255, 255, 255, 38), width=1.5)
    g.rrect([r, 0, w - r, 2], 1, fill=(255, 255, 255, 60))
    out.alpha_composite(g.out(), (pad, pad)); return out, pad


# ---------------------------------------------------------------- chrome
def header_sprite(idx, heading):
    g = G(W - 2 * MX, 120)
    g.gfill([0, 18, 36, 22], 2, ACC, ACC2, "h")
    g.gtext((52, 2), f"{idx + 1:02d}", mono(26, True), ACC, ACC2, "la")
    g.text((0, 40), heading, sd(60, "b"), FG, "la")
    return g.out()


def brand_sprite():
    g = G(300, 48); f = sd(24, "s")
    g.text((300, 24), "AgentFramework", f, DIM, "rm")
    spr = g.out(); spr.alpha_composite(logo_sprite(32, False), (300 - int(tl(f, "AgentFramework")) - 46, 8)); return spr


def footer_sprite(i, label, n):
    g = G(W - 2 * MX, 40)
    g.ellipse([0, 12, 12, 24], fill=ACC + (255,))
    g.text((28, 18), label, sd(26, "s"), (190, 197, 214), "lm")
    g.text((W - 2 * MX, 18), f"{i + 1:02d} / {n:02d}", mono(24), MUT, "rm")
    return g.out()


def progress_sprites(Ts):
    w, h = W - 2 * MX, 6; total = sum(Ts); gap = 6
    track, mask = G(w, h), G(w, h); x = 0.0
    for k, T in enumerate(Ts):
        x1 = x + T / total * w
        box = [x + (gap / 2 if k else 0), 0, x1 - (gap / 2 if k < len(Ts) - 1 else 0), h]
        track.rrect(box, 3, fill=(255, 255, 255, 34)); mask.rrect(box, 3, fill=(255, 255, 255, 255)); x = x1
    tr, mk = track.out(), mask.out()
    fill = grad_img(w, h, ACC, ACC2, "h"); fill.putalpha(mk.getchannel("A"))
    head, hp = blur_sprite(10, 10, 5, 6, ACC, 255)
    return tr, fill, head, hp


# ---------------------------------------------------------------- subtitles
def sub_chunks(text, font, maxw):
    sents = [s for s in re.split(r"(?<=[.?!])\s+", text.strip()) if s]
    out = []
    def add(s):
        lines = wrap_words(s, font, maxw)
        if len(lines) <= 2: out.append((s, lines)); return
        words = s.split(" "); acc = 0; cut = 1
        for k, w in enumerate(words):
            acc += len(w) + 1
            if acc >= len(s) / 2: cut = k + 1; break
        add(" ".join(words[:cut])); add(" ".join(words[cut:]))
    for s in sents: add(s)
    return out


def subtitle_layers(narr, D):
    f = sd(34, "m"); chunks = sub_chunks(narr, f, 1360)
    tot = sum(len(c[0]) for c in chunks); t = 0.3; layers = []
    for k, (s, lines) in enumerate(chunks):
        span = D * len(s) / tot; lh = 48
        w = int(max(tl(f, ln) for ln in lines)) + 80; h = lh * len(lines) + 32
        g = G(w, h)
        g.rrect([0, 0, w - 1, h - 1], 30 if len(lines) == 1 else 36, fill=(8, 10, 18, 214), outline=(255, 255, 255, 30), width=1.5)
        for j, ln in enumerate(lines): g.text((w / 2, 16 + lh * j + lh / 2), ln, f, (240, 243, 250), "mm")
        a, b = t - 0.05, t + span
        fn = (lambda tt, a=a, b=b: (min(smooth((tt - a) / 0.2), 1 - smooth((tt - (b - 0.15)) / 0.2)), 0, 0))
        layers.append(Lay(g.out(), (W - w) // 2, H - 140 - h, fn)); t += span
    return layers

# ----------------------------------------------------------------------------------------------
# Terminal
# ----------------------------------------------------------------------------------------------
CMD_F, OUT_F = None, None   # set lazily (fonts need S)
TB = 56                     # title bar height
PAD_X, PAD_T = 36, 28


def window_sprite(w, h, title):
    pad = 90
    sh, p0 = blur_sprite(w, h, 22, 30, (0, 0, 0), 190, 26)
    out = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0)); out.alpha_composite(sh, (pad - p0, pad - p0))
    gl, q = blur_sprite(w, h, 22, 40, IND, 40); out.alpha_composite(gl, (pad - q, pad - q))
    g = G(w, h)
    g.rrect([0, 0, w - 1, h - 1], 22, fill=(12, 14, 24, 246))
    g.rrect([0, 0, w - 1, TB], 22, fill=(30, 34, 52, 255), corners=(True, True, False, False))
    g.rect = None
    g.d.rectangle([0, (TB - 22) * S, w * S, TB * S], fill=(30, 34, 52, 255))
    g.d.line([0, TB * S, w * S, TB * S], fill=(255, 255, 255, 22), width=S)
    for k, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        g.ellipse([28 + k * 30, TB / 2 - 7, 42 + k * 30, TB / 2 + 7], fill=c + (255,))
    g.text((w / 2, TB / 2 + 1), title, sd(22, "m"), (150, 158, 178), "mm")
    g.rrect([0, 0, w - 1, h - 1], 22, outline=(255, 255, 255, 46), width=1.5)
    out.alpha_composite(g.out(), (pad, pad)); return out, pad


def color_cmd(cmd):
    cols = []; expect = True
    for tok in re.split(r"( )", cmd):
        if tok == " " or tok == "": cols += [TXT] * len(tok); continue
        if tok == "|": c = MUT; expect = True
        elif expect: c = PNK if tok.startswith("/") else BLU; expect = False
        elif tok.startswith("-"): c = AMB
        elif tok.startswith("http"): c = CYA
        elif tok.startswith("/"): c = PNK
        elif tok.startswith("<"): c = AMB
        elif tok.endswith(".ts") or tok.endswith(".sh"): c = CYA
        else: c = TXT
        cols += [c] * len(tok)
    return cols


def color_out(line):
    """-> list of (text, color)"""
    m = re.match(r'^(\s*)"([^"]+)": (.*?)(,?)$', line)
    if m:
        ind, k, v, comma = m.groups()
        vc = AMB if re.fullmatch(r"-?\d+", v) else GRN if v.startswith('"') else TXT
        return [(ind + '"', MUT), (k, SKY), ('": ', MUT), (v, vc), (comma, MUT)]
    if line.strip() in "{}[]": return [(line, MUT)]
    m = re.match(r"^(\[.*\])$", line)
    if m: return [(line, AMB)]
    m = re.match(r"^([\w-]+): (.*)$", line)
    if m: return [(m.group(1) + ": ", DIM), (m.group(2), (226, 231, 240))]
    return [(line, TXT)]


def tree_runs(line):
    if line == "knowledge/": return [(line, FG)]
    if not line.startswith("    "):
        a, _, b = line.partition("  (")
        return [(a, BLU)] + ([("  (" + b, MUT)] if b else [])
    return [(line, DIM)]


def draw_runs(g, x, y, runs, font, alpha=255):
    for txt, col in runs:
        g.text((x, y), txt, font, col + (alpha,), "ls"); x += tl(font, txt)


def build_terminal(idx, T, kind, p):
    cf, of = mono(30), mono(24)
    title, cmds = p[0], p[1]
    ww = W - 2 * MX; inner = ww - 2 * PAD_X
    # commands -> wrapped, colored char lines
    cmd_lines = []   # per command: list of (prompt, [(ch,col)...] chars) lines
    for pr, c in cmds:
        chars = [(ch, col) for ch, col in zip(c, color_cmd(c))]
        plen = tl(cf, pr); lines = []; cur = []; cw = plen
        for ch, col in chars:
            w1 = tl(cf, ch)
            if cw + w1 > inner: lines.append(cur); cur = []; cw = 0
            cur.append((ch, col)); cw += w1
        lines.append(cur)
        cmd_lines.append((pr, lines))
    CL = 46; OL = 34 if kind == "termout" else 30
    n_cmd_lines = sum(len(l) for _, l in cmd_lines)
    if kind == "termtree":
        groups = []
        for ln in p[2]:
            if ln == "knowledge/": continue
            if not ln.startswith("    "): groups.append([ln])
            else: groups[-1].append(ln)
        c1, c2 = groups[:3], groups[3:]
        col1 = [x for gp in c1 for x in gp]; col2 = [x for gp in c2 for x in gp]
        out_n = 1 + max(len(col1), len(col2))
        outl = None
    elif kind == "termout":
        out_n = len(p[2])
    else:
        out_n = 0
    body = PAD_T + n_cmd_lines * CL + (22 + out_n * OL if out_n else 0) + 30
    wh = TB + max(body, 150)
    win, wpad = window_sprite(ww, wh, WINTITLE[idx])
    total = sum(len(c) for _, c in cmds)
    t0 = 0.6; tdur = min(7.0, max(0.9, T * 0.42))
    t_out = t0 + tdur + 0.35
    out_step = 0.16 if kind == "termout" else 0.11
    cache = {}

    def dyn(t):
        n = int(min(1.0, max(0.0, (t - t0) / tdur)) * total + 0.001)
        typing = 0 < n < total or (t >= t0 and n < total)
        cursor_on = True if (t < t0 + tdur) else (int(t * 2.2) % 2 == 0)
        vis = 0; la = 4
        if out_n and t >= t_out:
            vis = min(out_n, int((t - t_out) / out_step) + 1)
            la = 4 if vis >= out_n and (t - t_out) > out_n * out_step else int(smooth(((t - t_out) % out_step) / (out_step * 1.6)) * 4)
            if vis >= out_n: la = 4
        key = (n, vis, la, cursor_on)
        if key in cache: return cache[key]
        g = G(ww, wh - TB); y = PAD_T + 32; rem = n; cx = cy = None
        for pr, lines in cmd_lines:
            for li, chars in enumerate(lines):
                x = PAD_X
                if li == 0: g.text((x, y), pr, cf, GRN + (255,), "ls"); x += tl(cf, pr)
                take = chars[:max(0, rem)] if rem < len(chars) or True else chars
                shown = chars[:rem] if rem >= 0 else []
                for ch, col in shown:
                    g.text((x, y), ch, cf, col + (255,), "ls"); x += tl(cf, ch)
                cx, cy = x, y
                rem -= len(chars)
                if rem < 0: break
                y += CL
            if rem < 0: break
            rem = max(rem, 0) if False else rem
        if cursor_on:
            if cx is not None:
                g.rrect([cx + 3, cy - 25, cx + 17, cy + 6], 2, fill=(236, 240, 250, 235))
        if out_n and vis:
            y0 = PAD_T + n_cmd_lines * CL + 22 + 24
            if kind == "termout":
                for k in range(vis):
                    a = la * 63 + 3 if k == vis - 1 else 255
                    draw_runs(g, PAD_X, y0 + k * OL, color_out(p[2][k]), of, min(255, a))
            else:
                items = [("knowledge/", 0, 0)] + [(x, 0, 1 + i) for i, x in enumerate(col1)]
                # header + two columns
                allv = [(0, 0, "knowledge/")] + [(0, 1 + i, x) for i, x in enumerate(col1)] + [(1, 1 + i, x) for i, x in enumerate(col2)]
                order = sorted(allv, key=lambda r: (r[1], r[0]))
                for k, (cidx, row, txt) in enumerate(order[:vis]):
                    a = la * 63 + 3 if k == vis - 1 else 255
                    xx = PAD_X + cidx * (inner // 2 + 20)
                    draw_runs(g, xx, y0 + row * OL, tree_runs(txt), of, min(255, a))
        spr = g.out(); cache[key] = spr
        if len(cache) > 400: cache.pop(next(iter(cache)))
        return spr

    return win, wpad, wh, dyn


def chip_sprite(text, accent):
    f = sd(32, "m"); w = int(tl(f, text)) + 128; h = 76
    spr, pad = card_base(w, h, 22, accent, None)
    g = G(spr.width, spr.height)
    g.gfill([pad + 20, pad + 16, pad + 64, pad + 60], 14, accent, mix(accent, (255, 255, 255), 0.0), "diag", 255)
    icon(g, "check", pad + 42, pad + 38, (10, 14, 24, 255))
    g.text((pad + 84, pad + h / 2 + 1), text, f, (226, 231, 242), "lm")
    spr.alpha_composite(g.out()); return spr, pad


# ----------------------------------------------------------------------------------------------
# Scenes
# ----------------------------------------------------------------------------------------------
class Scene:
    def __init__(s, i, T, sc):
        s.i, s.T = i, T
        narr, kind, p = sc
        s.kind = kind
        s.bg = make_bg(GLOWS[i % 3], seed=i)
        s.zoom = 0.085 if kind == "title" else 0.028
        s.drift = (1 if i % 2 == 0 else -1)
        s.layers = []; s.over = []
        is_title = kind == "title"
        label = ("소개" if i == 0 else "마무리") if is_title else p[0]
        N = len(SCENES)
        if not is_title:
            s.layers.append(Lay(header_sprite(i, p[0]), MX, 64, enter(0.05, 0.7, 0, 22)))
            s.layers.append(Lay(brand_sprite(), W - MX - 300, 80, fade(0.2, 0.6)))
        s.layers.append(Lay(footer_sprite(i, label, N), MX, 976, fade(0.15, 0.5)))
        getattr(s, "b_" + kind)(p)
        s.subs = subtitle_layers(narr, T - 0.9)

    # -- title / outro
    def b_title(s, p):
        a, b = p; i = s.i
        lg = logo_sprite(120)
        lpad = int(120 * 0.6)
        s.orbs = []
        for (r, col, px, py, sx) in [(230, IND, 360, 300, 1.0), (180, ACC, 1560, 760, -1.4), (120, TEAL, 1450, 240, 0.7)]:
            sp, q = blur_sprite(r, r, r // 2, r * 0.45, col, 95)
            s.orbs.append((sp, px - sp.width / 2, py - sp.height / 2, sx))
        s.layers.append(Lay(lg, W // 2 - lg.width // 2, 214 - lpad, both_enter(0.1, 0.9, 0, 30)))
        if i == 0:
            main, tag = [x.strip() for x in a.split("·")]
            f = sd(132, "b"); g = G(1400, 190)
            wm = tl(f, main); wt = 0
            tf = sd(48, "b"); tagw = int(tl(tf, tag)) + 56
            total = wm + 28 + tagw; x0 = (1400 - total) / 2
            g.gtext((x0, 150), main, f, (255, 255, 255), (206, 214, 255), "ls", "h")
            bx = x0 + wm + 28
            g.gfill([bx, 70, bx + tagw, 70 + 76], 38, ACC, ACC2, "h")
            g.text((bx + tagw / 2, 70 + 40), tag, tf, (255, 255, 255, 255), "mm")
            s.layers.append(Lay(g.out(), (W - 1400) // 2, 380, enter(0.35, 0.9, 0, 36)))
            g2 = G(1400, 70); g2.text((700, 36), b, sd(44, "m"), (196, 203, 222), "mm")
            s.layers.append(Lay(g2.out(), (W - 1400) // 2, 590, enter(0.75, 0.9, 0, 26)))
            bar = G(160, 6); bar.gfill([0, 0, 160, 6], 3, ACC, ACC2, "h")
            s.layers.append(Lay(bar.out(), W // 2 - 80, 560, lambda t: (smooth((t - 1.0) / 0.6), 0, 0)))
        else:
            f = sd(104, "b"); g = G(1600, 180)
            g.gtext((800, 120), a, f, (255, 255, 255), (255, 190, 160), "ms", "h")
            s.layers.append(Lay(g.out(), (W - 1600) // 2, 380, enter(0.35, 0.9, 0, 36)))
            url, _, lic = b.partition("  ·  ")
            mf = mono(36, True); lf = sd(30, "b")
            uw = int(tl(mf, url)) + 64; lw = int(tl(lf, lic)) + 44; gap = 20
            tot = uw + gap + lw; g = G(tot, 76)
            g.rrect([0, 0, uw - 1, 75], 38, fill=(255, 255, 255, 22), outline=(255, 255, 255, 56), width=1.5)
            g.text((uw / 2, 40), url, mf, (236, 240, 250, 255), "mm")
            g.gfill([uw + gap, 0, tot - 1, 75], 38, ACC, ACC2, "h")
            g.text((uw + gap + lw / 2, 40), lic, lf, (255, 255, 255, 255), "mm")
            s.layers.append(Lay(g.out(), (W - tot) // 2, 590, enter(0.8, 0.9, 0, 26)))

    # -- bullets
    def b_bullets(s, p):
        T = s.T; items = p[1]; cw, ch, gap = W - 2 * MX, 148, 24
        icons = ICONS.get(s.i, ["doc"] * 3); tones = TONES
        starts = [0.4 + k * (T * 0.22) for k in range(len(items))]
        for k, txt in enumerate(items):
            c0, c1 = TONES[k % 3]
            y = 252 + k * (ch + gap)
            for hot in (False, True):
                spr, pad = card_base(cw, ch, 28, c0, c0 if hot else None)
                g = G(spr.width, spr.height)
                g.gfill([pad + 36, pad + 34, pad + 116, pad + 114], 22, c0, c1, "diag")
                icon(g, icons[k], pad + 76, pad + 74)
                g.text((pad + 156, pad + ch / 2 + 1), txt, sd(42, "m"), FG + (255,), "lm")
                g.text((pad + cw - 40, pad + ch / 2 + 1), f"0{k + 1}", mono(44, True), (255, 255, 255, 36), "rm")
                if hot:
                    g.rrect([pad, pad, pad + cw - 1, pad + ch - 1], 28, outline=c0 + (200,), width=2)
                    spr.alpha_composite(g.out()); hs = spr
                else:
                    spr.alpha_composite(g.out()); ns = spr
            st = starts[k]; nxt = starts[k + 1] if k + 1 < len(items) else 1e9
            ent = enter(st, 0.7, -60, 0)
            s.layers.append(Lay(ns, MX - pad, y - pad, ent))
            s.layers.append(Lay(hs, MX - pad, y - pad, (lambda t, ent=ent, nxt=nxt: (ent(t)[0] * (1 - smooth((t - nxt) / 0.6)), ent(t)[1], 0))))

    # -- flow
    def b_flow(s, p):
        T = s.T; steps = p[1]; bw, bh, gap = 330, 220, 136; y0 = 296
        starts = [0.5 + k * (T * 0.17) for k in range(len(steps))]
        ic = ["doc", "check", "gear", "db"]
        for k, txt in enumerate(steps):
            c0, c1 = TONES[k % 3]; x = MX + k * (bw + gap)
            vs = []
            for lvl in range(3):  # 0 idle, 1 lit, 2 active
                spr, pad = card_base(bw, bh, 28, c0 if lvl else None, c0 if lvl == 2 else None)
                g = G(spr.width, spr.height)
                if lvl:
                    g.gfill([pad + bw / 2 - 36, pad + 28, pad + bw / 2 + 36, pad + 100], 22, c0, c1, "diag")
                    icon(g, ic[k], pad + bw / 2, pad + 64)
                else:
                    g.rrect([pad + bw / 2 - 36, pad + 28, pad + bw / 2 + 36, pad + 100], 22, fill=(255, 255, 255, 18))
                    icon(g, ic[k], pad + bw / 2, pad + 64, (255, 255, 255, 70))
                f = mono(40, True) if txt.startswith("/") else sd(40, "b")
                g.text((pad + bw / 2, pad + 158), txt, f, FG + (255,) if lvl else (120, 128, 148, 255), "mm")
                g.text((pad + 24, pad + 24), f"{k + 1}", mono(22, True), (255, 255, 255, 90 if lvl else 40), "la")
                if lvl: g.rrect([pad, pad, pad + bw - 1, pad + bh - 1], 28, outline=c0 + (230,), width=2.5)
                spr.alpha_composite(g.out()); vs.append(spr)
            pad = 70; nxt = starts[k + 1] if k + 1 < len(steps) else 1e9
            lit = lambda t, st=starts[k]: smooth((t - st) / 0.35)
            act = lambda t, st=starts[k], nx=nxt: smooth((t - st) / 0.35) * (1 - smooth((t - nx) / 0.5))
            pulse = lambda t: 0.75 + 0.25 * math.sin(t * 4.0)
            s.layers.append(Lay(vs[0], x - pad, y0 - pad, enter(0.1 + k * 0.12, 0.7, 0, 30)))
            s.layers.append(Lay(vs[1], x - pad, y0 - pad, lambda t, lit=lit, e=enter(0.1 + k * 0.12, 0.7, 0, 30): (lit(t) * e(t)[0], 0, e(t)[2])))
            s.layers.append(Lay(vs[2], x - pad, y0 - pad, lambda t, act=act, pulse=pulse, e=enter(0.1 + k * 0.12, 0.7, 0, 30): (act(t) * pulse(t) * e(t)[0], 0, e(t)[2])))
        # connectors with animated progress
        cy = y0 + bh / 2
        for k in range(len(steps) - 1):
            xa = MX + k * (bw + gap) + bw + 14; xb = MX + (k + 1) * (bw + gap) - 14; L_ = xb - xa
            g = G(L_ + 24, 40)
            g.line([(0, 20), (L_ - 8, 20)], (255, 255, 255, 50), 4)
            g.poly([(L_ - 16, 10), (L_, 20), (L_ - 16, 30)], (255, 255, 255, 50))
            base = g.out()
            gf = G(L_ + 24, 40)
            gf.line([(0, 20), (L_ - 8, 20)], (255, 255, 255, 255), 4)
            gf.poly([(L_ - 16, 10), (L_, 20), (L_ - 16, 30)], (255, 255, 255, 255))
            mk = gf.out().getchannel("A")
            gr = grad_img(L_ + 24, 40, TONES[k % 3][0], TONES[(k + 1) % 3][0], "h")
            ta, tb = starts[k] + 0.25, starts[k + 1] - 0.05
            def conn(t, base=base, mk=mk, gr=gr, L_=L_, ta=ta, tb=tb):
                p_ = ease((t - ta) / max(0.3, tb - ta)); bw_ = base.width
                a = Image.new("L", mk.size, 0); cut = int((L_ + 24) * p_)
                if cut > 0: a.paste(mk.crop((0, 0, cut, mk.height)), (0, 0))
                f = gr.copy(); f.putalpha(a)
                o = base.copy(); o.alpha_composite(f); return o
            s.layers.append(Lay(conn, xa, cy - 20 - 4, fade(0.5, 0.5)))
        cap = "계획은 자동 승인되지 않습니다 — 사람의 명시적 승인 후에만 실행"
        f = sd(34, "m"); w = int(tl(f, cap)) + 150; h = 96
        spr, pad = card_base(w, h, 30, TEAL, None)
        g = G(spr.width, spr.height)
        g.gfill([pad + 24, pad + 24, pad + 72, pad + 72], 16, TEAL, SKY)
        icon(g, "lock", pad + 48, pad + 48, (255, 255, 255, 255), (30, 150, 170, 255))
        g.text((pad + 96, pad + h / 2 + 1), cap, f, (226, 231, 242, 255), "lm")
        spr.alpha_composite(g.out())
        s.layers.append(Lay(spr, (W - w) // 2 - pad, 616 - pad, enter(starts[-1] + 0.6, 0.7, 0, 26)))

    # -- terminals
    def _term(s, p, kind):
        win, wpad, wh, dyn = build_terminal(s.i, s.T, kind, p)
        wy = 236
        s.layers.append(Lay(win, MX - wpad, wy - wpad, enter(0.05, 0.7, 0, 30)))
        s.layers.append(Lay(dyn, MX, wy + TB, fade(0.1, 0.3)))
        if kind == "term":
            t_chip = min(7.0, max(0.9, s.T * 0.42)) + 0.9
            for k, txt in enumerate(p[2]):
                spr, pad = chip_sprite(txt, TONES[k % 3][0])
                s.layers.append(Lay(spr, MX - pad, wy + wh + 44 - pad + k * 96, enter(t_chip + k * 0.35, 0.7, -50, 0)))

    def b_term(s, p): s._term(p, "term")
    def b_termtree(s, p): s._term(p, "termtree")
    def b_termout(s, p): s._term(p, "termout")

    # -- render
    def render(s, t):
        T = s.T; q = max(0.0, min(1.0, t / T))
        z = 1 + s.zoom * q
        w_, h_ = W / z, H / z
        x0 = (W - w_) / 2 + s.drift * (W - w_) * 0.6 * (q - 0.5) ; y0 = (H - h_) / 2
        cv = s.bg.resize((W, H), Image.BICUBIC, box=(x0, y0, x0 + w_, y0 + h_))
        if s.kind == "title":
            for sp, ox, oy, sx in s.orbs:
                put(cv, sp, ox + sx * 60 * (q - 0.5) * -2 + math.sin(t * 0.6 + sx) * 12, oy + math.cos(t * 0.5 + sx) * 10, smooth(t / 1.2))
        draw_layers(cv, s.layers, max(0.0, t))
        draw_layers(cv, s.subs, max(0.0, t))
        return cv


def both_enter(t0, d, dx, dy):
    f = enter(t0, d, dx, dy)
    def g(t):
        a, ox, oy = f(t); return a, ox, oy + math.sin(t * 1.2) * 4 * a
    return g


def dur(path):
    r = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path], capture_output=True, text=True)
    return float(json.loads(r.stdout)["format"]["duration"])


def main():
    Ts, wavs = [], []
    for i, sc in enumerate(SCENES):
        aiff = f"{OUT}/s{i}.aiff"
        subprocess.run(["say", "-v", "Yuna", "-r", "185", "-o", aiff, sc[0]], check=True)
        T = dur(aiff) + 0.9; Ts.append(T)
        wav = f"{OUT}/s{i}.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", aiff, "-af", "adelay=300|300,apad", "-t", f"{T:.3f}",
                        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", wav], check=True)
        wavs.append(wav)
    with open(f"{OUT}/alist.txt", "w") as fh: fh.writelines(f"file '{w}'\n" for w in wavs)
    full = f"{OUT}/audio.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", f"{OUT}/alist.txt", "-c", "copy", full], check=True)
    scenes = [Scene(i, Ts[i], sc) for i, sc in enumerate(SCENES)]
    starts = [sum(Ts[:i]) for i in range(len(Ts))]; total = sum(Ts)
    tr, pfill, phead, hp = progress_sprites(Ts); pw = W - 2 * MX
    final = os.path.abspath("artifacts/otter-intro-video/otter-intro.mp4"); os.makedirs(os.path.dirname(final), exist_ok=True)
    ff = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                           "-i", full, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "19",
                           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", final], stdin=subprocess.PIPE)
    nf = int(total * FPS)
    for f in range(nf):
        g = f / FPS
        i = max(k for k in range(len(starts)) if starts[k] <= g + 1e-9)
        im = scenes[i].render(g - starts[i]).convert("RGB")
        if i + 1 < len(scenes) and g > starts[i + 1] - XFADE:      # crossfade into next
            nx = scenes[i + 1].render(0.0).convert("RGB")
            im = Image.blend(im, nx, smooth((g - (starts[i + 1] - XFADE)) / (2 * XFADE)))
        elif i > 0 and g < starts[i] + XFADE:                       # second half of crossfade
            pv = scenes[i - 1].render(g - starts[i - 1]).convert("RGB")
            im = Image.blend(pv, im, smooth((g - (starts[i] - XFADE)) / (2 * XFADE)))
        im = im.convert("RGBA")
        put(im, tr, MX, 1036); px = int(pw * g / total)
        if px > 0: put(im, pfill.crop((0, 0, px, 6)), MX, 1036)
        put(im, phead, MX + px - 5 - hp, 1039 - 5 - hp)
        rgb = im.convert("RGB")
        if g < 0.5: rgb = Image.blend(Image.new("RGB", (W, H)), rgb, smooth(g / 0.5))
        if g > total - 0.7: rgb = Image.blend(Image.new("RGB", (W, H)), rgb, smooth((total - g) / 0.7))
        ff.stdin.write(rgb.tobytes())
        if f % 300 == 0: print(f"frame {f}/{nf}", flush=True)
    ff.stdin.close(); assert ff.wait() == 0
    print(final, f"{dur(final):.1f}s")


main()
