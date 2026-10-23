"""
AURORA random HAM-D audit: precision by number and timing of audit interviews
============================================================================
Random HAM-D interviews, scheduled at randomization independently of the
algorithm, estimate how often the AURORA severity algorithm misses clinically
significant change. At each audit day t, the reference is the most recent
scheduled HAM-D (day s in 0, 28, 56, 84).

  truth:     |theta(t) - theta(s)| >= DELTA       (latent HAM-D change)
  observed:  |HAMD(t) - HAMD(s)|   >= DELTA       (what raters will record)
  algorithm: |sm(t) - sm(s)|       >= DELTA       (smoothed AI-COA change)

  miss rate   = P(true change | algorithm negative)  = 1 - NPV
  sensitivity = P(algorithm positive | true change)

Latent trajectories and the AI-COA measurement model are copied from
Theoretical model/Simulation/aurora_detection_latency_sim.py so the two
simulations share assumptions. Seeded, reproducible.
"""

import argparse
import numpy as np

rng = np.random.default_rng(20261022)

# ---------------- trajectory + AI-COA model (from the latency simulation) ----
DAYS = 113
CLASS_P = [0.55, 0.25, 0.10, 0.10]          # responder, plateau, deteriorator, transient
BASE_MEAN, BASE_SD, BASE_MIN = 20.0, 3.0, 14.0
RESP_DELTA_MEAN, RESP_DELTA_SD, RESP_TAU = 9.0, 2.5, 35.0
DET_ONSET_LO, DET_ONSET_HI, DET_RISE, DET_RISE_DAYS = 14, 70, 6.0, 21
TRANS_DELTA, TRANS_SPIKE, TRANS_RISE, TRANS_HOLD, TRANS_FALL = 6.0, 5.0, 4, 7, 7
AR_RHO_DAY, AR_SD = 0.7, 1.8
COA_EVERY, COA_ADHERE, COA_SEM, COA_BIAS_SD, COA_AR = 2, 0.75, 2.34, 1.0, 0.3
EWMA_HALFLIFE = 5.0

# ---------------- audit design ------------------------------------------------
SCHEDULED = np.array([0, 28, 56, 84, 112])  # scheduled HAM-D days
BUFFER = 3                                   # no audit within 3 days of a scheduled HAM-D
FIRST_AUDIT_DAY = 7
RETAIN_16WK = 0.80                           # share still enrolled at day 112
AUDIT_COMPLETE = 0.85                        # completion of an audit while enrolled
t = np.arange(DAYS, dtype=float)


def simulate_theta(n):
    cls = rng.choice(4, size=n, p=CLASS_P)
    base = np.maximum(rng.normal(BASE_MEAN, BASE_SD, n), BASE_MIN)
    theta = np.tile(base[:, None], (1, DAYS))
    for i in range(n):
        c = cls[i]
        if c == 0:
            d = max(rng.normal(RESP_DELTA_MEAN, RESP_DELTA_SD), 3.0)
            theta[i] -= d * (1 - np.exp(-t / RESP_TAU))
        elif c == 1:
            theta[i] += rng.normal(0, 0.01) * t
        elif c == 2:
            o = rng.uniform(DET_ONSET_LO, DET_ONSET_HI)
            theta[i] += np.clip((t - o) / DET_RISE_DAYS, 0, 1) * DET_RISE
        else:
            theta[i] -= TRANS_DELTA * (1 - np.exp(-t / RESP_TAU))
            o = rng.uniform(14, 84)
            up = np.clip((t - o) / TRANS_RISE, 0, 1)
            down = np.clip((t - (o + TRANS_RISE + TRANS_HOLD)) / TRANS_FALL, 0, 1)
            theta[i] += TRANS_SPIKE * (up - down)
    e = np.zeros((n, DAYS))
    e[:, 0] = rng.normal(0, AR_SD, n)
    innov = AR_SD * np.sqrt(1 - AR_RHO_DAY ** 2)
    for k in range(1, DAYS):
        e[:, k] = AR_RHO_DAY * e[:, k - 1] + rng.normal(0, innov, n)
    return theta + e


def smoothed_coa(theta):
    """q2d AI-COA estimate with person bias, AR error, adherence, EWMA; carried to daily."""
    n = theta.shape[0]
    days = np.arange(0, DAYS, COA_EVERY)
    bias = rng.normal(0, COA_BIAS_SD, n)
    u = np.zeros((n, len(days)))
    u[:, 0] = rng.normal(0, COA_SEM, n)
    innov = COA_SEM * np.sqrt(1 - COA_AR ** 2)
    for k in range(1, len(days)):
        u[:, k] = COA_AR * u[:, k - 1] + rng.normal(0, innov, n)
    raw = theta[:, days] + bias[:, None] + u
    done = rng.random((n, len(days))) < COA_ADHERE
    done[:, 0] = True
    lam = np.log(2) / EWMA_HALFLIFE
    sm = np.zeros((n, len(days)))
    wsum = np.zeros(n); est = np.zeros(n); last = np.zeros(n)
    for k, d in enumerate(days):
        wsum = wsum * np.exp(-lam * (d - last)) if k else wsum
        c = done[:, k]
        est = np.where(c, (est * wsum + raw[:, k]) / (wsum + 1), est)
        wsum = np.where(c, wsum + 1, wsum)
        last = np.where(c, d, last)
        sm[:, k] = est
    return sm[:, np.minimum(np.arange(DAYS) // COA_EVERY, len(days) - 1)]


ELIGIBLE = np.array([d for d in range(FIRST_AUDIT_DAY, DAYS - 1)
                     if np.min(np.abs(SCHEDULED - d)) > BUFFER])


def audit_days(n, k, design):
    """k audit days per participant, fixed at randomization."""
    if design == "stratified":       # one uniform draw in each of k equal strata
        strata = np.array_split(ELIGIBLE, k)
        return np.column_stack([rng.choice(s, n) for s in strata])
    out = np.empty((n, k), int)       # simple random, without replacement
    for i in range(n):
        out[i] = np.sort(rng.choice(ELIGIBLE, k, replace=False))
    return out


def one_trial(n, k, design, delta, rater_sem):
    theta = simulate_theta(n)
    sm = smoothed_coa(theta)
    hamd_err = lambda size: rng.normal(0, rater_sem, size)
    days = audit_days(n, k, design)
    hazard = -np.log(RETAIN_16WK) / 112
    dropout = rng.exponential(1 / hazard, n)
    rows = np.repeat(np.arange(n), k)
    d = days.ravel()
    keep = (d < dropout[rows]) & (rng.random(d.size) < AUDIT_COMPLETE)
    rows, d = rows[keep], d[keep]
    s = SCHEDULED[np.searchsorted(SCHEDULED, d, side="right") - 1]
    true_chg = np.abs(theta[rows, d] - theta[rows, s]) >= delta
    obs_chg = np.abs((theta[rows, d] + hamd_err(d.size)) -
                     (theta[rows, s] + hamd_err(d.size))) >= delta
    alg_pos = np.abs(sm[rows, d] - sm[rows, s]) >= delta
    neg = ~alg_pos
    return dict(
        audits=d.size,
        events_true=true_chg.sum(),
        miss_true=true_chg[neg].mean(),
        miss_obs=obs_chg[neg].mean(),
        sens_true=alg_pos[true_chg].mean(),
        sens_obs=alg_pos[obs_chg].mean(),
        ids=rows, neg=neg, obs_chg=obs_chg,
    )


def summarize(n, k, design, delta, rater_sem, reps):
    res = [one_trial(n, k, design, delta, rater_sem) for _ in range(reps)]
    g = lambda key: np.array([r[key] for r in res], float)
    return dict(
        audits=g("audits").mean(), events=g("events_true").mean(),
        miss_true=g("miss_true").mean(), miss_obs=g("miss_obs").mean(),
        miss_hw=1.96 * g("miss_obs").std(ddof=1),
        sens_true=g("sens_true").mean(), sens_obs=g("sens_obs").mean(),
        sens_hw=1.96 * g("sens_obs").std(ddof=1),
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=200)
    ap.add_argument("--n", type=int, nargs="+", default=[700, 100])
    ap.add_argument("--delta", type=float, nargs="+", default=[3.0, 5.0])
    ap.add_argument("--rater-sem", type=float, nargs="+", default=[2.5, 1.5])
    args = ap.parse_args()
    hdr = ("n_app k design      delta raterSEM | audits events | "
           "miss: true  obs   +/-  | sens: true  obs   +/-")
    print(hdr); print("-" * len(hdr))
    for n in args.n:
        for delta in args.delta:
            for sem in args.rater_sem:
                for k in (1, 2, 3, 4):
                    for design in ("stratified", "random"):
                        if k == 1 and design == "random":
                            continue
                        r = summarize(n, k, design, delta, sem, args.reps)
                        print(f"{n:5d} {k} {design:11s} {delta:4.0f} {sem:6.1f}   | "
                              f"{r['audits']:6.0f} {r['events']:6.0f} | "
                              f"{r['miss_true']:.3f} {r['miss_obs']:.3f} {r['miss_hw']:.3f} | "
                              f"{r['sens_true']:.3f} {r['sens_obs']:.3f} {r['sens_hw']:.3f}",
                              flush=True)
