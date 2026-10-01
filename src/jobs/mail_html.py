#!/usr/bin/env python3
"""One look for every email the jobs send (the weekly summary's design, src/tools/weekly.js): a white card on a grey
page, the portfolio name and a title over an accent rule, then blocks, one button and a small footer. Inline styles
only (Gmail drops most <style>), tables for layout, readable at phone width and in Gmail's dark mode.

    html = page(kicker, title, blocks, subtitle=None, button=None, foot=None, preheader=None)

blocks (each a tuple; text is escaped here, never pass HTML):
    ("p", text)                         a paragraph
    ("h", title[, sub])                 a section heading
    ("tiles", [(label, value, sub, tone)])   2-3 number tiles; tone: None | "pos" | "neg"
    ("facts", [(label, value[, tone])]) a two-column list (label left, value right)
    ("list", [text, ...])               rows with a thin rule between them
    ("steps", [text, ...])              a numbered list
    ("box", tone, title, [lines])       a coloured callout; tone: "info" | "good" | "warn" | "bad"
    ("table", [head...], [[cell...]], [align...])   a small table (align "l" / "r")
button = (label, url); foot = text or [texts]."""
import html as _h

C = {"page": "#EEF1F4", "card": "#FFFFFF", "ink": "#17212B", "ink2": "#4A5563", "mute": "#6B7582", "line": "#E2E7EC",
     "soft": "#F5F7F9", "pos": "#15803D", "neg": "#C62828", "accent": "#0F5E6E"}
BOX = {"info": ("#EAF4F6", "#0F5E6E"), "good": ("#E7F4EC", "#15803D"), "warn": ("#FFF7E6", "#B7791F"), "bad": ("#FCEBEB", "#C62828")}
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
TONE = {None: C["ink"], "pos": C["pos"], "neg": C["neg"], "mute": C["mute"]}


def esc(s):
    return _h.escape(str(s if s is not None else ""), quote=True)


def tone_of(x, eps=0.0005):
    """'pos' / 'neg' / None for a number (a return or an amount)."""
    if x is None or abs(x) < eps:
        return None
    return "pos" if x > 0 else "neg"


def _row(inner, pad="0 24px"):
    return f'<tr><td class="m-px" style="padding:{pad}">{inner}</td></tr>'


def _tbl(inner, extra=""):
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;{extra}">{inner}</table>'


def _block(b):
    k = b[0]
    if k == "p":
        return _row(f'<div style="font-size:15px;line-height:23px;color:{C["ink"]};padding:6px 0">{esc(b[1])}</div>')
    if k == "h":
        sub = f'<div style="font-size:12px;line-height:18px;color:{C["mute"]}">{esc(b[2])}</div>' if len(b) > 2 and b[2] else ""
        return _row(f'<div style="font-size:16px;line-height:22px;font-weight:700;color:{C["ink"]};padding-top:16px">{esc(b[1])}</div>{sub}', "0 24px 4px")
    if k == "tiles":
        cells = "".join(
            f'<td valign="top" width="{100 // len(b[1])}%" style="padding:10px 12px;background:{C["soft"]};border-radius:8px">'
            f'<div style="font-size:11px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:{C["mute"]}">{esc(lab)}</div>'
            f'<div style="font-size:19px;line-height:26px;font-weight:700;color:{TONE.get(t, C["ink"])};white-space:nowrap">{esc(val)}</div>'
            + (f'<div style="font-size:12px;line-height:16px;color:{C["mute"]}">{esc(sub)}</div>' if sub else "") + "</td>"
            for lab, val, sub, t in b[1])
        return f'<tr><td class="m-tiles" style="padding:6px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0" style="width:100%;border-collapse:separate"><tr>{cells}</tr></table></td></tr>'
    if k == "facts":
        rows = "".join(
            f'<tr><td style="padding:9px 0;border-top:1px solid {C["line"]};font-size:14px;line-height:20px;color:{C["ink2"]}">{esc(f[0])}</td>'
            f'<td style="padding:9px 0 9px 12px;border-top:1px solid {C["line"]};font-size:14px;line-height:20px;font-weight:600;text-align:right;'
            f'color:{TONE.get(f[2] if len(f) > 2 else None, C["ink"])}">{esc(f[1])}</td></tr>' for f in b[1])
        return _row(_tbl(rows, f"border-bottom:1px solid {C['line']}"), "4px 24px")
    if k == "list":
        rows = "".join(f'<tr><td style="padding:9px 0;border-top:1px solid {C["line"]};font-size:14px;line-height:21px;color:{C["ink"]}">{esc(x)}</td></tr>' for x in b[1])
        return _row(_tbl(rows, f"border-bottom:1px solid {C['line']}"), "4px 24px")
    if k == "steps":
        rows = "".join(
            f'<tr><td valign="top" width="28" style="padding:7px 0"><div style="width:22px;height:22px;border-radius:11px;background:{C["accent"]};color:#fff;'
            f'font-size:12px;line-height:22px;font-weight:700;text-align:center">{i + 1}</div></td>'
            f'<td style="padding:7px 0 7px 6px;font-size:14px;line-height:21px;color:{C["ink"]}">{esc(x)}</td></tr>' for i, x in enumerate(b[1]))
        return _row(_tbl(rows), "4px 24px")
    if k == "box":
        bg, bar = BOX[b[1]]
        title = f'<div style="font-size:14px;line-height:20px;font-weight:700;color:{bar}">{esc(b[2])}</div>' if b[2] else ""
        lines = "".join(f'<div style="font-size:14px;line-height:21px;color:{C["ink"]};padding-top:4px">{esc(x)}</div>' for x in (b[3] if len(b) > 3 else []))
        return _row(f'<div style="background:{bg};border-left:4px solid {bar};border-radius:6px;padding:10px 14px;margin:8px 0">{title}{lines}</div>')
    if k == "table":
        head, rows = b[1], b[2]
        al = b[3] if len(b) > 3 else ["l"] + ["r"] * (len(head) - 1)
        A = lambda i: "right" if al[i] == "r" else "left"
        th = "".join(f'<th style="padding:6px 0 6px {0 if i == 0 else 10}px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;'
                     f'text-transform:uppercase;color:{C["mute"]};text-align:{A(i)}">{esc(x)}</th>' for i, x in enumerate(head))
        body = "".join("<tr>" + "".join(
            f'<td style="padding:8px 0 8px {0 if i == 0 else 10}px;border-top:1px solid {C["line"]};font-size:14px;line-height:20px;text-align:{A(i)};'
            f'color:{TONE.get(c[1], C["ink"]) if isinstance(c, tuple) else C["ink"]};{"white-space:nowrap;" if al[i] == "r" else ""}">'
            f'{esc(c[0] if isinstance(c, tuple) else c)}</td>' for i, c in enumerate(r)) + "</tr>" for r in rows)
        return _row(_tbl(f"<tr>{th}</tr>{body}", f"border-bottom:1px solid {C['line']}"), "4px 24px")
    raise ValueError(f"unknown block {k}")


def page(kicker, title, blocks, subtitle=None, button=None, foot=None, preheader=None):
    sub = f'<div style="font-size:13px;line-height:19px;color:{C["mute"]};padding-bottom:12px">{esc(subtitle)}</div>' if subtitle else '<div style="height:12px"></div>'
    btn = (f'<tr><td class="m-px" style="padding:18px 24px 6px"><a href="{esc(button[1])}" style="display:inline-block;background:{C["accent"]};color:#ffffff;'
           f'text-decoration:none;font-size:15px;line-height:20px;font-weight:600;padding:11px 20px;border-radius:8px">{esc(button[0])}</a></td></tr>') if button else ""
    feet = [foot] if isinstance(foot, str) else (foot or [])
    ft = "".join(f'<div style="padding-top:6px">{esc(x)}</div>' for x in feet)
    ft = f'<tr><td class="m-px" style="padding:18px 24px 20px;font-size:12px;line-height:18px;color:{C["mute"]}"><div style="border-top:1px solid {C["line"]};padding-top:8px">{ft}</div></td></tr>' if ft else '<tr><td style="height:16px"></td></tr>'
    pre = f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:{C["page"]}">{esc(preheader)}</div>' if preheader else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">'
        '<style>@media only screen and (max-width:480px){.m-outer{padding:8px 0!important}.m-px{padding-left:16px!important;padding-right:16px!important}'
        '.m-tiles{padding-left:10px!important;padding-right:10px!important}}</style></head>'
        f'<body style="margin:0;padding:0;background:{C["page"]};-webkit-text-size-adjust:100%">{pre}'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{C["page"]};width:100%"><tr>'
        f'<td class="m-outer" align="center" style="padding:16px 8px">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:{C["card"]};'
        f'border:1px solid {C["line"]};border-radius:12px;border-collapse:separate;font-family:{FONT};color:{C["ink"]}">'
        f'<tr><td class="m-px" style="padding:20px 24px 4px;border-bottom:3px solid {C["accent"]}">'
        f'<div style="font-size:12px;line-height:16px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:{C["accent"]}">{esc(kicker)}</div>'
        f'<div style="font-size:22px;line-height:29px;font-weight:700;color:{C["ink"]};padding-top:2px">{esc(title)}</div>{sub}</td></tr>'
        '<tr><td style="height:8px"></td></tr>'
        + "".join(_block(b) for b in blocks) + btn + ft +
        "</table></td></tr></table></body></html>")


def text(title, blocks, button=None, foot=None):
    """The plain-text alternative of the same email (for mail apps that do not show HTML)."""
    out = [title, ""]
    for b in blocks:
        k = b[0]
        if k == "p":
            out += [b[1], ""]
        elif k == "h":
            out += [b[1].upper()] + ([b[2]] if len(b) > 2 and b[2] else [])
        elif k == "tiles":
            out += [f"{lab}: {val}" + (f" ({sub})" if sub else "") for lab, val, sub, _ in b[1]] + [""]
        elif k == "facts":
            out += [f"{f[0]}: {f[1]}" for f in b[1]] + [""]
        elif k == "list":
            out += [f"• {x}" for x in b[1]] + [""]
        elif k == "steps":
            out += [f"{i + 1}. {x}" for i, x in enumerate(b[1])] + [""]
        elif k == "box":
            out += ([b[2]] if b[2] else []) + [f"  {x}" for x in (b[3] if len(b) > 3 else [])] + [""]
        elif k == "table":
            out += ["  ".join(str(x) for x in b[1])] + ["  ".join(str(c[0] if isinstance(c, tuple) else c) for c in r) for r in b[2]] + [""]
    if button:
        out += [f"{button[0]}: {button[1]}", ""]
    feet = [foot] if isinstance(foot, str) else (foot or [])
    out += feet
    return "\n".join(out).rstrip() + "\n"


def email(kicker, title, blocks, subtitle=None, button=None, foot=None, preheader=None):
    """(text, html) of one email."""
    return text(title + (f" · {subtitle}" if subtitle else ""), blocks, button, foot), page(kicker, title, blocks, subtitle, button, foot, preheader)
