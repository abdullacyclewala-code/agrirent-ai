#!/usr/bin/env python3
"""
Build docs/AgriRent_Demo_Guide.pdf — the short, printable demo + test script.

Sources of truth it is written from (so the paper cannot drift from the app):
  * docs/PHASE7_MANUAL_TEST_PLAN.md   — the long-form manual test script
  * scripts/check-demo-ready.mjs      — the five-minute pre-demo check
  * the live app itself: routes, accounts, the prepared booking

Run:  python3 scripts/make-demo-guide.py
"""

import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    KeepTogether, HRFlowable,
)

OUT = "docs/AgriRent_Demo_Guide.pdf"
FONT_DIR = "/usr/share/fonts/truetype/dejavu/"

# The guide mentions "Hindi / Marathi" as words the user can tap. Latin names are
# always readable, so a Devanagari font is a nicety, never a requirement: if one
# is found (system or downloaded once) the script shows हिंदी / मराठी in brackets,
# otherwise it falls back to Latin only. It never renders empty boxes.
DEVA_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansDevanagari-Regular.otf",
    "/tmp/NotoSansDevanagari.ttf",
    "docs/fonts/NotoSansDevanagari.ttf",
]
DEVA_URL = ("https://github.com/google/fonts/raw/main/ofl/notosansdevanagari/"
            "NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf")
DEVA = None
for path in DEVA_PATHS:
    if os.path.exists(path):
        DEVA = path
        break
if DEVA is None:
    try:
        import urllib.request
        os.makedirs("/tmp", exist_ok=True)
        urllib.request.urlretrieve(DEVA_URL, "/tmp/NotoSansDevanagari.ttf")
        DEVA = "/tmp/NotoSansDevanagari.ttf"
    except Exception as exc:  # offline build, no font, no problem
        print(f"  (no Devanagari font available: {exc})")
if DEVA:
    try:
        pdfmetrics.registerFont(TTFont("Deva", DEVA))
        DEVANAGARI = '<font name="Deva">हिंदी / मराठी</font>'
    except Exception:
        DEVANAGARI = "Hindi / Marathi"
else:
    DEVANAGARI = "Hindi / Marathi"
pdfmetrics.registerFont(TTFont("Body", FONT_DIR + "DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("Body-Bold", FONT_DIR + "DejaVuSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Mono", FONT_DIR + "DejaVuSansMono.ttf"))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body", boldItalic="Body-Bold")

INK = colors.HexColor("#251c11")
MUT = colors.HexColor("#6b5f4c")
ACCENT = colors.HexColor("#a8431f")
SAGE = colors.HexColor("#5e6e3e")
LINE = colors.HexColor("#ded4bd")
PAPER = colors.HexColor("#faf6ec")
CARD = colors.HexColor("#fffdf7")
GOLD = colors.HexColor("#b98523")

S = getSampleStyleSheet()
def st(name, **kw):
    base = dict(fontName="Body", fontSize=9.4, leading=13.4, textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)

TITLE = st("t", fontName="Body-Bold", fontSize=21, leading=25, textColor=INK)
SUB = st("s", fontSize=10.5, leading=15, textColor=MUT)
H1 = st("h1", fontName="Body-Bold", fontSize=13.5, leading=17, textColor=ACCENT, spaceBefore=6, spaceAfter=3)
H2 = st("h2", fontName="Body-Bold", fontSize=10.6, leading=14, textColor=INK, spaceBefore=5, spaceAfter=2)
BODY = st("b")
SMALL = st("sm", fontSize=8.4, leading=11.6, textColor=MUT)
CELL = st("c", fontSize=8.7, leading=11.8)
CELLB = st("cb", fontName="Body-Bold", fontSize=8.7, leading=11.8)
CELLM = st("cm", fontName="Mono", fontSize=8.2, leading=11.4)
BULLET = st("bl", fontSize=9.2, leading=12.8, leftIndent=9, bulletIndent=1)


def p(text, style=BODY):
    return Paragraph(text, style)


def bullets(items, style=BULLET):
    return [Paragraph(t, style, bulletText="•") for t in items]


def table(rows, widths, header=True, zebra=True):
    data = []
    for r_i, row in enumerate(rows):
        data.append([Paragraph(c, CELLB if (header and r_i == 0) else CELL) for c in row])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE),
        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
    ]
    if header:
        cmds += [("BACKGROUND", (0, 0), (-1, 0), PAPER), ("LINEBELOW", (0, 0), (-1, 0), 0.7, LINE)]
    if zebra:
        for i in range(1, len(rows)):
            if i % 2 == 0:
                cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fdfbf5")))
    t.setStyle(TableStyle(cmds))
    return t


def callout(title, text, tone=GOLD):
    t = Table([[Paragraph(f"<b>{title}</b><br/>{text}", CELL)]], colWidths=[176 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f7eed6") if tone == GOLD else colors.HexColor("#edf0dd")),
        ("BOX", (0, 0), (-1, -1), 0.6, tone),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


# ---------------------------------------------------------------- page chrome
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(17 * mm, 12 * mm, 193 * mm, 12 * mm)
    canvas.setFont("Body", 7.6)
    canvas.setFillColor(MUT)
    canvas.drawString(17 * mm, 8 * mm, "AgriRent AI — demo & test guide")
    canvas.drawRightString(193 * mm, 8 * mm, f"page {doc.page}")
    canvas.restoreState()


doc = BaseDocTemplate(
    OUT, pagesize=A4,
    leftMargin=17 * mm, rightMargin=17 * mm, topMargin=15 * mm, bottomMargin=16 * mm,
    title="AgriRent AI — Demo & Test Guide", author="AgriRent AI",
)
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=on_page)])

story = []

# ------------------------------------------------------------------- page 1
story += [
    p("AgriRent AI — demo &amp; test guide", TITLE),
    Spacer(1, 3),
    p("Farm-equipment rental for Indian farmers: find a machine for a job, book it, "
      "and prove what condition it was in — so neither side can lie about damage.", SUB),
    Spacer(1, 8),
    p("Sign in with these two accounts", H1),
    table([
        ["Role", "Email", "Password", "What they do on stage"],
        ["Owner", "abdullacyclewala@gmail.com", "12345678", "Lists machines, accepts the booking, records handover, files a claim"],
        ["Renter", "menhdi@gmail.com", "12345678", "Searches, books, countersigns, records the return, answers the claim"],
    ], [17 * mm, 54 * mm, 24 * mm, 81 * mm]),
    Spacer(1, 6),
    callout(
        "Already set up for you",
        "Booking <b>#53</b> is prepared and ready to walk through: <b>menhdi@gmail.com</b> renting "
        "<b>Mahindra 575 DI Tractor</b> (Abdulla) — status <i>Confirmed</i>, no condition report filed yet, "
        "so the handover you shoot on stage is the first real one. Abdulla is in owner mode; Mehndi is in renter mode. "
        "Both profiles already have a saved location, so the marketplace shows distances without a permission prompt.",
        SAGE),
    Spacer(1, 10),
    p("Links", H1),
    table([
        ["What", "Where"],
        ["The app", "https://agrirent-ai.vercel.app"],
        ["The prepared booking", "https://agrirent-ai.vercel.app/booking/53"],
        ["The new marketplace tab", "https://agrirent-ai.vercel.app/marketplace"],
        ["Backend health / AI status", "https://agrirent-ai-backend.onrender.com/verification/config"],
    ], [44 * mm, 132 * mm]),
    Spacer(1, 8),
    p("Five minutes before you start", H1),
    *bullets([
        "Run the readiness check (read-only, tells you the truth): "
        "<font face='Mono' size='8'>SUPABASE_URL=… ANON_KEY=… node scripts/check-demo-ready.mjs</font>",
        "Open the app once and log in as <b>both</b> accounts in two browser profiles — the free backend sleeps, and the "
        "first request after a nap takes 30–60 seconds. Waking it beforehand is the single biggest demo risk.",
        "Have the machine (or any object) ready to photograph, and allow the camera when the browser asks.",
    ]),
    Spacer(1, 6),
]

# ------------------------------------------------------------------- page 2
story += [
    p("The demo — 10 minutes, two people, one story", H1),
    p("Part 1 · The app a farmer actually uses (4 min)", H2),
    table([
        ["#", "Do this", "Say this / what to notice"],
        ["1", "Sign in as <b>menhdi@gmail.com</b>. Land on the Dashboard.",
              "“Everything starts from the farmer's side: what work do you have?”"],
        ["2", "Tap <b>Find Equipment</b> → type a job in plain language, e.g. “I need to plough 3 acres of wheat in Panvel next week”.",
              "The AI parser fills crop, operation, land size, place and date by itself — the farmer only checks it."],
        ["3", "Walk the review step and get results.",
              "A ranking model orders the matches and explains <i>why</i> each one fits. Hard rules (crop, operation, distance) filter first."],
        ["4", "Open <b>Marketplace</b> (new tab). Filter by type, price, distance; search “Panvel”.",
              "The other half of the product: browse what's nearby without answering a questionnaire. Distance comes from PostGIS and respects each owner's own service radius."],
        ["5", "Open a machine → book it for two days.",
              "Booking is a request; the owner accepts. Availability and double-booking are checked server-side."],
        ["6", "Switch to the <b>Abdulla</b> window, open the booking, press <b>Accept</b>.",
              "Realtime: the renter's page updates without a refresh. (Push notifications can be shown too if enabled.)"],
    ], [9.5 * mm, 72 * mm, 94.5 * mm]),
    Spacer(1, 8),
    p("Part 2 · The part that makes it trustworthy (6 min)", H2),
    p("This is the Phase 7 feature: a signed condition report at handover and at return, so "
      "“it was already damaged” stops being an argument.", SMALL),
    Spacer(1, 4),
    table([
        ["#", "Do this", "What to point at"],
        ["7", "As <b>Abdulla</b>, open booking #53 and press <b>Record condition before handover</b>.",
              "One card, one button — no menu. The deposit is shown as a single number."],
        ["8", "Shoot the four guided photos (whole machine ×2, hour meter, tyres/implement).",
              "Each photo is stamped inside the pixels with the report code, date, time and GPS — and fingerprinted twice. Turn the phone: it is four taps."],
        ["9", "Note any damage that is already there (chips, one tap), then submit.",
              "This is what protects the renter from being blamed for old damage — the machine gets a file, carried into every future rental."],
        ["10", "Read the <b>“What the app sees in these photos”</b> panel and sign.",
              "The AI reads the photos and reports damage with a confidence score. It never decides: <i>AI flags, a person decides</i>. The signature locks the record — nobody, including the owner, can change it afterwards."],
        ["11", "Switch to <b>Mehndi</b>: open the report, press <b>This is correct</b>.",
              "One tap. Two separate attestations are now on record — the renter is not signing the owner's word, they are confirming what they saw."],
        ["12", "As Mehndi, record the <b>return</b> condition the same way.",
              "The return report is compared view-by-view against the handover photos, side by side."],
        ["13", "Deliberate mistake (the best 40 seconds of the demo): use the gallery and re-submit the <b>handover photo</b> as the return.",
              "The report flags <i>“same image as an earlier photo”</i> and drops to <b>Not verified</b>. That is what stops a machine being “inspected” from a desk."],
        ["14", "As Abdulla, file a claim of <b>₹5,000</b> with no repair estimate, then attach a photographed bill.",
              "The database itself refuses a large claim without an estimate — the rule lives in Postgres, not just in the screen."],
        ["15", "As Mehndi, press <b>Dispute this</b>.",
              "Nothing is deducted while a claim is disputed: the disputed amount is <i>held</i>, the rest is released. AI never moves money."],
        ["16", "Log out, open <b>/verify/AR-XXXXXXXX</b> with the report code.",
              "The close: anyone — a bank, an insurer, a court — can check the report is intact, without an account and without seeing anyone's photos."],
    ], [9.5 * mm, 74.5 * mm, 92 * mm]),
]

# ------------------------------------------------------------------- page 3
story += [
    p("Test it yourself — the short checklist", H1),
    p("Each line is: what to do → what you should see. Anything else is a bug; tell me the report code and what happened.",
      SMALL),
    Spacer(1, 4),
    table([
        ["Area", "Do this", "Expect"],
        ["Accounts", "Sign in as both accounts with 12345678", "Both open; Abdulla sees owner tools, Mehndi sees the renter view"],
        ["Marketplace", "Open the Marketplace tab; change type/price/distance; search a village name", "Cards filter live; distance shown in km; count line updates; “Clear filters” resets"],
        ["Marketplace", "Press “Show what's near me” and allow location", "Distances refresh and are remembered on your profile"],
        ["Handover", "Booking #53 → Record condition before handover → 4 photos → submit", "Photos upload with progress; no typing required"],
        ["Capture quality", "Take one deliberately dark or blank photo", "“Retake suggested” appears — it advises, it never blocks"],
        ["Capture privacy", "Deny the location permission on one photo", "“No location — the rest still works”; the flow continues"],
        ["AI reading", "Look at the AI panel after uploading", "Summary + damage items with %; an hour-meter value if the digits are legible"],
        ["AI retry", "If it says “AI reading off”, press Re-run the check", "The reading appears using the photos already stored — nothing to retake"],
        ["Signature", "Sign with a finger, then reload the page", "Signature persists; the report is locked and cannot be edited"],
        ["Two parties", "Counterparty view: press “This is correct”", "One tap records their attestation; the report stops being marked “One-sided”"],
        ["Return", "Open the return report", "“Before and after, view by view” sliders appear when a handover exists"],
        ["Duplicate trap", "Submit the handover photo again as a return photo", "Flagged as the same image; verdict drops to Not verified"],
        ["Claim rule", "File ₹5,000 with no estimate attached", "Refused — the estimate photo is required from ₹2,000 up"],
        ["Deposit", "Dispute a claim", "₹0 deducted, disputed amount held; neither party can unilaterally take money"],
        ["Verification", "With/AR-XXXXXXXX logged out", "“This report is intact”, with entries, signers and fingerprint. A wrong code says “not found”"],
        ["Privacy", "As a third account, open the report URL", "Sees nothing — RLS keeps evidence to the two parties"],
        ["Languages", "Switch to " + DEVANAGARI + " on the report screen",
         "Every screen follows the switch — headings, dates, statuses, buttons, error messages. The AI's own reading follows it too: press <b>Re-run the check</b> and the summary and damage notes come back in that language (its internal codes stay English on purpose). Hindi/Marathi copy is machine-drafted — worth a native-speaker read)."],
    ], [26 * mm, 72 * mm, 78 * mm]),
]

# ------------------------------------------------------------------- page 4
story += [
    p("If something goes wrong on stage", H1),
    table([
        ["Symptom", "Do this"],
        ["A page spins for 30–60 seconds on the first click",
         "That is the free backend waking up. Say so — it is honest and it is fine. Keep clicking; the next request is instant."],
        ["“AI reading off — evidence still recorded”",
         "Press <b>Re-run the check</b> in that panel. If it still fails, continue: the evidence, signatures and verification all work without any AI — that is by design, and worth saying out loud."],
        ["The marketplace looks empty",
         "Widen the distance filter (50 → 100 km). An owner's own service radius also limits what appears — that is the rule, not a bug."],
        ["Camera does not open",
         "Use <b>Use my gallery</b>. The flow accepts a gallery photo and notes that it carries no camera metadata — a real, explainable behaviour."],
        ["A photo is blurry / the retake prompt keeps appearing",
         "Take it again with more light and both hands steady; the prompt is advice. You can also keep it — the report will carry a quality note rather than hide it."],
        ["Anything else", "Note the report code (AR-XXXXXXXX) or booking number, take a screenshot, carry on. Every state is recoverable and nothing is lost."],
    ], [54 * mm, 122 * mm]),
    Spacer(1, 8),
    p("Questions professors usually ask — the honest answers", H1),
    *bullets([
        "<b>“Can the AI be wrong?”</b> Yes, and it is built that way on purpose. The AI only <i>flags</i>; every flag is shown with its reason and a person decides. A wrong AI note costs a conversation, not a payment.",
        "<b>“What stops someone faking photos?”</b> No single check would. Five weak signals are combined instead: the exact-byte fingerprint, a perceptual image fingerprint (catches the same photo resized or re-compressed), GPS against the machine's registered location, the camera clock against the server's receipt time, and a watermark burned into the pixels. Faking all five is more work than telling the truth.",
        "<b>“Can the record be edited later?”</b> No. Evidence rows and the audit trail are append-only in the database (no update or delete policy exists), and each entry is chained to the previous one by a SHA-256 hash computed inside Postgres. The public page recomputes that chain — so tampering is detectable, not just forbidden.",
        "<b>“Who can see the photos?”</b> Only the two parties on that booking. The bucket is private, access is enforced by row-level security, and the public verification page shows no photos and no personal data.",
        "<b>“Does the AI decide who pays?”</b> Never. AI cannot set an amount, and while a claim is disputed nothing is deducted. Payment still happens between the two people; the app records the agreement and the policy version it was made under.",
        "<b>“What is not finished?”</b> Payment is still off-platform (deliberate — no payment gateway). There is no persistent offline queue yet: a failed upload retries in the page, but a reload while offline loses that capture. And the Hindi/Marathi copy for this feature is machine-drafted pending a native-speaker review.",
    ]),
    Spacer(1, 8),
    callout(
        "Scope, stated plainly",
        "Verified condition reports, the dispute and deposit flow, the public verification page and the marketplace are all "
        "live on the deployed app. The engineering is tested three ways: 39 logic assertions, 31 backend tests, 43 assertions "
        "run against the live database as real signed-in users, plus two live probes of the deployed AI path.",
        SAGE),
    Spacer(1, 6),
    p("Full detail: docs/PHASE7_MANUAL_TEST_PLAN.md (long-form test script) · "
      "docs/PHASE7_VERIFIED_CONDITION_REPORTS.md (design, deviations, limits) · "
      "AGRIRENT_AI_MASTER.md §0 (status of every phase).", SMALL),
]

doc.build(story)
print(f"wrote {OUT}")
