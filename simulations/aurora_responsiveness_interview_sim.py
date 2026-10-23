"""
AURORA responsiveness interviews: triggered HAM-Ds, timing, and site load
=========================================================================
Aim 2.2 promises clinician ratings of AURORA-detected severity shifts "within
24 hours, as well as at random." aurora_random_hamd_audit_sim.py sizes the
random interviews. This script adds the triggered ones, which estimate PPV:

  trigger:    |sm(t) - sm(r)| >= DELTA, where r is the day of the last HAM-D
              (scheduled or triggered) and sm is the smoothed AI-COA estimate
  interview:  day t + DELAY, if the participant is still enrolled and does it
  confirmed:  the HAM-D has moved >= DELTA since day r, in the trigger's
              direction (true = latent change; observed = with rater error)

Rules: no trigger before day 7; none whose interview would fall within 3 days
of a scheduled HAM-D or after it (that HAM-D confirms instead); at most one
triggered interview per four-week interval, so a missed one is not re-requested.

It also re-runs the random audits (k = 2) on the same draws, so the two kinds
of interview can be compared, and with --recall 7 lets the HAM-D measure the
past week rather than the interview day. Finally it prints site rater load and
cost. The trajectory and AI-COA models are imported from
aurora_random_hamd_audit_sim, so the simulations share assumptions. Seeded,
reproducible.
"""

import argparse
import json
import os
import subprocess
from pathlib import Path

import numpy as np
import aurora_random_hamd_audit_sim as base

DAYS, SCHEDULED, BUFFER = base.DAYS, base.SCHEDULED, base.BUFFER
SCHEDULED_SET = set(SCHEDULED.tolist())
FIRST_TRIGGER_DAY = 7
TRIGGER_COMPLETE = 0.85        # same as the random audits; short notice may lower it
CAP_PER_INTERVAL = 1           # triggered interviews per four-week interval
K_AUDIT = 2                    # random audits per participant, for comparison
MCID = 3.0                     # looser confirmation: a true change of >= 3 in the flagged direction

# ---------------- site load and cost inputs ----------------------------------
def load_budget():
    """Budget figures from the calculator's budget module, so the app and this script
    share one source. Uses src/budget.local.js (gitignored, the application budget's
    internal figures) when it exists and AURORA_PUBLIC_BUILD is unset, otherwise the
    public placeholders in src/budget.example.js. Needs Node on the PATH."""
    src = ROOT / "src" / "budget.local.js"
    if not src.exists() or os.environ.get("AURORA_PUBLIC_BUILD"):
        src = ROOT / "src" / "budget.example.js"
    js = (f"const m = await import({json.dumps(src.as_uri())});"
          "console.log(JSON.stringify(m));")
    out = subprocess.run(["node", "--input-type=module", "-e", js],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


ROOT = Path(__file__).resolve().parent.parent
BUDGET = load_budget()
RATER_RATE, PATIENT_RATE = BUDGET["RATER_RATE"], BUDGET["PATIENT_RATE"]
SITE_COSTING = BUDGET["SITE_COSTING"]   # per-site factor relative to US rates
RATER_H = 40 / 60              # GRID-HAM-D 15-30 min, plus scheduling and notes
EXTRA_RATER_H = 25 / 60        # each additional rater scoring the recording
PATIENT_H = 45 / 60            # GenAI check-in + PHQ-9 + GRID-HAM-D
SCHED_IE_H = (140 + 255) / 2 / 60  # scheduled IE interview time per patient (burden table)
SITES = [  # eTable 1 of the design memo; names match the power calculator's sites.js
    ("Peru (CITBM)", 140), ("Paraguay (UNA)", 140), ("Indonesia (UB)", 140),
    ("Bolivia (unifranz)", 140), ("MGH", 110), ("BCM", 110), ("Spain (la paz)", 70),
    ("Colombia (unisabana)", 70), ("Colombia (u rosario)", 70),
    ("UK (NHS london)", 70), ("UK (Avon and Wilt)", 70)]
APP_SHARE = 0.70               # 40/30/30: the algorithm runs in both app arms
ENROLL_WEEKS = 35              # protocol §7 table, July 2027 - February 2028


def past_week(theta, days):
    """Mean latent severity over the last `days` days, which is what a HAM-D
    with a one-week recall window measures. days=1 is the interview day."""
    if days <= 1:
        return theta
    c = np.cumsum(np.pad(theta, ((0, 0), (1, 0))), axis=1)
    hi = np.arange(1, theta.shape[1] + 1)
    lo = np.maximum(hi - days, 0)
    return (c[:, hi] - c[:, lo]) / (hi - lo)


def triggered(theta_h, sm, dropout, delta, delay, rng):
    """One trial of triggered interviews; returns counts and per-interview records."""
    n = theta_h.shape[0]
    idx = np.arange(n)
    ref = np.zeros(n, int)               # day of the last HAM-D
    z_ref = rng.normal(size=n)           # its standardized rater error
    due = np.full(n, -1)                 # day a triggered interview is due
    trig_day = np.zeros(n, int)
    sign = np.zeros(n)
    used = np.zeros(n, int)              # triggered interviews this interval
    fired = np.zeros(n, int)             # requests per participant
    rec = {k: [] for k in ("true", "true_at_trigger", "zdiff", "sign", "fired_day")}
    for t in range(1, DAYS):
        on = t < dropout
        if t in SCHEDULED_SET:           # scheduled HAM-D: new reference, new interval
            ref[:] = t
            z_ref = rng.normal(size=n)
            due[:] = -1
            used[:] = 0
            continue
        day = t + delay
        same_interval = (np.searchsorted(SCHEDULED, t, side="right")
                         == np.searchsorted(SCHEDULED, day, side="right"))
        if (t >= FIRST_TRIGGER_DAY and day < DAYS - 1 and same_interval
                and np.min(np.abs(SCHEDULED - day)) > BUFFER):
            chg = sm[:, t] - sm[idx, ref]
            fire = on & (due < 0) & (used < CAP_PER_INTERVAL) & (np.abs(chg) >= delta)
            due[fire] = day
            trig_day[fire] = t
            sign[fire] = np.sign(chg[fire])
            used += fire
            fired += fire
            rec["fired_day"].append(np.full(fire.sum(), t))
        d = due == t
        if d.any():
            done = d & on & (rng.random(n) < TRIGGER_COMPLETE)
            z_new = rng.normal(size=n)
            ii = idx[done]
            rec["true"].append(theta_h[ii, t] - theta_h[ii, ref[ii]])
            rec["true_at_trigger"].append(theta_h[ii, trig_day[ii]] - theta_h[ii, ref[ii]])
            rec["zdiff"].append(z_new[ii] - z_ref[ii])
            rec["sign"].append(sign[ii])
            ref[done] = t
            z_ref = np.where(done, z_new, z_ref)
            due[d] = -1
    rec = {k: np.concatenate(v) if v else np.zeros(0) for k, v in rec.items()}
    return fired, rec


def random_audits(theta_h, sm, dropout, k, delta, sems, rng):
    """Random audits as in aurora_random_hamd_audit_sim, with theta_h as the truth."""
    n = theta_h.shape[0]
    days = base.audit_days(n, k, "stratified")
    rows = np.repeat(np.arange(n), k)
    d = days.ravel()
    enrolled = d < dropout[rows]
    keep = enrolled & (rng.random(d.size) < base.AUDIT_COMPLETE)
    req_pt = np.bincount(rows[enrolled], minlength=n)
    rows, d = rows[keep], d[keep]
    s = SCHEDULED[np.searchsorted(SCHEDULED, d, side="right") - 1]
    true = theta_h[rows, d] - theta_h[rows, s]
    zdiff = rng.normal(size=d.size) - rng.normal(size=d.size)
    pos = np.abs(sm[rows, d] - sm[rows, s]) >= delta
    out = dict(req_pt=req_pt, requested=enrolled.sum() / n, completed=keep.sum() / n,
               neg_share=(~pos).mean(),
               miss_true=(np.abs(true[~pos]) >= delta).mean(),
               sens_true=pos[np.abs(true) >= delta].mean())
    for sem in sems:
        obs = np.abs(true + sem * zdiff) >= delta
        out[f"miss_{sem}"] = obs[~pos].mean()
        out[f"sens_{sem}"] = pos[obs].mean()
    return out


def summarize_trig(fired, rec, n, delta, sems):
    s = rec["sign"]
    out = dict(fired=fired.mean(), completed=s.size / n,
               mean_trigger_day=rec["fired_day"].mean(),
               worse=(s > 0).mean(),
               ppv_trigger=(s * rec["true_at_trigger"] >= delta).mean(),
               ppv_true=(s * rec["true"] >= delta).mean(),
               ppv_mcid=(s * rec["true"] >= MCID).mean())
    for sem in sems:
        obs = s * (rec["true"] + sem * rec["zdiff"])
        out[f"ppv_{sem}"] = (obs >= delta).mean()
        out[f"ppv_mcid_{sem}"] = (obs >= MCID).mean()
    return out


def run(n, reps, deltas, delays, sems, recall, seed):
    rng = np.random.default_rng(seed)
    base.rng = rng                       # the imported model draws from the same stream
    hazard = -np.log(base.RETAIN_16WK) / 112
    trig = {(dl, dy): [] for dl in deltas for dy in delays}
    aud = {dl: [] for dl in deltas}
    for _ in range(reps):
        theta = base.simulate_theta(n)
        sm = base.smoothed_coa(theta)
        theta_h = past_week(theta, recall)
        dropout = rng.exponential(1 / hazard, n)
        for dl in deltas:
            a = random_audits(theta_h, sm, dropout, K_AUDIT, dl, sems, rng)
            aud[dl].append(a)
            for dy in delays:
                fired, rec = triggered(theta_h, sm, dropout, dl, dy, rng)
                r = summarize_trig(fired, rec, n, dl, sems)
                # extra interviews requested per participant: random + triggered
                r["extra_hist"] = np.bincount(a["req_pt"] + fired,
                                              minlength=K_AUDIT + 5)[:K_AUDIT + 5] / n
                trig[(dl, dy)].append(r)
    return trig, aud


def presets(n, reps, deltas, sems, seed):
    """The inputs the power calculator's Aim 2.2 panel takes from this simulation, for a
    next-day interview, as JSON. Run without dropout, so trigger requests are per
    participant on study for all 16 weeks; the calculator applies its own attrition.
    For each threshold: trigger requests, the share of completed audits the algorithm
    scores negative, and true and observed miss rate and PPV (>= 3 points) under both
    HAM-D models."""
    import json
    saved = base.RETAIN_16WK
    base.RETAIN_16WK = 1 - 1e-12                     # no dropout
    out = {"source": f"aurora_responsiveness_interview_sim.py --presets "
                     f"(n = {n}, {reps} reps, seed {seed}, next-day interview)"}
    for recall, label in ((1, "sameDay"), (7, "pastWeek")):
        rng = np.random.default_rng(seed)
        base.rng = rng
        for _ in range(reps):
            theta = base.simulate_theta(n)
            sm = base.smoothed_coa(theta)
            theta_h = past_week(theta, recall)
            dropout = np.full(n, np.inf)
            for dl in deltas:
                key = str(int(dl))
                cell = out.setdefault(key, {"acc": []})
                a = random_audits(theta_h, sm, dropout, K_AUDIT, dl, sems, rng)
                fired, rec = triggered(theta_h, sm, dropout, dl, 1, rng)
                t = summarize_trig(fired, rec, n, dl, sems)
                cell["acc"].append((label, a, t))
    for key in [str(int(d)) for d in deltas]:
        cell = out[key]
        rows = cell.pop("acc")
        avg = lambda lab, src, k: float(np.mean([(r[1] if src == "a" else r[2])[k]
                                                 for r in rows if r[0] == lab]))
        # Requests and the negative share depend only on the algorithm, not on what the
        # HAM-D measures, so they are the same under both models; report the first.
        cell["triggerRequests"] = round(avg("sameDay", "t", "fired"), 3)
        # Triggers cluster early in follow-up, so dropout removes fewer of them than of
        # the evenly spread audits. The calculator discounts by survival to this day.
        cell["meanTriggerDay"] = round(avg("sameDay", "t", "mean_trigger_day"), 1)
        cell["negativeShare"] = round(float(np.mean(
            [r[1]["neg_share"] for r in rows if r[0] == "sameDay"])), 3)
        for label in ("sameDay", "pastWeek"):
            cell[label] = {
                "missTrue": round(avg(label, "a", "miss_true"), 3),
                "missObserved": {str(s): round(avg(label, "a", f"miss_{s}"), 3) for s in sems},
                "ppvTrue": round(avg(label, "t", "ppv_mcid"), 3),
                "ppvObserved": {str(s): round(avg(label, "t", f"ppv_mcid_{s}"), 3) for s in sems},
            }
    base.RETAIN_16WK = saved
    print(json.dumps(out, indent=2))


def slot_loss(per_week, slot_days, window, weeks=4000, seed=1):
    """Share of triggered interviews that find no reserved slot within `window`
    working days after the trigger, with one slot on each weekday in
    `slot_days` (0 = Monday). Poisson arrivals, earliest deadline served first."""
    rng = np.random.default_rng(seed)
    arrivals = rng.poisson(per_week / 5, weeks * 5)
    queue, lost = [], 0                  # deadlines of waiting triggers, in order
    for day, new in enumerate(arrivals):
        while queue and queue[0] < day:
            queue.pop(0)
            lost += 1
        if day % 5 in slot_days and queue:
            queue.pop(0)
        queue.extend([day + window] * new)
    return lost / arrivals.sum()


def mean_hw(rows, key):
    v = np.array([r[key] for r in rows], float)
    return np.nanmean(v), 1.96 * np.nanstd(v, ddof=1)


def print_tables(trig, aud, deltas, delays, sems, n):
    print("PPV: confirmed when the change since the last HAM-D is >= delta in the flagged")
    print("direction ('same'), or >= 3 points, the MCID, in the flagged direction ('>=3').")
    print("worse = share of triggers flagging deterioration.\n")
    hdr = ("delta delay | fired/pt done/pt worse | true PPV: same, at trigger  same  >=3")
    print(hdr)
    print("-" * len(hdr))
    for dl in deltas:
        for dy in delays:
            r = trig[(dl, dy)]
            print(f"{dl:5.0f} {dy:5d} | {mean_hw(r, 'fired')[0]:8.2f} "
                  f"{mean_hw(r, 'completed')[0]:7.2f} {mean_hw(r, 'worse')[0]:5.2f} | "
                  f"{mean_hw(r, 'ppv_trigger')[0]:24.3f} {mean_hw(r, 'ppv_true')[0]:5.3f} "
                  f"{mean_hw(r, 'ppv_mcid')[0]:5.3f}")
    print()
    print("Observed PPV, with rater error on both HAM-Ds (mean, 95% half-width across trials)")
    hdr = ("delta delay | " + " | ".join(f"SEM {s}: same  +/-    >=3  +/-" for s in sems))
    print(hdr)
    print("-" * len(hdr))
    for dl in deltas:
        for dy in delays:
            r = trig[(dl, dy)]
            cells = []
            for s in sems:
                m1, h1 = mean_hw(r, f"ppv_{s}")
                m2, h2 = mean_hw(r, f"ppv_mcid_{s}")
                cells.append(f"{m1:14.3f} {h1:.3f}  {m2:.3f} {h2:.3f}")
            print(f"{dl:5.0f} {dy:5d} | " + " | ".join(cells))
    print()
    print(f"Random audits, k = {K_AUDIT}, same draws (n = {n})")
    hdr = ("delta | requested/pt done/pt | miss true " + " ".join(f"obs{s}" for s in sems)
           + " | sens true " + " ".join(f"obs{s}" for s in sems))
    print(hdr)
    print("-" * len(hdr))
    for dl in deltas:
        r = aud[dl]
        print(f"{dl:5.0f} | {mean_hw(r, 'requested')[0]:12.2f} {mean_hw(r, 'completed')[0]:7.2f} | "
              f"{mean_hw(r, 'miss_true')[0]:9.3f} "
              + " ".join(f"{mean_hw(r, f'miss_{s}')[0]:6.3f}" for s in sems)
              + f" | {mean_hw(r, 'sens_true')[0]:9.3f} "
              + " ".join(f"{mean_hw(r, f'sens_{s}')[0]:6.3f}" for s in sems))


def print_load(trig, aud, delta, delay):
    """Peak weekly interviews and total cost per site, for k = 0-4 random audits."""
    t = trig[(delta, delay)]
    a = aud[delta]
    trig_req, trig_done = mean_hw(t, "fired")[0], mean_hw(t, "completed")[0]
    aud_req = mean_hw(a, "requested")[0] / K_AUDIT     # per scheduled audit
    aud_done = mean_hw(a, "completed")[0] / K_AUDIT
    per_interview = RATER_H * RATER_RATE + PATIENT_H * PATIENT_RATE
    per_extra_rater = EXTRA_RATER_H * RATER_RATE
    print(f"Site load at delta = {delta:.0f}, delay = {delay} day(s): "
          f"{trig_req:.2f} triggered requests and {trig_done:.2f} completed per app user; "
          f"a scheduled audit is requested {aud_req:.2f} and completed {aud_done:.2f} of the time.")
    print(f"Budget figures: {BUDGET['BUDGET_SOURCE']}.")
    print(f"Cost per completed interview at US rates: ${per_interview:.2f} "
          f"(+${per_extra_rater:.2f} for each extra rater scoring the recording).")
    print(f"Peak load assumes even enrollment over {ENROLL_WEEKS} weeks.\n")
    hist = np.mean([r["extra_hist"] for r in t], axis=0)
    print(f"Extra interviews requested per app user, k = {K_AUDIT} random + triggered: "
          + ", ".join(f"{j}: {p:.0%}" for j, p in enumerate(hist) if p >= 0.005))
    print()
    print("Triggered interviews that find no reserved slot within the window, at peak load")
    patterns = {"daily": (0, 1, 2, 3, 4), "Mon/Wed/Fri": (0, 2, 4), "Tue/Thu": (1, 3)}
    print(f"  {'site size':>9s} {'per wk':>6s} {'slots':>12s} "
          + " ".join(f"{w}-day window" for w in (1, 2, 3)))
    for npts in (140, 110, 70):
        per_wk = APP_SHARE * npts * trig_req / ENROLL_WEEKS
        for label, days in patterns.items():
            print(f"  {npts:9d} {per_wk:6.1f} {label:>12s} "
                  + " ".join(f"{slot_loss(per_wk, days, w):12.1%}" for w in (1, 2, 3)))
    print()
    for k in (0, 1, 2, 3, 4):
        req = k * aud_req + trig_req
        done = k * aud_done + trig_done
        print(f"k = {k} random audits per participant: {req:.2f} interviews requested and "
              f"{done:.2f} completed per app user")
        print(f"  {'site':26s} {'app users':>9s} {'per wk':>7s} {'rater h/wk':>10s} "
              f"{'sched IE h/wk':>13s} {'cost, 1 rater':>14s} {'3 raters':>10s}")
        tot = np.zeros(3)
        for name, npts in SITES:
            app = APP_SHARE * npts
            per_wk = app * req / ENROLL_WEEKS
            sched_h = npts * SCHED_IE_H / ENROLL_WEEKS
            f = SITE_COSTING.get(name, {}).get("factor", 1.0)
            c1 = app * done * per_interview * f
            c3 = app * done * (per_interview + 2 * per_extra_rater) * f
            tot += (app * done, c1, c3)
            print(f"  {name:26s} {app:9.0f} {per_wk:7.1f} {per_wk * RATER_H:10.1f} "
                  f"{sched_h:13.1f} {c1:14,.0f} {c3:10,.0f}")
        print(f"  {'total':26s} {'':9s} {'':7s} {'':10s} {'':13s} {tot[1]:14,.0f} {tot[2]:10,.0f}"
              f"   ({tot[0]:,.0f} completed interviews)\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=200)
    ap.add_argument("--n", type=int, default=700)
    ap.add_argument("--delta", type=float, nargs="+", default=[3.0, 4.0, 5.0, 7.0])
    ap.add_argument("--delay", type=int, nargs="+", default=[0, 1, 2, 3, 7])
    ap.add_argument("--rater-sem", type=float, nargs="+", default=[2.5, 1.5])
    ap.add_argument("--recall", type=int, default=1,
                    help="days the HAM-D averages over (1 = interview day, 7 = past week)")
    ap.add_argument("--load-delta", type=float, default=5.0)
    ap.add_argument("--load-delay", type=int, default=1)
    ap.add_argument("--seed", type=int, default=20261022)
    ap.add_argument("--presets", action="store_true",
                    help="print the power calculator's Aim 2.2 presets as JSON and exit")
    args = ap.parse_args()
    if args.presets:
        presets(args.n, args.reps, args.delta, args.rater_sem, args.seed)
        raise SystemExit
    trig, aud = run(args.n, args.reps, args.delta, args.delay, args.rater_sem,
                    args.recall, args.seed)
    print(f"Triggered interviews: n = {args.n} app users, {args.reps} reps, "
          f"HAM-D recall = {args.recall} day(s)\n")
    print_tables(trig, aud, args.delta, args.delay, args.rater_sem, args.n)
    if args.load_delta in args.delta and args.load_delay in args.delay:
        print()
        print_load(trig, aud, args.load_delta, args.load_delay)
