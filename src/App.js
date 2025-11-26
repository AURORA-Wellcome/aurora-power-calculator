import React, { useState, useMemo, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Area,
  ComposedChart,
} from "recharts";

const STORAGE_KEY = "aurora-power-calculator-settings";

const defaults = {
  power: 0.8,
  alpha: 0.025,
  iccHamd: 0.04,
  iccRetention: 0.05,
  r2Hamd: 0.35,
  r2Retention: 0.05,
  patientsPerCluster: 10,
  nClinicians: 100,
  clusterSizeCV: 0,
  controlAttrition: 0.3,
  treatmentRatio: 3,
  measurementModel: "sum",
  sumScoreReliability: 0.86,
  raschReliability: 0.91,
  raterVarianceProp: 0.07,
  targetIcc: 0.75,
  expectedIcc: 0.8,
  iccClusterCorr: 0.03,
  nFollowups: 4,
  survivalEfficiency: 4.0,
};

function loadSettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return { ...defaults, ...JSON.parse(saved) };
    }
  } catch (e) {
    // Ignore errors
  }
  return defaults;
}

export default function PowerCurves() {
  const initial = loadSettings();

  const [power, setPower] = useState(initial.power);
  const [alpha, setAlpha] = useState(initial.alpha);
  const [iccHamd, setIccHamd] = useState(initial.iccHamd);
  const [iccRetention, setIccRetention] = useState(initial.iccRetention);
  const [r2Hamd, setR2Hamd] = useState(initial.r2Hamd);
  const [r2Retention, setR2Retention] = useState(initial.r2Retention);
  const [patientsPerCluster, setPatientsPerCluster] = useState(
    initial.patientsPerCluster,
  );
  const [nClinicians, setNClinicians] = useState(initial.nClinicians || 100);
  const [clusterSizeCV, setClusterSizeCV] = useState(initial.clusterSizeCV);
  const [controlAttrition, setControlAttrition] = useState(
    initial.controlAttrition,
  );
  const [treatmentRatio, setTreatmentRatio] = useState(initial.treatmentRatio);

  // Measurement model: "sum" | "rasch" | "mfrm"
  const [measurementModel, setMeasurementModel] = useState(
    initial.measurementModel,
  );
  const useRasch = measurementModel === "rasch" || measurementModel === "mfrm";
  const useMFRM = measurementModel === "mfrm";
  const [sumScoreReliability, setSumScoreReliability] = useState(
    initial.sumScoreReliability,
  );
  const [raschReliability, setRaschReliability] = useState(
    initial.raschReliability,
  );
  const [raterVarianceProp, setRaterVarianceProp] = useState(
    initial.raterVarianceProp,
  );

  // ICC validation parameters (treatment arm only)
  const [targetIcc, setTargetIcc] = useState(initial.targetIcc);
  const [expectedIcc, setExpectedIcc] = useState(initial.expectedIcc);
  const [iccClusterCorr, setIccClusterCorr] = useState(initial.iccClusterCorr);
  const [nFollowups, setNFollowups] = useState(initial.nFollowups);

  // Survival efficiency
  const [survivalEfficiency, setSurvivalEfficiency] = useState(
    initial.survivalEfficiency,
  );

  // R code section visibility
  const [showRCode, setShowRCode] = useState(false);

  // WebR state
  const [webRStatus, setWebRStatus] = useState("idle"); // idle, loading, ready, running, error
  const [webROutput, setWebROutput] = useState("");
  const [webRInstance, setWebRInstance] = useState(null);

  // Load and run R code in browser using WebR
  const runRCode = async (rCode) => {
    if (webRStatus === "running") return;

    try {
      let webR = webRInstance;

      if (!webR) {
        setWebRStatus("loading");
        setWebROutput("Downloading R runtime (~25MB, first time only)...");

        // Dynamically import WebR
        const { WebR } = await import(
          "https://webr.r-wasm.org/latest/webr.mjs"
        );
        webR = new WebR();
        await webR.init();
        setWebRInstance(webR);
        setWebRStatus("ready");
      }

      setWebRStatus("running");
      setWebROutput("Running R code...");

      // Capture output
      const result = await webR.evalRString(`
        capture.output({
          ${rCode}
        }, type = "output")
      `);

      // Parse the result - it comes as a string with escaped newlines
      const output = result.replace(/\\n/g, "\n");
      setWebROutput(output);
      setWebRStatus("ready");
    } catch (error) {
      setWebRStatus("error");
      setWebROutput(`Error: ${error.message}`);
    }
  };

  // Save settings to localStorage whenever they change
  useEffect(() => {
    const settings = {
      power,
      alpha,
      iccHamd,
      iccRetention,
      r2Hamd,
      r2Retention,
      patientsPerCluster,
      nClinicians,
      clusterSizeCV,
      controlAttrition,
      treatmentRatio,
      measurementModel,
      sumScoreReliability,
      raschReliability,
      raterVarianceProp,
      targetIcc,
      expectedIcc,
      iccClusterCorr,
      nFollowups,
      survivalEfficiency,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      // Ignore errors
    }
  }, [
    power,
    alpha,
    iccHamd,
    iccRetention,
    r2Hamd,
    r2Retention,
    patientsPerCluster,
    nClinicians,
    clusterSizeCV,
    controlAttrition,
    treatmentRatio,
    measurementModel,
    sumScoreReliability,
    raschReliability,
    raterVarianceProp,
    targetIcc,
    expectedIcc,
    iccClusterCorr,
    nFollowups,
    survivalEfficiency,
  ]);

  // Z-scores
  const zAlpha = useMemo(() => {
    // Two-tailed z for alpha
    const z = {
      0.05: 1.96,
      0.025: 2.24,
      0.01: 2.58,
    };
    return z[alpha] || 2.24;
  }, [alpha]);

  const zBeta = useMemo(() => {
    const z = {
      0.7: 0.524,
      0.75: 0.674,
      0.8: 0.842,
      0.85: 1.036,
      0.9: 1.282,
    };
    return z[power] || 0.842;
  }, [power]);

  // Calculate measurement model variance adjustment
  const measurementVarianceMultiplier = useMemo(() => {
    // Baseline: sum score with its error variance
    // Error variance = (1 - reliability) * total variance

    let multiplier = 1.0;

    if (useRasch) {
      // Rasch reduces error variance
      // Relative error: (1 - raschRel) / (1 - sumScoreRel)
      const sumScoreError = 1 - sumScoreReliability;
      const raschError = 1 - raschReliability;
      const errorReduction = (sumScoreError - raschError) / sumScoreError;

      // This removes errorReduction proportion of the error variance
      // Error is (1-rel) of total, so net reduction = errorReduction * (1-sumScoreRel)
      multiplier *= 1 - errorReduction * sumScoreError;
    }

    if (useMFRM) {
      // MFRM removes rater variance entirely
      multiplier *= 1 - raterVarianceProp;
    }

    return multiplier;
  }, [
    useRasch,
    useMFRM,
    sumScoreReliability,
    raschReliability,
    raterVarianceProp,
  ]);

  // Calculate MDE for HAM-D given total N
  const calcHamdMDE = (totalN) => {
    const nClusters = Math.round(totalN / patientsPerCluster);
    const treatmentProportion = treatmentRatio / (treatmentRatio + 1);
    const nTreatmentClusters = Math.round(nClusters * treatmentProportion);
    const nControlClusters = nClusters - nTreatmentClusters;

    // Patients after 30% attrition
    const nTreatmentPatients =
      nTreatmentClusters * patientsPerCluster * (1 - controlAttrition);
    const nControlPatients =
      nControlClusters * patientsPerCluster * (1 - controlAttrition);

    // Harmonic mean of completers
    const nHarmonic =
      (2 * nTreatmentPatients * nControlPatients) /
      (nTreatmentPatients + nControlPatients);

    // Variance calculations
    const sigma2 = 49; // SD = 7
    const sigma2Adj = sigma2 * (1 - r2Hamd);

    // Design effect for clustering (adjusted for unequal cluster sizes)
    const clusterSize = patientsPerCluster * (1 - controlAttrition); // after attrition
    const designEffect =
      (1 + (clusterSize - 1) * iccHamd) * (1 + clusterSizeCV * clusterSizeCV);

    // Inverse Probability of Censoring Weights variance inflation
    const ipcwVIF = 1.2;

    // Repeated measures efficiency (4 timepoints, correlation ~0.5)
    const repeatedMeasuresGain = 1.43;

    // Net variance (before measurement model adjustment)
    const baseVariance =
      (sigma2Adj * designEffect * ipcwVIF) / repeatedMeasuresGain;

    // Apply measurement model variance reduction
    const netVariance = baseVariance * measurementVarianceMultiplier;

    // Also calculate baseline (no Rasch/MFRM) for comparison
    const baselineMDE =
      (zAlpha + zBeta) * Math.sqrt((2 * baseVariance) / nHarmonic);

    // MDE with measurement model
    const mde = (zAlpha + zBeta) * Math.sqrt((2 * netVariance) / nHarmonic);

    return {
      mde: mde,
      baselineMDE: baselineMDE,
      effectSize: mde / 7, // Cohen's d
      nClusters: nClusters,
      nTreatmentClusters: nTreatmentClusters,
      nControlClusters: nControlClusters,
      nCompleters: Math.round(nTreatmentPatients + nControlPatients),
      varianceReduction: (1 - measurementVarianceMultiplier) * 100,
    };
  };

  // Calculate MDE for retention given total N
  const calcRetentionMDE = (totalN) => {
    const nClusters = Math.round(totalN / patientsPerCluster);
    const treatmentProportion = treatmentRatio / (treatmentRatio + 1);
    const nTreatmentClusters = Math.round(nClusters * treatmentProportion);
    const nControlClusters = nClusters - nTreatmentClusters;

    const nTreatment = nTreatmentClusters * patientsPerCluster;
    const nControl = nControlClusters * patientsPerCluster;

    // Design effect for clustering (adjusted for unequal cluster sizes)
    const designEffect =
      (1 + (patientsPerCluster - 1) * iccRetention) *
      (1 + clusterSizeCV * clusterSizeCV);

    const p0 = controlAttrition;

    // Step 1: Base SE for proportion difference
    const baseSE = Math.sqrt(p0 * (1 - p0) * (1 / nTreatment + 1 / nControl));

    // Step 2: Clustering inflates variance
    const clusteredSE = baseSE * Math.sqrt(designEffect);

    // Step 3: Covariate adjustment reduces variance
    const adjustedSE = clusteredSE * Math.sqrt(1 - r2Retention);

    // Step 4: Survival analysis efficiency gain (vs binary endpoint)
    // Range: 2x (conservative) to 5x (optimistic with continuous monitoring)
    const survivalSE = adjustedSE / Math.sqrt(survivalEfficiency);

    const mde = (zAlpha + zBeta) * survivalSE;

    return {
      mde: mde * 100, // percentage points
      controlRate: p0 * 100,
      treatmentRate: (p0 - mde) * 100,
      nClusters: nClusters,
      binaryMDE: (zAlpha + zBeta) * adjustedSE * 100, // for comparison
    };
  };

  // Calculate ICC validation precision (treatment arm only)
  // Tests whether AI-clinician agreement exceeds threshold for good reliability (ICC>0.75)
  const calcIccValidation = (totalN) => {
    const nClusters = Math.round(totalN / patientsPerCluster);
    const treatmentProportion = treatmentRatio / (treatmentRatio + 1);
    const nTreatmentClusters = Math.round(nClusters * treatmentProportion);

    // Treatment arm patients after attrition
    const nTreatmentPatients =
      nTreatmentClusters * patientsPerCluster * (1 - controlAttrition);

    // Total observations = patients × follow-up assessments
    const nObservations = nTreatmentPatients * nFollowups;

    // Design effect for clustering in ICC estimation
    const avgObsPerCluster = nObservations / nTreatmentClusters;
    const designEffect = 1 + (avgObsPerCluster - 1) * iccClusterCorr;

    // Effective sample size
    const nEffective = nObservations / designEffect;

    // Standard error of ICC estimate using Fisher's z transformation
    // SE(z) ≈ 1/sqrt(n-3), then convert back to ICC scale
    // For ICC, SE ≈ (1-ICC²) * sqrt(2/(n-1)) approximately
    const seIcc =
      (1 - expectedIcc * expectedIcc) * Math.sqrt(2 / (nEffective - 1));

    // 95% CI half-width
    const ciHalfWidth = 1.96 * seIcc;

    // Lower bound of 95% CI
    const lowerBound = expectedIcc - ciHalfWidth;

    // Can we rule out ICC < 0.75?
    const canRuleOutPoor = lowerBound > targetIcc;

    return {
      nTreatmentPatients: Math.round(nTreatmentPatients),
      nTreatmentClusters: nTreatmentClusters,
      nObservations: Math.round(nObservations),
      nEffective: Math.round(nEffective),
      seIcc: seIcc,
      ciHalfWidth: ciHalfWidth,
      lowerBound: lowerBound,
      upperBound: expectedIcc + ciHalfWidth,
      canRuleOutPoor: canRuleOutPoor,
    };
  };

  // Generate data for curves
  const powerData = useMemo(() => {
    const data = [];
    for (let n = 400; n <= 1300; n += 50) {
      const hamd = calcHamdMDE(n);
      const retention = calcRetentionMDE(n);
      const iccVal = calcIccValidation(n);
      data.push({
        n: n,
        clusters: hamd.nClusters,
        hamdMDE: hamd.mde,
        hamdBaselineMDE: hamd.baselineMDE,
        hamdD: hamd.effectSize,
        retentionMDE: retention.mde,
        retentionTreatment: retention.treatmentRate,
        iccCiWidth: iccVal.ciHalfWidth * 2, // full CI width
        iccLowerBound: iccVal.lowerBound,
      });
    }
    return data;
  }, [
    power,
    alpha,
    iccHamd,
    iccRetention,
    r2Hamd,
    r2Retention,
    patientsPerCluster,
    nClinicians,
    clusterSizeCV,
    controlAttrition,
    treatmentRatio,
    survivalEfficiency,
    measurementVarianceMultiplier,
    zAlpha,
    zBeta,
    expectedIcc,
    iccClusterCorr,
    nFollowups,
  ]);

  // Current design values
  const currentN = nClinicians * patientsPerCluster;
  const currentHamd = calcHamdMDE(currentN);
  const currentRetention = calcRetentionMDE(currentN);
  const currentIcc = calcIccValidation(currentN);

  // R code for WebR execution (without template literal escaping issues)
  const rCodeForExecution = `
total_n <- ${currentN}
patients_per_cluster <- ${patientsPerCluster}
cluster_size_cv <- ${clusterSizeCV}
treatment_ratio <- ${treatmentRatio}
control_attrition <- ${controlAttrition}
power <- ${power}
alpha <- ${alpha}
z_alpha <- qnorm(1 - alpha)
z_beta <- qnorm(power)
icc_hamd <- ${iccHamd}
r2_hamd <- ${r2Hamd}
sigma_hamd <- 7
icc_retention <- ${iccRetention}
r2_retention <- ${r2Retention}
survival_efficiency <- ${survivalEfficiency}

calc_hamd_mde <- function(total_n) {
  n_clusters <- round(total_n / patients_per_cluster)
  treatment_prop <- treatment_ratio / (treatment_ratio + 1)
  n_treatment_clusters <- round(n_clusters * treatment_prop)
  n_control_clusters <- n_clusters - n_treatment_clusters
  n_treatment <- n_treatment_clusters * patients_per_cluster * (1 - control_attrition)
  n_control <- n_control_clusters * patients_per_cluster * (1 - control_attrition)
  n_harmonic <- (2 * n_treatment * n_control) / (n_treatment + n_control)
  sigma2 <- sigma_hamd^2
  sigma2_adj <- sigma2 * (1 - r2_hamd)
  cluster_size <- patients_per_cluster * (1 - control_attrition)
  design_effect <- (1 + (cluster_size - 1) * icc_hamd) * (1 + cluster_size_cv^2)
  ipcw_vif <- 1.2
  repeated_measures_gain <- 1.43
  net_variance <- (sigma2_adj * design_effect * ipcw_vif) / repeated_measures_gain
  mde <- (z_alpha + z_beta) * sqrt(2 * net_variance / n_harmonic)
  list(mde = mde, effect_size = mde / sigma_hamd, n_clusters = n_clusters, n_completers = round(n_treatment + n_control))
}

calc_retention_mde <- function(total_n) {
  n_clusters <- round(total_n / patients_per_cluster)
  treatment_prop <- treatment_ratio / (treatment_ratio + 1)
  n_treatment_clusters <- round(n_clusters * treatment_prop)
  n_control_clusters <- n_clusters - n_treatment_clusters
  n_treatment <- n_treatment_clusters * patients_per_cluster
  n_control <- n_control_clusters * patients_per_cluster
  design_effect <- (1 + (patients_per_cluster - 1) * icc_retention) * (1 + cluster_size_cv^2)
  p0 <- control_attrition
  base_se <- sqrt(p0 * (1 - p0) * (1/n_treatment + 1/n_control))
  clustered_se <- base_se * sqrt(design_effect)
  adjusted_se <- clustered_se * sqrt(1 - r2_retention)
  survival_se <- adjusted_se / sqrt(survival_efficiency)
  mde <- (z_alpha + z_beta) * survival_se
  list(mde_pp = mde * 100, control_rate = p0 * 100, treatment_rate = (p0 - mde) * 100)
}

hamd_result <- calc_hamd_mde(total_n)
retention_result <- calc_retention_mde(total_n)

cat("HAM-D Results (N =", total_n, "):\\n")
cat("  MDE:", round(hamd_result$mde, 2), "points\\n")
cat("  Cohen's d:", round(hamd_result$effect_size, 2), "\\n")
cat("  Clusters:", hamd_result$n_clusters, "\\n")
cat("  Completers:", hamd_result$n_completers, "\\n\\n")
cat("Retention Results (N =", total_n, "):\\n")
cat("  MDE:", round(retention_result$mde_pp, 1), "percentage points\\n")
cat("  Treatment rate:", round(retention_result$treatment_rate, 1), "%\\n")
cat("  Control rate:", round(retention_result$control_rate, 1), "%\\n")
`;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto bg-gray-50 min-h-screen">
      <h1 className="text-xl md:text-2xl font-bold mb-2">
        AURORA Trial Power Curves
      </h1>
      <p className="text-gray-600 mb-4 md:mb-6 text-sm md:text-base">
        Explore minimum detectable effects across sample sizes
      </p>

      {/* Current Design Summary */}
      <div className="bg-white rounded-lg shadow p-3 md:p-4 mb-4 md:mb-6">
        <h2 className="font-semibold mb-3 text-sm md:text-base">
          Current Design (N={currentN.toLocaleString()})
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 md:gap-4 text-xs md:text-sm">
          <div className="bg-blue-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">
              HAM-D Min Detectable Effect
            </div>
            <div className="text-lg md:text-xl font-bold text-blue-700">
              {currentHamd.mde.toFixed(2)} pts
            </div>
            <div className="text-gray-500 text-xs">
              d = {currentHamd.effectSize.toFixed(2)}
            </div>
            {(useRasch || useMFRM) && (
              <div className="text-xs text-green-600">
                (was {currentHamd.baselineMDE?.toFixed(2)} pts)
              </div>
            )}
          </div>
          <div className="bg-green-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">
              Retention Min Detectable Effect
            </div>
            <div className="text-lg md:text-xl font-bold text-green-700">
              {currentRetention.mde.toFixed(1)} pp
            </div>
            <div className="text-gray-500 text-xs">
              {currentRetention.treatmentRate.toFixed(1)}% vs{" "}
              {currentRetention.controlRate}%
            </div>
            <div className="text-xs text-gray-400 hidden sm:block">
              (binary: {currentRetention.binaryMDE?.toFixed(1)} pp)
            </div>
          </div>
          <div className="bg-purple-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">Clusters</div>
            <div className="text-lg md:text-xl font-bold text-purple-700">
              {currentHamd.nClusters}
            </div>
            <div className="text-gray-500 text-xs">
              {currentHamd.nTreatmentClusters} tx /{" "}
              {currentHamd.nControlClusters} ctrl
            </div>
          </div>
          <div className="bg-orange-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">Completers</div>
            <div className="text-lg md:text-xl font-bold text-orange-700">
              {currentHamd.nCompleters}
            </div>
            <div className="text-gray-500 text-xs">
              after {(controlAttrition * 100).toFixed(0)}% attrition
            </div>
          </div>
          <div
            className={`p-2 md:p-3 rounded ${useRasch || useMFRM ? "bg-green-50" : "bg-gray-50"}`}
          >
            <div className="text-gray-500 text-xs">Measurement</div>
            <div className="text-sm font-bold text-gray-700">
              {useRasch && useMFRM
                ? "Rasch + Multi-Facet"
                : useRasch
                  ? "Rasch Partial Credit"
                  : useMFRM
                    ? "Multi-Facet Rasch"
                    : "Sum score"}
            </div>
            {(useRasch || useMFRM) && (
              <div className="text-xs text-green-600">
                -{currentHamd.varianceReduction?.toFixed(1)}% variance
              </div>
            )}
          </div>
          <div
            className={`p-2 md:p-3 rounded ${currentIcc.canRuleOutPoor ? "bg-teal-50" : "bg-red-50"}`}
          >
            <div className="text-gray-500 text-xs">
              Intraclass Correlation Precision
            </div>
            <div
              className={`text-lg md:text-xl font-bold ${currentIcc.canRuleOutPoor ? "text-teal-700" : "text-red-700"}`}
            >
              ±{currentIcc.ciHalfWidth.toFixed(3)}
            </div>
            <div className="text-gray-500 text-xs">
              {currentIcc.nObservations} obs (tx only)
            </div>
          </div>
        </div>
      </div>

      {/* Parameter Controls */}
      <div className="bg-white rounded-lg shadow p-3 md:p-4 mb-4 md:mb-6">
        <h2 className="font-semibold mb-3 text-sm md:text-base">Parameters</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Power
            </label>
            <select
              value={power}
              onChange={(e) => setPower(parseFloat(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={0.7}>70%</option>
              <option value={0.75}>75%</option>
              <option value={0.8}>80%</option>
              <option value={0.85}>85%</option>
              <option value={0.9}>90%</option>
            </select>
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Alpha (Benjamini-Hochberg adjusted)
            </label>
            <select
              value={alpha}
              onChange={(e) => setAlpha(parseFloat(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={0.05}>0.05 (none)</option>
              <option value={0.025}>0.025 (B-H)</option>
              <option value={0.01}>0.01</option>
            </select>
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Clinicians
            </label>
            <select
              value={nClinicians}
              onChange={(e) => setNClinicians(parseInt(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={60}>60</option>
              <option value={80}>80</option>
              <option value={100}>100</option>
              <option value={120}>120</option>
              <option value={140}>140</option>
            </select>
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Patients/Clinician
            </label>
            <select
              value={patientsPerCluster}
              onChange={(e) => setPatientsPerCluster(parseInt(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={5}>5</option>
              <option value={8}>8</option>
              <option value={10}>10</option>
              <option value={12}>12</option>
              <option value={15}>15</option>
            </select>
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Cluster Size Variation
            </label>
            <select
              value={clusterSizeCV}
              onChange={(e) => setClusterSizeCV(parseFloat(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={0}>0 (equal)</option>
              <option value={0.2}>0.2 (low)</option>
              <option value={0.4}>0.4 (moderate)</option>
              <option value={0.6}>0.6 (high)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Control Attrition
            </label>
            <select
              value={controlAttrition}
              onChange={(e) => setControlAttrition(parseFloat(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={0.2}>20%</option>
              <option value={0.25}>25%</option>
              <option value={0.3}>30%</option>
              <option value={0.35}>35%</option>
              <option value={0.4}>40%</option>
            </select>
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Tx:Ctrl Ratio
            </label>
            <select
              value={treatmentRatio}
              onChange={(e) => setTreatmentRatio(parseInt(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={1}>1:1</option>
              <option value={2}>2:1</option>
              <option value={3}>3:1</option>
              <option value={4}>4:1</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mt-3 md:mt-4">
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              HAM-D Intracluster Corr: {iccHamd}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.10"
              step="0.01"
              value={iccHamd}
              onChange={(e) => setIccHamd(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              HAM-D R²: {r2Hamd}
            </label>
            <input
              type="range"
              min="0.20"
              max="0.50"
              step="0.05"
              value={r2Hamd}
              onChange={(e) => setR2Hamd(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Retention Intracluster Corr: {iccRetention}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.10"
              step="0.01"
              value={iccRetention}
              onChange={(e) => setIccRetention(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Retention R²: {r2Retention}
            </label>
            <input
              type="range"
              min="0.00"
              max="0.20"
              step="0.02"
              value={r2Retention}
              onChange={(e) => setR2Retention(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Survival eff: {survivalEfficiency}×
            </label>
            <input
              type="range"
              min="1"
              max="5"
              step="0.5"
              value={survivalEfficiency}
              onChange={(e) =>
                setSurvivalEfficiency(parseFloat(e.target.value))
              }
              className="w-full"
            />
            <div className="text-xs text-gray-400 hidden sm:block">
              1× = binary, 4-5× = continuous monitoring
            </div>
          </div>
        </div>
      </div>

      {/* Measurement Model Controls */}
      <div className="bg-white rounded-lg shadow p-3 md:p-4 mb-4 md:mb-6">
        <h2 className="font-semibold mb-3 text-sm md:text-base">
          Measurement Model (HAM-D)
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-3 md:mb-4">
          <div className="flex items-center">
            <input
              type="radio"
              id="modelSum"
              name="measurementModel"
              value="sum"
              checked={measurementModel === "sum"}
              onChange={(e) => setMeasurementModel(e.target.value)}
              className="mr-2 h-4 w-4"
            />
            <label htmlFor="modelSum" className="text-xs md:text-sm">
              Sum score
            </label>
          </div>
          <div className="flex items-center">
            <input
              type="radio"
              id="modelRasch"
              name="measurementModel"
              value="rasch"
              checked={measurementModel === "rasch"}
              onChange={(e) => setMeasurementModel(e.target.value)}
              className="mr-2 h-4 w-4"
            />
            <label htmlFor="modelRasch" className="text-xs md:text-sm">
              Rasch Partial Credit Model
            </label>
          </div>
          <div className="flex items-center">
            <input
              type="radio"
              id="modelMFRM"
              name="measurementModel"
              value="mfrm"
              checked={measurementModel === "mfrm"}
              onChange={(e) => setMeasurementModel(e.target.value)}
              className="mr-2 h-4 w-4"
            />
            <label htmlFor="modelMFRM" className="text-xs md:text-sm">
              Multi-Facet Rasch Model
            </label>
          </div>
          <div className="text-xs md:text-sm text-gray-600">
            {(useRasch || useMFRM) && (
              <span className="text-green-600 font-medium">
                -{currentHamd.varianceReduction?.toFixed(1)}% var → MDE:{" "}
                {currentHamd.mde.toFixed(2)} pts
              </span>
            )}
          </div>
        </div>

        {(useRasch || useMFRM) && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 pt-3 border-t">
            <div>
              <label className="block text-xs md:text-sm text-gray-600 mb-1">
                Sum reliability: {sumScoreReliability}
              </label>
              <input
                type="range"
                min="0.80"
                max="0.92"
                step="0.01"
                value={sumScoreReliability}
                onChange={(e) =>
                  setSumScoreReliability(parseFloat(e.target.value))
                }
                className="w-full"
                disabled={!useRasch}
              />
            </div>
            <div>
              <label className="block text-xs md:text-sm text-gray-600 mb-1">
                Rasch rel: {raschReliability}
              </label>
              <input
                type="range"
                min="0.85"
                max="0.95"
                step="0.01"
                value={raschReliability}
                onChange={(e) =>
                  setRaschReliability(parseFloat(e.target.value))
                }
                className="w-full"
                disabled={!useRasch}
              />
            </div>
            <div>
              <label className="block text-xs md:text-sm text-gray-600 mb-1">
                Rater var: {(raterVarianceProp * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0.03"
                max="0.15"
                step="0.01"
                value={raterVarianceProp}
                onChange={(e) =>
                  setRaterVarianceProp(parseFloat(e.target.value))
                }
                className="w-full"
                disabled={!useMFRM}
              />
            </div>
            <div className="text-xs text-gray-500 items-center hidden md:flex">
              <div>
                <div>
                  <strong>Rasch Partial Credit:</strong> Interval scoring
                </div>
                <div>
                  <strong>Multi-Facet Rasch:</strong> Removes rater effects
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ICC Validation Controls */}
      <div className="bg-white rounded-lg shadow p-3 md:p-4 mb-4 md:mb-6">
        <h2 className="font-semibold mb-3 text-sm md:text-base">
          Intraclass Correlation Validation (Treatment Arm)
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Expected Intraclass Corr: {expectedIcc}
            </label>
            <input
              type="range"
              min="0.70"
              max="0.95"
              step="0.01"
              value={expectedIcc}
              onChange={(e) => setExpectedIcc(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Target Intraclass Corr: {targetIcc}
            </label>
            <input
              type="range"
              min="0.60"
              max="0.80"
              step="0.05"
              value={targetIcc}
              onChange={(e) => setTargetIcc(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Follow-ups
            </label>
            <select
              value={nFollowups}
              onChange={(e) => setNFollowups(parseInt(e.target.value))}
              className="w-full border rounded p-1.5 md:p-2 text-sm"
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
              <option value={6}>6</option>
            </select>
          </div>
          <div>
            <label className="block text-xs md:text-sm text-gray-600 mb-1">
              Cluster Intracluster Corr: {iccClusterCorr}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.10"
              step="0.01"
              value={iccClusterCorr}
              onChange={(e) => setIccClusterCorr(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
        </div>
        <div className="mt-2 text-xs text-gray-500">
          Tests if AURORA-clinician agreement exceeds threshold for "good"
          reliability (intraclass correlation {">"} {targetIcc})
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4 md:gap-6 mb-4 md:mb-6">
        {/* HAM-D Chart */}
        <div className="bg-white rounded-lg shadow p-3 md:p-4">
          <h2 className="font-semibold mb-1 text-sm md:text-base">
            Depression Severity (HAM-D)
          </h2>
          {(useRasch || useMFRM) && (
            <p className="text-xs text-green-600 mb-2">
              Measurement optimization: -
              {currentHamd.varianceReduction?.toFixed(1)}% variance
            </p>
          )}
          <ResponsiveContainer
            width="100%"
            height={250}
            className="md:!h-[300px]"
          >
            <ComposedChart
              data={powerData}
              margin={{ bottom: 15, left: 0, right: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="n"
                ticks={[400, 600, 800, 1000, 1200]}
                label={{
                  value: "Total N (patients)",
                  position: "bottom",
                  offset: 0,
                }}
              />
              <YAxis
                label={{
                  value: "MDE (HAM-D points)",
                  angle: -90,
                  position: "insideLeft",
                  style: { textAnchor: "middle" },
                }}
                domain={[0, 4]}
              />
              <Tooltip
                formatter={(value, name) => {
                  if (name === "With Rasch/MFRM" || name === "MDE")
                    return [
                      value.toFixed(2) + " pts",
                      useRasch || useMFRM ? "MDE (optimized)" : "MDE",
                    ];
                  if (name === "Sum score baseline")
                    return [value.toFixed(2) + " pts", "MDE (sum score)"];
                  return [value, name];
                }}
                labelFormatter={(n) =>
                  `N = ${n} (${Math.round(n / patientsPerCluster)} clusters)`
                }
              />
              <Area
                type="monotone"
                dataKey={() => 3}
                fill="#dcfce7"
                stroke="none"
                fillOpacity={0.5}
                legendType="none"
                tooltipType="none"
              />
              <Area
                type="monotone"
                dataKey={() => 2}
                fill="#bbf7d0"
                stroke="none"
                fillOpacity={0.5}
                legendType="none"
                tooltipType="none"
              />
              {(useRasch || useMFRM) && (
                <Line
                  type="monotone"
                  dataKey="hamdBaselineMDE"
                  stroke="#9ca3af"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  name="Sum score baseline"
                />
              )}
              <Line
                type="monotone"
                dataKey="hamdMDE"
                stroke="#2563eb"
                strokeWidth={2}
                dot={false}
                name={useRasch || useMFRM ? "With Rasch/MFRM" : "MDE"}
              />
              <ReferenceLine x={1000} stroke="#666" strokeDasharray="5 5" />
              <ReferenceLine
                y={2}
                stroke="#16a34a"
                strokeDasharray="3 3"
                label={{
                  value: "2 pts",
                  position: "right",
                  fill: "#16a34a",
                  fontSize: 11,
                }}
              />
              <ReferenceLine
                y={3}
                stroke="#22c55e"
                strokeDasharray="3 3"
                label={{
                  value: "3 pts",
                  position: "right",
                  fill: "#22c55e",
                  fontSize: 11,
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="text-xs md:text-sm text-gray-600 mt-2">
            <span className="inline-block w-3 h-3 bg-green-200 mr-1"></span>{" "}
            <span className="hidden sm:inline">
              Minimally clinically important difference (2-3 points)
            </span>
            <span className="sm:hidden">Min Clinical Diff (2-3 pts)</span>
            {(useRasch || useMFRM) && (
              <span className="ml-3 text-xs">
                | <span className="text-gray-400">---</span> Sum score baseline
              </span>
            )}
          </div>
        </div>

        {/* Retention Chart */}
        <div className="bg-white rounded-lg shadow p-3 md:p-4">
          <h2 className="font-semibold mb-1 text-sm md:text-base">
            Study Retention
          </h2>
          <p className="text-xs text-gray-500 mb-2 md:mb-3">
            Survival analysis with {survivalEfficiency}× efficiency (binary MDE:{" "}
            {currentRetention.binaryMDE?.toFixed(1) || "N/A"} pp)
          </p>
          <ResponsiveContainer
            width="100%"
            height={250}
            className="md:!h-[300px]"
          >
            <ComposedChart
              data={powerData}
              margin={{ bottom: 15, left: 0, right: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="n"
                ticks={[400, 600, 800, 1000, 1200]}
                label={{
                  value: "Total N (patients)",
                  position: "bottom",
                  offset: 0,
                }}
              />
              <YAxis
                label={{
                  value: "MDE (percentage points)",
                  angle: -90,
                  position: "insideLeft",
                  style: { textAnchor: "middle" },
                }}
                domain={[0, 15]}
              />
              <Tooltip
                formatter={(value, name) => {
                  if (name === "retentionMDE")
                    return [value.toFixed(2) + " pp", "MDE"];
                  return [value, name];
                }}
                labelFormatter={(n) =>
                  `N = ${n} (${Math.round(n / patientsPerCluster)} clusters)`
                }
              />
              <Line
                type="monotone"
                dataKey="retentionMDE"
                stroke="#16a34a"
                strokeWidth={2}
                dot={false}
              />
              <ReferenceLine x={1000} stroke="#666" strokeDasharray="5 5" />
              <ReferenceLine
                y={5}
                stroke="#f59e0b"
                strokeDasharray="3 3"
                label={{
                  value: "5 pp",
                  position: "right",
                  fill: "#f59e0b",
                  fontSize: 11,
                }}
              />
              <ReferenceLine
                y={7}
                stroke="#f97316"
                strokeDasharray="3 3"
                label={{
                  value: "7 pp",
                  position: "right",
                  fill: "#f97316",
                  fontSize: 11,
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="text-xs md:text-sm text-gray-600 mt-2">
            Control attrition: {(controlAttrition * 100).toFixed(0)}% →
            Treatment:{" "}
            {(controlAttrition * 100 - currentRetention.mde).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* ICC Validation Chart */}
      <div className="bg-white rounded-lg shadow p-3 md:p-4 mb-4 md:mb-6">
        <h2 className="font-semibold mb-1 text-sm md:text-base">
          Intraclass Correlation Validation (Treatment Arm Only)
        </h2>
        <p className="text-xs text-gray-500 mb-2 md:mb-3">
          95% confidence interval precision for AURORA-clinician agreement
          (target: rule out intraclass correlation {"<"} {targetIcc})
        </p>
        <ResponsiveContainer
          width="100%"
          height={250}
          className="md:!h-[300px]"
        >
          <ComposedChart
            data={powerData}
            margin={{ bottom: 15, left: 10, right: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="n"
              ticks={[400, 600, 800, 1000, 1200]}
              label={{
                value: "Total N (patients)",
                position: "bottom",
                offset: 0,
              }}
            />
            <YAxis
              label={{
                value: "95% CI half-width (±)",
                angle: -90,
                position: "insideLeft",
                style: { textAnchor: "middle" },
              }}
              domain={[0, 0.08]}
            />
            <Tooltip
              formatter={(value, name) => {
                if (name === "CI half-width")
                  return [value.toFixed(3), "CI half-width (±)"];
                return [value, name];
              }}
              labelFormatter={(n) => {
                const iccVal = calcIccValidation(n);
                return `N=${n}: ${iccVal.nObservations} obs, CI: ${iccVal.lowerBound.toFixed(3)}-${iccVal.upperBound.toFixed(3)}`;
              }}
            />
            <Area
              type="monotone"
              dataKey={() => 0.05}
              fill="#d1fae5"
              stroke="none"
              fillOpacity={0.5}
              legendType="none"
              tooltipType="none"
            />
            <Line
              type="monotone"
              dataKey={(d) => d.iccCiWidth / 2}
              stroke="#0d9488"
              strokeWidth={2}
              dot={false}
              name="CI half-width"
            />
            <ReferenceLine x={1000} stroke="#666" strokeDasharray="5 5" />
            <ReferenceLine
              y={expectedIcc - targetIcc}
              stroke="#ef4444"
              strokeDasharray="3 3"
              label={{
                value: `±${(expectedIcc - targetIcc).toFixed(2)} (rule out <${targetIcc})`,
                position: "right",
                fill: "#ef4444",
                fontSize: 10,
              }}
            />
            <ReferenceLine
              y={0.03}
              stroke="#10b981"
              strokeDasharray="3 3"
              label={{
                value: "±0.03",
                position: "right",
                fill: "#10b981",
                fontSize: 11,
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="text-xs md:text-sm text-gray-600 mt-2">
          <span className="inline-block w-3 h-3 bg-green-200 mr-1"></span>
          High precision zone (±0.03-0.05) | Expected intraclass corr:{" "}
          {expectedIcc} |
          {currentIcc.canRuleOutPoor ? (
            <span className="text-teal-600 font-medium ml-1">
              Can rule out intraclass corr {"<"} {targetIcc}
            </span>
          ) : (
            <span className="text-red-600 font-medium ml-1">
              Cannot rule out intraclass corr {"<"} {targetIcc}
            </span>
          )}
        </div>
      </div>

      {/* Sample Size Table */}
      <div className="bg-white rounded-lg shadow p-3 md:p-4 mb-4 md:mb-6">
        <h2 className="font-semibold mb-3 text-sm md:text-base">
          Sample Size Requirements
        </h2>
        <div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0">
          <table className="w-full text-xs md:text-sm min-w-[500px]">
            <thead>
              <tr className="border-b">
                <th className="text-left p-1.5 md:p-2">N</th>
                <th className="text-left p-1.5 md:p-2 hidden sm:table-cell">
                  Clusters
                </th>
                <th className="text-left p-1.5 md:p-2">HAM-D</th>
                {(useRasch || useMFRM) && (
                  <th className="text-left p-1.5 md:p-2 text-gray-400 hidden md:table-cell">
                    (Sum)
                  </th>
                )}
                <th className="text-left p-1.5 md:p-2">d</th>
                <th className="text-left p-1.5 md:p-2">Retention</th>
                <th className="text-left p-1.5 md:p-2 hidden sm:table-cell">
                  Tx Attrition
                </th>
                <th className="text-left p-1.5 md:p-2 hidden md:table-cell">
                  Intraclass Corr ±
                </th>
              </tr>
            </thead>
            <tbody>
              {[400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300].map(
                (n) => {
                  const hamd = calcHamdMDE(n);
                  const retention = calcRetentionMDE(n);
                  const iccVal = calcIccValidation(n);
                  const isCurrentDesign = n === 1000;
                  return (
                    <tr
                      key={n}
                      className={`border-b ${isCurrentDesign ? "bg-blue-50 font-semibold" : ""}`}
                    >
                      <td className="p-1.5 md:p-2">{n}</td>
                      <td className="p-1.5 md:p-2 hidden sm:table-cell">
                        {hamd.nClusters}
                      </td>
                      <td className="p-1.5 md:p-2">{hamd.mde.toFixed(2)}</td>
                      {(useRasch || useMFRM) && (
                        <td className="p-1.5 md:p-2 text-gray-400 hidden md:table-cell">
                          {hamd.baselineMDE.toFixed(2)}
                        </td>
                      )}
                      <td className="p-1.5 md:p-2">
                        {hamd.effectSize.toFixed(2)}
                      </td>
                      <td className="p-1.5 md:p-2">
                        {retention.mde.toFixed(1)}
                      </td>
                      <td className="p-1.5 md:p-2 hidden sm:table-cell">
                        {retention.treatmentRate.toFixed(1)}%
                      </td>
                      <td
                        className={`p-1.5 md:p-2 hidden md:table-cell ${iccVal.canRuleOutPoor ? "text-teal-600" : "text-red-600"}`}
                      >
                        {iccVal.ciHalfWidth.toFixed(3)}
                      </td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        </div>
        {(useRasch || useMFRM) && (
          <p className="text-xs text-gray-500 mt-2">
            Gray column shows MDE with traditional sum scoring for comparison
          </p>
        )}
      </div>

      {/* R Code for Verification */}
      <div className="bg-white rounded-lg shadow mb-4 md:mb-6">
        <button
          onClick={() => setShowRCode(!showRCode)}
          className="w-full p-3 md:p-4 text-left flex justify-between items-center hover:bg-gray-50"
        >
          <h2 className="font-semibold text-sm md:text-base">
            R Code for Verification
          </h2>
          <span className="text-gray-500">{showRCode ? "−" : "+"}</span>
        </button>
        {showRCode && (
          <div className="p-3 md:p-4 border-t">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <button
                onClick={() => runRCode(rCodeForExecution)}
                disabled={webRStatus === "loading" || webRStatus === "running"}
                className={`px-4 py-2 text-sm font-medium rounded ${
                  webRStatus === "loading" || webRStatus === "running"
                    ? "bg-gray-300 text-gray-500 cursor-wait"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                {webRStatus === "loading"
                  ? "Downloading R..."
                  : webRStatus === "running"
                    ? "Running..."
                    : webRStatus === "ready"
                      ? "Run Again"
                      : "Run in Browser"}
              </button>
              {webRStatus === "loading" && (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-xs text-gray-500">~25MB download</span>
                </div>
              )}
              <span className="text-xs text-gray-500">
                or copy the code below to run in R
              </span>
            </div>

            {webROutput && (
              <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded">
                <div className="text-xs font-medium text-green-800 mb-1">
                  R Output:
                </div>
                <pre className="text-xs text-green-900 whitespace-pre-wrap font-mono">
                  {webROutput}
                </pre>
              </div>
            )}

            <pre className="bg-gray-900 text-gray-100 p-3 md:p-4 rounded text-xs overflow-x-auto">
              <code>{`# AURORA Trial Power Calculations
# Reproduces the minimum detectable effect (MDE) calculations

# ============================================
# Current parameter values from the calculator
# ============================================

# Trial design parameters
total_n <- ${currentN}                        # Total sample size
patients_per_cluster <- ${patientsPerCluster}
cluster_size_cv <- ${clusterSizeCV}              # Coefficient of variation in cluster sizes
treatment_ratio <- ${treatmentRatio}                 # Treatment:Control ratio (${treatmentRatio}:1)
control_attrition <- ${controlAttrition}            # Expected attrition rate

# Statistical parameters
power <- ${power}
alpha <- ${alpha}                      # Two-sided alpha (Benjamini-Hochberg adjusted)
z_alpha <- qnorm(1 - alpha)            # Z-score for alpha
z_beta <- qnorm(power)                 # Z-score for power

# HAM-D outcome parameters
icc_hamd <- ${iccHamd}                   # Intracluster correlation
r2_hamd <- ${r2Hamd}                     # Variance explained by covariates
sigma_hamd <- 7                        # HAM-D standard deviation

# Retention outcome parameters
icc_retention <- ${iccRetention}             # Intracluster correlation
r2_retention <- ${r2Retention}              # Variance explained by covariates
survival_efficiency <- ${survivalEfficiency}           # Efficiency gain from survival analysis

# ============================================
# HAM-D MDE Calculation
# ============================================

calc_hamd_mde <- function(total_n) {
  # Calculate cluster allocation
  n_clusters <- round(total_n / patients_per_cluster)
  treatment_prop <- treatment_ratio / (treatment_ratio + 1)
  n_treatment_clusters <- round(n_clusters * treatment_prop)
  n_control_clusters <- n_clusters - n_treatment_clusters

  # Patients after attrition
  n_treatment <- n_treatment_clusters * patients_per_cluster * (1 - control_attrition)
  n_control <- n_control_clusters * patients_per_cluster * (1 - control_attrition)

  # Harmonic mean of completers
  n_harmonic <- (2 * n_treatment * n_control) / (n_treatment + n_control)

  # Variance calculations
  sigma2 <- sigma_hamd^2
  sigma2_adj <- sigma2 * (1 - r2_hamd)

  # Design effect for clustering (adjusted for unequal cluster sizes)
  cluster_size <- patients_per_cluster * (1 - control_attrition)
  design_effect <- (1 + (cluster_size - 1) * icc_hamd) * (1 + cluster_size_cv^2)

  # IPCW variance inflation factor
  ipcw_vif <- 1.2

  # Repeated measures efficiency (4 timepoints, r ~ 0.5)
  repeated_measures_gain <- 1.43

  # Net variance
  net_variance <- (sigma2_adj * design_effect * ipcw_vif) / repeated_measures_gain

  # MDE
  mde <- (z_alpha + z_beta) * sqrt(2 * net_variance / n_harmonic)

  return(list(
    mde = mde,
    effect_size = mde / sigma_hamd,  # Cohen's d
    n_clusters = n_clusters,
    n_completers = round(n_treatment + n_control)
  ))
}

# ============================================
# Retention MDE Calculation
# ============================================

calc_retention_mde <- function(total_n) {
  # Calculate cluster allocation
  n_clusters <- round(total_n / patients_per_cluster)
  treatment_prop <- treatment_ratio / (treatment_ratio + 1)
  n_treatment_clusters <- round(n_clusters * treatment_prop)
  n_control_clusters <- n_clusters - n_treatment_clusters

  n_treatment <- n_treatment_clusters * patients_per_cluster
  n_control <- n_control_clusters * patients_per_cluster

  # Design effect (adjusted for unequal cluster sizes)
  design_effect <- (1 + (patients_per_cluster - 1) * icc_retention) * (1 + cluster_size_cv^2)

  p0 <- control_attrition

  # Base SE for proportion difference
  base_se <- sqrt(p0 * (1 - p0) * (1/n_treatment + 1/n_control))

  # Apply clustering, covariate adjustment, and survival efficiency
  clustered_se <- base_se * sqrt(design_effect)
  adjusted_se <- clustered_se * sqrt(1 - r2_retention)
  survival_se <- adjusted_se / sqrt(survival_efficiency)

  mde <- (z_alpha + z_beta) * survival_se

  return(list(
    mde_pp = mde * 100,  # Percentage points
    control_rate = p0 * 100,
    treatment_rate = (p0 - mde) * 100
  ))
}

# ============================================
# Run calculations
# ============================================

hamd_result <- calc_hamd_mde(total_n)
retention_result <- calc_retention_mde(total_n)

cat("HAM-D Results (N =", total_n, "):\\n")
cat("  MDE:", round(hamd_result$mde, 2), "points\\n")
cat("  Cohen's d:", round(hamd_result$effect_size, 2), "\\n")
cat("  Clusters:", hamd_result$n_clusters, "\\n")
cat("  Completers:", hamd_result$n_completers, "\\n\\n")

cat("Retention Results (N =", total_n, "):\\n")
cat("  MDE:", round(retention_result$mde_pp, 1), "percentage points\\n")
cat("  Treatment rate:", round(retention_result$treatment_rate, 1), "%\\n")
cat("  Control rate:", round(retention_result$control_rate, 1), "%\\n")
`}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
