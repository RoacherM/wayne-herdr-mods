# A full-screen program that scrolls with the mouse wheel, for dev/bench.mjs: like a coding
# agent's full-screen view (Claude Code), every change redraws the whole screen in colour.
# Wheel up/down moves 3 lines. It reads all the input there is, then draws once.
import os, select, shutil, signal, sys

LINES = [f"\x1b[38;5;{(i * 7) % 200 + 20}m{i:5d}\x1b[0m  \x1b[1m●\x1b[0m line {i} of the transcript \x1b[2m— {'lorem ipsum dolor sit amet ' * 3}\x1b[0m" for i in range(3000)]
top = len(LINES)  # the bottom row shows the line just above `top`
out = sys.stdout

def draw(*_):
    cols, rows = shutil.get_terminal_size()
    first = max(0, top - rows)
    buf = ["\x1b[?2026h\x1b[H"]
    for r in range(rows):
        i = first + r
        buf.append(f"\x1b[{r + 1};1H\x1b[2K" + (LINES[i][: cols + 40] if i < len(LINES) else ""))
    buf.append("\x1b[?2026l")
    out.write("".join(buf)); out.flush()

signal.signal(signal.SIGWINCH, draw)
os.system("stty raw -echo")
out.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l"); draw()
fd = sys.stdin.fileno()
pending = b""
while True:
    select.select([fd], [], [])
    pending += os.read(fd, 4096)
    while select.select([fd], [], [], 0)[0]:
        pending += os.read(fd, 4096)
    moved = False
    while True:
        i = pending.find(b"\x1b[<")
        if i < 0: pending = b""; break
        j = min([k for k in (pending.find(b"M", i), pending.find(b"m", i)) if k >= 0] or [-1])
        if j < 0: pending = pending[i:]; break
        b = pending[i + 3: j].split(b";")[0]
        pending = pending[j + 1:]
        if b == b"64": top = max(1, top - 3); moved = True
        elif b == b"65": top = min(len(LINES), top + 3); moved = True
    if moved: draw()
