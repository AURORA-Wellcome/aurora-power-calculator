// Generates the R script shown in the "R Code for Verification" panel and executed by
// WebR. One generator feeds both so they cannot drift apart.
//
// Base R only: WebR ships without mvtnorm, so Dunnett's critical value is computed here
// with integrate() + uniroot(). That is an independent implementation of the same integral
// used in calc.js, which makes agreement between the R output and the on-screen numbers a
// real cross-check rather than a tautology.

export function buildRCode(s) {
  const threeArm = s.designArms === 3;
  const totalN = s.nClinicians * s.patientsPerCluster;

  const weights = threeArm
    ? `c(${s.allocA}, ${s.allocB}, ${s.allocC})`
    : `c(${s.treatmentRatio}, 1)`;
  const armNames = threeArm
    ? `c("A_clin_pt", "B_pt_only", "C_control")`
    : `c("A_treatment", "C_control")`;
  const contrasts = threeArm
    ? `list(
  list(id = "A vs C", a = 1, b = 3, family = "dunnett"),
  list(id = "B vs C", a = 2, b = 3, family = "dunnett"),
  list(id = "A vs B", a = 1, b = 2, family = "exploratory"),
  list(id = "A+B vs C", pooled = c(1, 2), b = 3, family = "pooled")
)`
    : `list(
  list(id = "Tx vs Ctrl", a = 1, b = 2, family = "single")
)`;
  const iccArms = threeArm ? "c(1, 2)" : "c(1)";
  const hybrid = threeArm && s.randomization === "hybrid";
  // clusterGroup: which randomization unit each arm's patients sit in.
  const clusterGroups = threeArm
    ? hybrid
      ? "c(1, 2, 2)"
      : "c(1, 2, 3)"
    : "c(1, 2)";

  return `# AURORA Trial Power Calculations
# Reproduces the minimum detectable effect (MDE) calculations from the calculator.
# Base R only - no packages required.

# ============================================
# Design
# ============================================

design_arms         <- ${s.designArms}
arm_names           <- ${armNames}
arm_weights         <- ${weights}
randomization       <- "${threeArm ? s.randomization : "cluster"}"
# Which randomization unit each arm sits in. Under hybrid, arms B and C share the
# no-ROM clinicians, which makes B vs C a within-clinician contrast.
cluster_group       <- ${clusterGroups}
total_n             <- ${totalN}
patients_per_cluster <- ${s.patientsPerCluster}
cluster_size_cv     <- ${s.clusterSizeCV}
control_attrition   <- ${s.controlAttrition}

# Statistical parameters
power        <- ${s.power}
alpha        <- ${s.alpha}          # per-outcome alpha; also sets the CI level (1 - alpha)
analysis_framing <- "${s.analysisFraming}"   # "exploratory" = no efficacy claim, no adjustment
multiplicity <- "${threeArm ? s.multiplicity : "none"}"   # arm-level adjustment, applied on top
small_sample_t <- ${s.smallSampleT ? "TRUE" : "FALSE"}
z_beta       <- qnorm(power)

# HAM-D outcome parameters
icc_hamd    <- ${s.iccHamd}
r2_hamd     <- ${s.r2Hamd}
sigma_hamd  <- 7

# Retention outcome parameters
icc_retention       <- ${s.iccRetention}
r2_retention        <- ${s.r2Retention}
survival_efficiency <- ${s.survivalEfficiency}

# Measurement model
measurement_model     <- "${s.measurementModel}"
sum_score_reliability <- ${s.sumScoreReliability}
rasch_reliability     <- ${s.raschReliability}
rater_variance_prop   <- ${s.raterVarianceProp}

# ICC substudy parameters
target_icc       <- ${s.targetIcc}
expected_icc     <- ${s.expectedIcc}
icc_cluster_corr <- ${s.iccClusterCorr}
n_followups      <- ${s.nFollowups}
icc_arms         <- ${iccArms}   # arms contributing AURORA-vs-clinician rating pairs

# Fairness / DIF substudy parameters
dif_subgroup_share <- ${s.difSubgroupShare}   # smallest subgroup as a share of AURORA users
dif_threshold_n    <- ${s.difThresholdN}    # minimum N per group for a DIF analysis
dif_target_logits  <- ${s.difTargetLogits}  # DIF magnitude to detect (0.43 ~ 1.0 ETS delta)
dif_item_info      <- ${s.difItemInfo}   # item information at the targeted ability

contrasts <- ${contrasts}

# ============================================
# Dunnett's two-sided critical value (base R)
# ============================================
# k active arms of size n_i share a control of size n_0. The test statistics are
# correlated through that shared control, with rho_ij = lambda_i * lambda_j where
# lambda_i = sqrt(n_i / (n_i + n_0)). The product form collapses the joint probability
# to a single integral over the control's sampling error.

dunnett_prob <- function(cv, lambdas) {
  integrand <- function(y) {
    dens <- dnorm(y)
    for (lam in lambdas) {
      sd_i <- sqrt(1 - lam^2)
      dens <- dens * (pnorm((cv + lam * y) / sd_i) - pnorm((-cv + lam * y) / sd_i))
    }
    dens
  }
  integrate(integrand, -8, 8, rel.tol = 1e-10)$value
}

dunnett_crit <- function(lambdas, alpha) {
  if (length(lambdas) <= 1) return(qnorm(1 - alpha / 2))
  uniroot(function(cv) dunnett_prob(cv, lambdas) - (1 - alpha),
          c(0.5, 8), tol = 1e-10)$root
}

# ============================================
# Cluster apportionment (largest remainder)
# ============================================
# Guarantees the per-arm cluster counts sum exactly to the total: 100 clinicians
# across 1:1:1 is 34/33/33, not three rounded 33.3s. Ties favour the earlier arm.

allocate_clusters <- function(total, weights) {
  exact  <- total * weights / sum(weights)
  counts <- floor(exact)
  remaining <- total - sum(counts)
  if (remaining > 0) {
    fracs <- exact - counts
    ord <- order(-fracs, seq_along(fracs))
    for (k in seq_len(remaining)) counts[ord[k]] <- counts[ord[k]] + 1
  }
  counts
}

# Clinicians are apportioned across randomization UNITS, not arms: [ROM, no-ROM] under
# hybrid, one per arm under cluster randomization.
n_groups      <- max(cluster_group)
group_weights <- sapply(seq_len(n_groups), function(g) sum(arm_weights[cluster_group == g]))

allocation <- function(total_n) {
  n_clusters     <- round(total_n / patients_per_cluster)
  group_clusters <- allocate_clusters(n_clusters, group_weights)

  # Share of a unit's panel belonging to each arm: 1 for a cluster-randomized arm,
  # b/(b+c) or c/(b+c) for the two patient-level arms inside a no-ROM clinician.
  share_in_group   <- arm_weights / group_weights[cluster_group]
  arm_cluster_size <- share_in_group * patients_per_cluster

  clusters   <- group_clusters[cluster_group]
  randomized <- clusters * arm_cluster_size

  list(n_clusters = n_clusters,
       group_clusters = group_clusters,
       clusters = clusters,
       randomized = randomized,
       completers = randomized * (1 - control_attrition),
       arm_cluster_size = arm_cluster_size)
}

# Variance for a POOLED contrast, in variance-component form. The pooled arm can straddle
# both randomization units under hybrid, and arms sharing clinicians are correlated - the
# cross terms below are what a naive "merge the arms" calculation would miss.
pooled_factor <- function(alloc, contrast, icc, field) {
  idx <- contrast$pooled
  ref <- contrast$b
  ns  <- alloc[[field]][idx]
  w   <- ns / sum(ns)
  cv_adj <- 1 + cluster_size_cv^2

  between <- 1 / alloc$clusters[ref]
  within  <- 1 / alloc[[field]][ref]
  for (k in seq_along(idx)) {
    i <- idx[k]
    between <- between + w[k]^2 / alloc$clusters[i]
    within  <- within  + w[k]^2 / alloc[[field]][i]
    if (cluster_group[i] == cluster_group[ref])
      between <- between - 2 * w[k] / alloc$clusters[i]
  }
  if (length(idx) > 1) {
    for (a in 1:(length(idx) - 1)) for (b in (a + 1):length(idx)) {
      if (cluster_group[idx[a]] == cluster_group[idx[b]])
        between <- between + 2 * w[a] * w[b] / alloc$clusters[idx[a]]
    }
  }
  icc * cv_adj * between + (1 - icc) * within
}

# Design-effect-weighted sum of inverse sample sizes for a contrast. A within-clinician
# contrast drops the between-clinician variance entirely, hence (1 - ICC).
contrast_factor <- function(alloc, contrast, icc, field) {
  if (!is.null(contrast$pooled)) return(pooled_factor(alloc, contrast, icc, field))
  i <- contrast$a; j <- contrast$b
  n1 <- alloc[[field]][i]; n2 <- alloc[[field]][j]
  attrition <- if (field == "completers") 1 - control_attrition else 1

  if (cluster_group[i] == cluster_group[j]) {
    return((1 - icc) * (1 / n1 + 1 / n2))
  }
  cv_adj <- 1 + cluster_size_cv^2
  de <- function(m) (1 + (m * attrition - 1) * icc) * cv_adj
  de(alloc$arm_cluster_size[i]) / n1 + de(alloc$arm_cluster_size[j]) / n2
}

# Clinician counts for a set of arms, counting each randomization unit once.
group_clusters_for <- function(arm_idx) {
  g <- unique(cluster_group[arm_idx])
  allocation(total_n)$group_clusters[g]
}

# ============================================
# Critical values
# ============================================

n_arms      <- length(arm_weights)
control_w   <- arm_weights[n_arms]
active_lams <- sqrt(arm_weights[-n_arms] / (arm_weights[-n_arms] + control_w))

z_unadjusted <- qnorm(1 - alpha / 2)
n_pairwise   <- sum(sapply(contrasts, function(c) c$family != "pooled"))
z_bonferroni <- qnorm(1 - alpha / (2 * n_pairwise))
z_dunnett    <- if (n_arms == 2) z_unadjusted else dunnett_crit(active_lams, alpha)

# Cornish-Fisher t quantile, matching the calculator's small-sample option.
t_quantile <- function(p, df) {
  z <- qnorm(p)
  z + (z^3 + z) / (4 * df) +
      (5 * z^5 + 16 * z^3 + 3 * z) / (96 * df^2) +
      (3 * z^7 + 19 * z^5 + 17 * z^3 - 15 * z) / (384 * df^3)
}

crit_for <- function(contrast, total_n) {
  if (analysis_framing == "exploratory") {
    # No confirmatory claim, so no family-wise error rate to protect.
    z <- z_unadjusted; method <- "exploratory, unadjusted"
  } else if (n_arms == 2 || multiplicity == "none") {
    z <- z_unadjusted; method <- if (n_arms == 2) "unadjusted" else "none"
  } else if (multiplicity == "bonferroni") {
    z <- z_bonferroni; method <- paste0("Bonferroni (m=", n_pairwise, ")")
  } else if (contrast$family == "dunnett") {
    z <- z_dunnett;    method <- paste0("Dunnett (k=", length(active_lams), ")")
  } else {
    # A vs B shares no control arm, so it sits outside the Dunnett family and is
    # reported unadjusted and flagged exploratory.
    z <- z_unadjusted; method <- "exploratory, unadjusted"
  }
  if (small_sample_t) {
    df <- round(total_n / patients_per_cluster) - n_arms
    if (df > 2) {
      z <- t_quantile(pnorm(z), df)
      method <- paste0(method, ", t(", df, ")")
    }
  }
  list(z = z, method = method)
}

# ============================================
# Measurement model variance multiplier
# ============================================

use_rasch <- measurement_model %in% c("rasch", "mfrm")
use_mfrm  <- measurement_model == "mfrm"
meas_mult <- 1
if (use_rasch) {
  sum_err  <- 1 - sum_score_reliability
  rasch_err <- 1 - rasch_reliability
  meas_mult <- meas_mult * (1 - ((sum_err - rasch_err) / sum_err) * sum_err)
}
if (use_mfrm) meas_mult <- meas_mult * (1 - rater_variance_prop)

# ============================================
# HAM-D MDE
# ============================================

calc_hamd_mde <- function(total_n, contrast) {
  alloc <- allocation(total_n)
  n1 <- if (is.null(contrast$pooled)) alloc$completers[contrast$a] else sum(alloc$completers[contrast$pooled])
  n2 <- alloc$completers[contrast$b]

  sigma2_adj <- sigma_hamd^2 * (1 - r2_hamd)
  ipcw_vif <- 1.2                 # inverse probability of censoring weights
  rm_gain  <- 1.43                # repeated measures efficiency, 4 timepoints, r ~ 0.5

  base_variance <- (sigma2_adj * ipcw_vif) / rm_gain
  net_variance  <- base_variance * meas_mult

  cr <- crit_for(contrast, total_n)
  inv_n <- contrast_factor(alloc, contrast, icc_hamd, "completers")
  se <- sqrt(net_variance * inv_n)

  list(mde = (cr$z + z_beta) * se,
       ci_half_width = cr$z * se,
       baseline_mde = (cr$z + z_beta) * sqrt(base_variance * inv_n),
       effect_size = (cr$z + z_beta) * se / sigma_hamd,
       crit = cr$z, method = cr$method,
       n_clusters = alloc$n_clusters,
       clusters = alloc$clusters,
       n_completers = round(sum(alloc$completers)))
}

# ============================================
# Retention MDE
# ============================================

calc_retention_mde <- function(total_n, contrast) {
  alloc <- allocation(total_n)

  p0 <- control_attrition

  inv_n        <- contrast_factor(alloc, contrast, icc_retention, "randomized")
  clustered_se <- sqrt(p0 * (1 - p0) * inv_n)
  adjusted_se  <- clustered_se * sqrt(1 - r2_retention)
  survival_se  <- adjusted_se / sqrt(survival_efficiency)

  cr <- crit_for(contrast, total_n)
  mde <- (cr$z + z_beta) * survival_se

  list(mde_pp = mde * 100,
       ci_half_width_pp = cr$z * survival_se * 100,
       control_rate = p0 * 100,
       treatment_rate = (p0 - mde) * 100,
       binary_mde_pp = (cr$z + z_beta) * adjusted_se * 100)
}

# ============================================
# ICC substudy precision
# ============================================

calc_icc_validation <- function(total_n) {
  alloc <- allocation(total_n)
  n_patients <- sum(alloc$completers[icc_arms])
  # Dedupe by randomization unit: under hybrid two contributing arms can share clinicians.
  n_clusters_icc <- sum(group_clusters_for(icc_arms))

  n_observations <- n_patients * n_followups
  avg_obs_per_cluster <- n_observations / n_clusters_icc
  design_effect <- 1 + (avg_obs_per_cluster - 1) * icc_cluster_corr
  n_effective <- n_observations / design_effect

  se_icc <- (1 - expected_icc^2) * sqrt(2 / (n_effective - 1))
  ci_half_width <- 1.96 * se_icc

  list(n_observations = round(n_observations),
       ci_half_width = ci_half_width,
       lower_bound = expected_icc - ci_half_width,
       upper_bound = expected_icc + ci_half_width,
       can_rule_out_poor = (expected_icc - ci_half_width) > target_icc)
}

# ============================================
# Fairness / DIF substudy
# ============================================
# Only AURORA users produce item responses, so this draws on the same arms as the
# agreement substudy. It uses RANDOMIZED counts, not completers: DIF is assessed on
# baseline item responses, which everyone randomized provides.

calc_dif <- function(total_n) {
  alloc <- allocation(total_n)
  n_users <- sum(alloc$randomized[icc_arms])
  n_clusters_used <- sum(group_clusters_for(icc_arms))

  # Round once and take the remainder so the two counts always sum to n_users.
  n_focal <- max(1, min(n_users - 1, round(n_users * dif_subgroup_share)))
  n_reference <- n_users - n_focal

  # Var(b_hat) ~ 1/(n * I) for an item carrying information I; I = 0.25 (a well-targeted
  # dichotomous item) recovers the familiar SE(b) ~ 2/sqrt(n).
  # The design effect uses the randomized cluster size, matching the sample being used.
  users_per_cluster <- n_users / n_clusters_used
  design_effect <- (1 + (users_per_cluster - 1) * icc_hamd) * (1 + cluster_size_cv^2)
  se_raw <- sqrt(1 / (n_focal * dif_item_info) + 1 / (n_reference * dif_item_info))
  se <- se_raw * sqrt(design_effect)

  # A measurement question, not an arm comparison: no arm-level multiplicity applies.
  z <- z_unadjusted
  if (small_sample_t) {
    df <- round(total_n / patients_per_cluster) - n_arms
    if (df > 2) z <- t_quantile(pnorm(z), df)
  }

  list(n_users = n_users,
       n_focal = n_focal,
       n_reference = n_reference,
       adequate = n_focal >= dif_threshold_n,
       design_effect = design_effect,
       se = se,
       crit = z,
       ci_half_width = z * se,
       mde = (z + z_beta) * se,
       power = pnorm(abs(dif_target_logits) / se - z),
       n_required = ceiling((dif_threshold_n / dif_subgroup_share) * (total_n / n_users)))
}

# ============================================
# Results
# ============================================

alloc <- allocation(total_n)
cat(paste0("Design: ", design_arms, "-arm, ", randomization, " randomization, ",
           analysis_framing, ", N = ", total_n, "\\n"))
cat(paste0("  Clusters: ", alloc$n_clusters, " (",
           paste(paste0(arm_names, "=", alloc$clusters), collapse = ", "), ")\\n"))
cat(paste0("  Critical values: unadjusted ", round(z_unadjusted, 4),
           ", Dunnett ", round(z_dunnett, 4),
           ", Bonferroni ", round(z_bonferroni, 4), "\\n\\n"))

for (ct in contrasts) {
  h <- calc_hamd_mde(total_n, ct)
  r <- calc_retention_mde(total_n, ct)
  within <- is.null(ct$pooled) && cluster_group[ct$a] == cluster_group[ct$b]
  cat(paste0(ct$id, "  [", h$method, ", crit = ", round(h$crit, 4),
             ifelse(within, ", within-clinician", ""), "]\\n"))
  cat(paste0("  HAM-D:     +/-", round(h$ci_half_width, 3), " points (",
             round((1 - alpha) * 100), "% CI)   MDE ", round(h$mde, 3),
             "  (d = ", round(h$effect_size, 3), ")\\n"))
  cat(paste0("  Retention: +/-", round(r$ci_half_width_pp, 2), " pp        MDE ",
             round(r$mde_pp, 2), " pp  (", round(r$treatment_rate, 1), "% vs ",
             round(r$control_rate, 1), "%)\\n"))
}

icc <- calc_icc_validation(total_n)
cat(paste0("\\nICC substudy (arms ", paste(arm_names[icc_arms], collapse = " + "), ")\\n"))
cat(paste0("  Observations:  ", icc$n_observations, "\\n"))
cat(paste0("  95% CI:        ", round(icc$lower_bound, 3), " - ", round(icc$upper_bound, 3), "\\n"))
cat(paste0("  CI half-width: +/-", round(icc$ci_half_width, 4), "\\n"))
cat(paste0("  Rules out ICC < ", target_icc, ": ",
           ifelse(icc$can_rule_out_poor, "Yes", "No"), "\\n"))
cat(paste0("  Completers:    ", calc_hamd_mde(total_n, contrasts[[1]])$n_completers,
           " after ", round(control_attrition * 100), "% attrition\\n"))

dif <- calc_dif(total_n)
cat(paste0("\\nFairness / DIF substudy (arms ", paste(arm_names[icc_arms], collapse = " + "), ")\\n"))
cat(paste0("  AURORA users:  ", dif$n_users, " randomized\\n"))
cat(paste0("  Subgroups:     ", dif$n_focal, " focal vs ", dif$n_reference,
           " reference (", round(dif_subgroup_share * 100), "% split)\\n"))
cat(paste0("  Meets ", dif_threshold_n, "/group: ", ifelse(dif$adequate, "Yes", "No"),
           ifelse(dif$adequate, "", paste0(" (needs about N=", dif$n_required, ")")), "\\n"))
cat(paste0("  DIF precision: +/-", round(dif$ci_half_width, 3), " logits (",
           round((1 - alpha) * 100), "% CI)\\n"))
cat(paste0("  Detectable:    ", round(dif$mde, 3), " logits at ", round(power * 100), "% power\\n"))
cat(paste0("  Power at ", dif_target_logits, ": ", round(dif$power * 100), "%\\n"))
`;
}
