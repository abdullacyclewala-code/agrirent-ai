# Phase 7 — manual test plan (30–40 minutes, two people)

> Written against the UI as it actually ships, not against the spec. Every step
> says what to do, what you should see, and what would count as a bug.
>
> **What this plan cannot cover:** everything automated is already verified —
> 39 logic assertions, 31 backend tests, 43 assertions against the live database,
> and two live probes of the deployed AI path (results in
> `docs/PHASE7_VERIFIED_CONDITION_REPORTS.md` §9.4–9.5). What is *not* verified is
> anything that needs eyes and a thumb: camera permissions, layout on a real
> phone, whether the copy makes sense to a farmer, and whether the flow feels
> like "four taps" or like paperwork.

---

## 0. Before you start

**You need two accounts, on two devices (or two browser profiles):**

| Role | Who signs in | What they do |
|---|---|---|
| Owner | your main account | lists the tractor, records handover, files any claim |
| Renter | a second account | books it, countersigns, records the return, answers a claim |

Email confirmation is **ON** for this project, so a brand-new signup cannot log in
without clicking the emailed link (and the mailer is rate-limited to 2 emails an
hour). Use two accounts you already have, or ask me to create two pre-confirmed
test accounts — I can hand you the credentials in a minute.

**Have ready:** a real machine (or any object) to photograph, a phone with a
camera, and 10 minutes of patience for the first request (Render's free tier
sleeps; the first call after idle takes 30–60 seconds).

**One URL worth opening in a tab now**, because it tells you whether the AI half
of this feature is awake on your deployment:

```
https://agrirent-ai-backend.onrender.com/verification/config
```

Expect `"providers_configured": ["gemini","groq"]`, `"storage_access": true`.
If `providers_configured` is empty, the flow still works — it just reports
"AI reading off — evidence still recorded".

---

## 1. The happy path: handover → return → deposit released (≈20 min)

This is the core promise. Do it once, properly, on a phone.

### 1.1 Set the rental up (2 min)

| Do this | Expect |
|---|---|
| As **renter**, book the machine from `/equipment/:id` (pick dates, request) | booking appears in `/bookings` as **Requested** |
| As **owner**, open the booking, press **Accept** | status **Confirmed** |
| Look at the booking page for a card titled **"Condition & deposit"** | state badge (e.g. *Condition photos due*), a deposit figure in ₹, two rows: *Handover report* / *Return report*, both "Not filed yet", and **one** button: **Record condition before handover** |
| Press **Mark In Use** (owner) after handover | the renter's card now says "The owner records the machine's condition at handover" |

**Bug if:** the card is missing, shows more than one primary button, or the
deposit figure is outside ₹500–₹5000.

### 1.2 Record the condition at handover (5 min — the important part)

Press **Record condition before handover** and walk the four slots.

| Do this | Expect |
|---|---|
| Allow the camera prompt | a live camera view with a shutter, not a file dialog |
| Shoot **Whole machine — front left** (step back, whole machine in frame) | thumbnail fills in, the slot is ticked |
| Shoot **Whole machine — rear right**, **Hour meter**, **Tyres & implement** | 4/4, the primary button becomes **Submit report** |
| For the **hour meter**, get the digits big and readable | (later you'll check whether the app read the number) |
| Tap one damage chip under *"Damage that is already there?"* — e.g. **Scratch** | chip highlights; this is what protects the renter later |
| Press **Submit report** | "Uploading 1 of 4…" then the report page opens |

**Things to judge on the phone here (this is the real UX test):**

- Did holding the phone and shooting four photos feel like a minute, or like a chore?
- Did any photo come back with **"Retake suggested"**? Shoot one deliberately
  dark or blank — the retake prompt *should* appear. It is advice, not a block.
- Deny the location permission on one photo: you should get "No location — the
  rest still works", never a dead end.
- Try **Use my gallery** instead of the camera and pick a screenshot. It should
  accept it, and the report should later carry a *no camera information* note.

### 1.3 Read the AI section (2 min — the "advanced tech" part)

On the report page, above the evidence grid:

| Expect | What it means |
|---|---|
| A section **"What the app sees in these photos"** with a chip like *AI reading on · gemini* | the real model answered |
| A one-line summary + any damage it noticed, each with a % | e.g. "body panel rust, 78%" |
| **Hour meter** value, if the digits were readable | the model read the dial |
| A line "AI notes are only a reading of the photos — a person decides, never the model." | the design promise, stated where it matters |

**If instead you see "AI reading off — evidence still recorded":** press
**Re-run the check** (a small button in that section, drafts only). That is the
cold-start retry; nothing has to be re-photographed.

**Bug if:** the summary claims damage that is obviously not in the photo, or
invents an hour-meter number. That is the one failure mode this feature cannot
tolerate — tell me immediately with a screenshot and the report code.

### 1.4 Sign, and hand the machine over (3 min)

| Do this | Expect |
|---|---|
| Scroll to **Sign this report** | the statement sentence is shown above the pad, with the report code in it |
| Sign with a finger, press **Sign and file this report** | "You have signed this report. It is now locked — nobody, including you, can change it." |
| Reload the page | the signature is still there, the pad is gone, no Re-run button |
| Open **Report integrity** | the report code (AR-XXXXXXXX), a fingerprint, "Record intact — N entries, none altered" |
| As **renter**, open the same booking | the card says *Review & sign the report*; the report shows **This is correct** / **Something is wrong** |
| As renter, press **This is correct** | one tap: both attestations now listed, and the booking card **stops saying "One-sided"** |

**Bug if:** "One-sided" survives both signatures (that was a real bug, fixed —
worth confirming), or the renter is asked to draw a signature before answering.

### 1.5 Return, and release the deposit (5 min)

| Do this | Expect |
|---|---|
| As **owner**, mark **Completed** (or keep In Use) | the card offers **Record condition at return** |
| As **renter**, record the return: same four slots, at the machine | note: the *"Damage that is already there?"* chips are **gone** on a return report — only handover asks that question |
| Submit, then open the report | a **Before and after, view by view** section: a slider per slot, handover on one side, return on the other |
| Sign the return report | locked as before |
| As **owner**, look at the card | **Report damage** and **No damage — release deposit** |
| Press **No damage — release deposit** | deposit recorded as fully released, booking shows *Closed — no claim* |

**Also test the honest-failure path here (5 min, worth it):** start a *return*
report and, instead of shooting the machine, use **Use my gallery** and pick the
**exact same photo you submitted at handover**. Expect the report to carry
*"This looks like the same image as an earlier photo in this booking"* (or
"already used in a different booking of this machine"), and the verdict to drop
to **Not verified**. That flag is the whole reason a rented machine can't be
"inspected" from a desk.

---

## 2. The dispute path (10 min)

Use a fresh rental — the deposit must still be unreleased.

| Do this | Expect |
|---|---|
| As **owner** at return: **Report damage** | form appears with amount, parts, severity, description |
| Enter **₹5,000**, pick parts, write a sentence, do **not** attach an estimate | the form refuses: "a claim of ₹2,000 or more needs the estimate on record" (the database enforces this too, not just the screen) |
| Tap the estimate field, photograph a repair bill, submit | claim filed, with the deadline shown to the renter |
| As **renter**, open the claim | you see the amount, the description, **the attached estimate** as a viewable link |
| Press **Dispute this** | claim goes to **Disputed**; the deposit shows **₹0 deducted** and the disputed amount **held** |
| Check both accounts' cards | renter sees "Resolve the dispute"; owner sees the same, and "Nothing is deducted while this is disputed" |

**Bug if:** any amount is deducted while disputed, or the settle amount is
recorded without the renter's action.

---

## 3. Verify it from the outside, as a stranger would (3 min)

This is the part that makes the record worth something to a bank, an insurer or
a court — check it in a **private/incognito window, logged out**.

| Do this | Expect |
|---|---|
| Copy the report code from the report page, open `/verify/AR-XXXXXXXX` | a page with no login: **"This report is intact"**, how many entries, who signed and when, the fingerprint |
| On the report page, look for the line "Anyone can verify this report at …/verify/AR-…" | it prints too — press **Print / save as PDF** and check the code and URL are on the paper |
| Open `/verify/AR-WRONGCODE` | **"No report found with this code"** — never a false "verified" |
| Still logged out, try to open an evidence photo URL directly | refused — photos are private to the two parties, and the verification page shows none of them |
| Log in as a **third account** that is not on the booking, open the report URL | you should see nothing: no photos, no report, no claim |

---

## 4. Things that should *not* break (5 min)

| Try this | Expect |
|---|---|
| Start a report, upload two photos, close the tab, reopen the booking | "You started a condition report — finish and sign it"; the two photos are still there |
| Turn mobile data off mid-capture and submit | "Upload failed. Your photos are still on this phone — tap retry." **Known limit:** reloading the page *while still offline* loses them — there is no persistent offline queue yet (stated in the docs; ask if you want it built). |
| Switch to **हिंदी** / **मराठी** and walk the flow | every new screen translated — read the flag sentences and the two damage lists critically, they are the words people will argue over |
| Open the machine's public page after the rental | a **Condition record for this machine** section appears, and any damage recorded is listed as *known damage* — which can never be charged to the next renter |

---

## 5. What to send me if something fails

Enough for me to query the exact rows:

1. **Report code** (`AR-XXXXXXXX`) or the **booking id** from the URL.
2. What you did, what you expected, what you saw.
3. A screenshot (especially for anything AI-related).
4. Phone + browser (e.g. "Android 14, Chrome" / "iPhone, Safari").

With the code I can read that report's rows — photos, hashes, flags, signatures,
chain — and tell you whether the fault is the UI, the backend, the AI, or the
data.

---

## 6. Not testable by hand (and why)

| Thing | Why |
|---|---|
| The 24-hour claim window closing | it takes 24 hours of real time. The "no claim → release" path is testable immediately (step 1.5); the *expired* window is not. Say the word and I will back-date a test report's timestamp by 25 hours so you can see that state. |
| Account/data deletion across the audit trail | the record is append-only on purpose, so deleting requires the documented SQL purge (migration 7b). Not a UI action. |
| Missing standard views (`missing_required_slots`) | the capture screen requires all four slots, and photos cannot be deleted afterwards — unreachable by design, which is the point. |
| Two photos that differ by a resize only | the perceptual-hash duplicate check is covered by the automated fixtures (Hamming distance 0 after re-compression); a human cannot produce that by eye. |
