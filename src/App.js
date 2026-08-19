import React, { useState, useMemo, useEffect } from "react";
import {
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
import { createModel } from "./calc";
import { buildRCode } from "./rcode";
import { defaults } from "./defaults";
import {
  decodeSettings,
  readTokenFromLocation,
  shareableUrl,
  syncLocation,
} from "./urlState";

const STORAGE_KEY = "aurora-power-calculator-settings";

// Categorical series colors, validated for colorblind separation against a white chart
// surface (all-pairs). Color follows the contrast, not the outcome, so "blue = A vs C"
// means the same thing in every chart.
const CONTRAST_COLORS = {
  AC: "#2a78d6",
  BC: "#eb6834",
  AB: "#1baf7a",
  // The pooled contrast is an alternative presentation of the same data, not a fourth
  // series, so it takes secondary ink rather than a categorical hue - which also avoids
  // adding a 4th chart colour that has not been validated for colourblind separation.
  PC: "#52514e",
};
// Comparison lines (sum-score baseline, two-arm baseline) stay in gray ink so they never
// compete with the contrast series; they are told apart by dash pattern and weight.
const INK_MUTED = "#898781";
const INK_SECONDARY = "#52514e";

// Icon-only affordances: the label would compete with "Reset to Defaults" for attention,
// and copying a link is a secondary action. Both carry a title and aria-label instead.
const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

const LinkIcon = () => (
  <svg {...iconProps}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

const CheckIcon = () => (
  <svg {...iconProps}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function loadSettings() {
  // A URL token wins over saved settings: following a shared link should show that
  // link's configuration, not whatever this browser last had open.
  const token = readTokenFromLocation();
  if (token) return decodeSettings(token);

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      // Spreading over defaults means a payload saved before the three-arm keys
      // existed picks them up automatically, and defaults to the two-arm design.
      return { ...defaults, ...JSON.parse(saved) };
    }
  } catch (e) {
    // Ignore errors
  }
  return defaults;
}

// The sweep always covers the configured design point, which can exceed the old fixed
// 1300 ceiling (150 clinicians x 10 patients = 1500).
function sweepRange(currentN) {
  const max = Math.max(1300, Math.ceil(currentN / 50) * 50);
  const sweep = [];
  for (let n = 400; n <= max; n += 50) sweep.push(n);
  const table = [];
  for (let n = 400; n <= max; n += 100) table.push(n);
  if (!table.includes(currentN)) {
    table.push(currentN);
    table.sort((a, b) => a - b);
  }
  return { sweep, table, max };
}

export default function PowerCurves() {
  const [settings, setSettings] = useState(loadSettings);
  const set = (key) => (value) => setSettings((s) => ({ ...s, [key]: value }));

  const {
    analysisFraming,
    chartMetric,
    designArms,
    treatmentRatio,
    allocA,
    allocB,
    allocC,
    multiplicity,
    smallSampleT,
    selectedContrast,
    assumedEffect,
    power,
    alpha,
    patientsPerCluster,
    nClinicians,
    clusterSizeCV,
    controlAttrition,
    iccHamd,
    iccRetention,
    r2Hamd,
    r2Retention,
    survivalEfficiency,
    measurementModel,
    sumScoreReliability,
    raschReliability,
    raterVarianceProp,
    targetIcc,
    expectedIcc,
    iccClusterCorr,
    nFollowups,
    difSubgroupShare,
    difThresholdN,
    difTargetLogits,
    difItemInfo,
    randomization,
  } = settings;

  const threeArm = designArms === 3;

  const isDefaultSettings = useMemo(
    () => Object.keys(defaults).every((k) => settings[k] === defaults[k]),
    [settings],
  );

  const resetToDefaults = () => {
    setSettings(defaults);
    localStorage.removeItem(STORAGE_KEY);
  };

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      // Ignore errors
    }
    // Keep the address bar in step so the current view is always linkable.
    syncLocation(settings);
  }, [settings]);

  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    const url = shareableUrl(settings);
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      // Clipboard can be unavailable (permissions, insecure context). The address bar
      // already holds the same URL, so this is a convenience rather than the mechanism.
      window.prompt("Copy this link:", url);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // R code section visibility
  const [showRCode, setShowRCode] = useState(false);

  // WebR state
  const [webRStatus, setWebRStatus] = useState("idle"); // idle, loading, ready, running, error
  const [webROutput, setWebROutput] = useState("");
  const [webRInstance, setWebRInstance] = useState(null);

  // Load WebR dynamically via script tag
  const loadWebR = () => {
    return new Promise((resolve, reject) => {
      if (window.WebR) {
        resolve(window.WebR);
        return;
      }
      const script = document.createElement("script");
      script.type = "module";
      script.textContent = `
        import { WebR } from 'https://webr.r-wasm.org/latest/webr.mjs';
        window.WebR = WebR;
        window.dispatchEvent(new Event('webr-loaded'));
      `;
      window.addEventListener("webr-loaded", () => resolve(window.WebR), {
        once: true,
      });
      script.onerror = reject;
      document.head.appendChild(script);
    });
  };

  // Load and run R code in browser using WebR
  const runRCode = async (rCode) => {
    if (webRStatus === "running") return;

    try {
      let webR = webRInstance;

      if (!webR) {
        setWebRStatus("loading");
        setWebROutput("Downloading R runtime (~25MB, first time only)...");

        const WebR = await loadWebR();
        webR = new WebR();
        await webR.init();
        setWebRInstance(webR);
        setWebRStatus("ready");
      }

      setWebRStatus("running");
      setWebROutput("Running R code...");

      // Capture output and collapse to single string
      const result = await webR.evalRString(`
        paste(capture.output({
          ${rCode}
        }, type = "output"), collapse = "\n")
      `);

      setWebROutput(result);
      setWebRStatus("ready");
    } catch (error) {
      setWebRStatus("error");
      setWebROutput(`Error: ${error.message}`);
    }
  };

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------

  const model = useMemo(() => createModel(settings), [settings]);

  // The equivalent two-arm design, used only to show what the third arm costs.
  const twoArmModel = useMemo(
    () => createModel({ ...settings, designArms: 2 }),
    [settings],
  );

  const { contrasts, useRasch, useMFRM } = model;
  const activeContrast =
    contrasts.find((c) => c.id === selectedContrast) || contrasts[0];

  const currentN = nClinicians * patientsPerCluster;
  const currentHamd = model.hamd(currentN, activeContrast);
  const currentRetention = model.retention(currentN, activeContrast);
  const currentIcc = model.icc(currentN);
  const currentAlloc = model.allocation(currentN);
  const currentDif = model.dif(currentN);
  const currentPower = model.hamdPower(currentN, activeContrast, assumedEffect);

  // What the same total N would buy under the two-arm design.
  const twoArmHamd = twoArmModel.hamd(currentN, twoArmModel.contrasts[0]);
  const threeArmCost = (currentHamd.mde / twoArmHamd.mde - 1) * 100;

  const {
    sweep,
    table: nTable,
    max: nMax,
  } = useMemo(() => sweepRange(currentN), [currentN]);

  const xTicks = useMemo(() => {
    const ticks = [];
    for (let n = 400; n <= nMax; n += 200) ticks.push(n);
    return ticks;
  }, [nMax]);

  // The charts plot either the MDE (what could be declared significant) or the confidence
  // interval half-width (how precisely the effect will be estimated). Under an exploratory
  // framing the second is the one that justifies the sample size.
  // Charts show the pairwise decomposition. The pooled contrast answers a different
  // question ("does AURORA in any form help?") and is reported in the cards and table
  // rather than drawn as a fourth line competing with the decomposition.
  const chartContrasts = contrasts.filter((c) => c.family !== "pooled");
  const showPrecision = chartMetric === "precision";
  const metricKey = showPrecision ? "ciHalfWidth" : "mde";

  const powerData = useMemo(() => {
    return sweep.map((n) => {
      const row = { n, clusters: Math.round(n / patientsPerCluster) };
      chartContrasts.forEach((c) => {
        row[`hamd_${c.id}`] = model.hamd(n, c)[metricKey];
        row[`ret_${c.id}`] = model.retention(n, c)[metricKey];
      });
      const first = model.hamd(n, contrasts[0]);
      // The sum-score comparison line has no precision analogue of its own, so scale the
      // baseline SE by the same critical-value ratio the selected metric uses.
      row.hamdBaseline = showPrecision
        ? (first.baselineMDE * first.ciHalfWidth) / first.mde
        : first.baselineMDE;
      row.hamdTwoArm = twoArmModel.hamd(n, twoArmModel.contrasts[0])[metricKey];
      const iccVal = model.icc(n);
      row.iccHalf = iccVal.ciHalfWidth;
      row.iccLower = iccVal.lowerBound;
      return row;
    });
  }, [
    model,
    twoArmModel,
    contrasts,
    patientsPerCluster,
    sweep,
    metricKey,
    showPrecision,
    chartContrasts,
  ]);

  // Scale the y-axes to the data rather than to a fixed ceiling, so adding contrasts (or
  // pushing parameters) never squashes the curves into a band of the plot. The floors keep
  // the clinical reference lines (3 pts, 7 pp) on screen at typical settings.
  const [hamdMax, retMax] = useMemo(() => {
    let h = 0;
    let r = 0;
    for (const row of powerData) {
      for (const c of chartContrasts) {
        h = Math.max(h, row[`hamd_${c.id}`]);
        r = Math.max(r, row[`ret_${c.id}`]);
      }
      h = Math.max(h, row.hamdTwoArm, row.hamdBaseline);
    }
    return [
      Math.max(showPrecision ? 3 : 4, Math.ceil(h * 1.15)),
      Math.max(showPrecision ? 10 : 15, Math.ceil((r * 1.15) / 5) * 5),
    ];
  }, [powerData, chartContrasts, showPrecision]);

  const rCode = useMemo(() => buildRCode(settings), [settings]);

  const critLabel = `${currentHamd.crit.toFixed(3)} (${currentHamd.critMethod})`;
  const exploratory = analysisFraming === "exploratory";
  // Intervals are reported at the same level as the test, so alpha drives both.
  const ciLevel = Math.round((1 - alpha) * 100);

  // ---------------------------------------------------------------------------

  const labelCls = "block text-xs md:text-sm text-gray-600 mb-1";
  const selectCls = "w-full border rounded p-1.5 md:p-2 text-sm";
  const cardCls = "bg-white rounded-lg shadow p-3 md:p-4 mb-4 md:mb-6";

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto bg-gray-50 min-h-screen">
      <h1 className="text-xl md:text-2xl font-bold mb-2">
        AURORA Trial Power Curves
      </h1>
      <p className="text-gray-600 mb-4 md:mb-6 text-sm md:text-base">
        Explore minimum detectable effects across sample sizes
      </p>

      {/* Current Design Summary */}
      <div className={cardCls}>
        <div className="flex flex-wrap justify-between items-baseline gap-2 mb-3">
          <h2 className="font-semibold text-sm md:text-base">
            Current Design (N={currentN.toLocaleString()},{" "}
            {threeArm ? "3-arm" : "2-arm"})
          </h2>
          {threeArm && (
            <span className="text-xs text-gray-500">
              Showing{" "}
              <span className="font-medium text-gray-700">
                {activeContrast.label}
              </span>
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 md:gap-4 text-xs md:text-sm">
          <div className="bg-blue-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">
              {exploratory ? "HAM-D Precision" : "HAM-D Min Detectable Effect"}
            </div>
            <div className="text-lg md:text-xl font-bold text-blue-700">
              {exploratory
                ? `±${currentHamd.ciHalfWidth.toFixed(2)} pts`
                : `${currentHamd.mde.toFixed(2)} pts`}
            </div>
            <div className="text-gray-500 text-xs">
              {exploratory
                ? `${ciLevel}% CI · MDE ${currentHamd.mde.toFixed(2)}`
                : `d = ${currentHamd.effectSize.toFixed(2)}`}
            </div>
            {(useRasch || useMFRM) && (
              <div className="text-xs text-green-600">
                (was {currentHamd.baselineMDE?.toFixed(2)} pts)
              </div>
            )}
            {threeArm && (
              <div className="text-xs text-orange-600">
                {threeArmCost >= 0 ? "+" : ""}
                {threeArmCost.toFixed(1)}% vs 2-arm
              </div>
            )}
          </div>
          <div className="bg-green-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">
              {exploratory
                ? "Retention Precision"
                : "Retention Min Detectable Effect"}
            </div>
            <div className="text-lg md:text-xl font-bold text-green-700">
              {exploratory
                ? `±${currentRetention.ciHalfWidth.toFixed(1)} pp`
                : `${currentRetention.mde.toFixed(1)} pp`}
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
              {model.arms
                .map((a, i) => `${currentAlloc.clusters[i]} ${a.short}`)
                .join(" / ")}
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
              {useMFRM
                ? "Multi-Facet Rasch"
                : useRasch
                  ? "Rasch Partial Credit"
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
              {currentIcc.nObservations} obs (arm
              {currentIcc.armKeys.length > 1 ? "s" : ""}{" "}
              {currentIcc.armKeys.join("+")})
            </div>
          </div>
        </div>

        {threeArm && (
          <div className="mt-3 pt-3 border-t grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-4 text-xs">
            {contrasts.map((c) => {
              const h = model.hamd(currentN, c);
              return (
                <div
                  key={c.id}
                  className={`p-2 rounded border-l-4 ${
                    c.id === selectedContrast ? "bg-gray-50" : ""
                  }`}
                  style={{ borderLeftColor: CONTRAST_COLORS[c.id] }}
                >
                  <div className="font-medium text-gray-700">{c.label}</div>
                  <div className="text-gray-600">
                    {exploratory
                      ? `HAM-D ±${h.ciHalfWidth.toFixed(2)} pts (${ciLevel}% CI) · MDE ${h.mde.toFixed(2)}`
                      : `HAM-D MDE ${h.mde.toFixed(2)} pts · d = ${h.effectSize.toFixed(2)}`}
                  </div>
                  <div className="text-gray-400">
                    crit {h.crit.toFixed(3)} · {h.critMethod}
                    {h.withinCluster && (
                      <span className="text-teal-600"> · within-clinician</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Design Controls */}
      <div className={cardCls}>
        <div className="flex justify-between items-center mb-3 gap-2">
          <h2 className="font-semibold text-sm md:text-base">Trial Design</h2>
          <div className="flex gap-2">
            <button
              onClick={resetToDefaults}
              disabled={isDefaultSettings}
              className={`px-3 py-1 text-xs rounded ${
                isDefaultSettings
                  ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              Reset to Defaults
            </button>
            <button
              onClick={copyLink}
              className={`p-1.5 rounded hover:bg-gray-100 ${
                copied ? "text-green-600" : "text-gray-400 hover:text-gray-600"
              }`}
              title={
                copied
                  ? "Link copied"
                  : "Copy a link that reproduces exactly these settings"
              }
              aria-label={
                copied
                  ? "Link copied"
                  : "Copy a link that reproduces exactly these settings"
              }
            >
              {copied ? <CheckIcon /> : <LinkIcon />}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-3 pb-3 border-b">
          <div>
            <label className={labelCls}>Analysis framing</label>
            <select
              value={analysisFraming}
              onChange={(e) => set("analysisFraming")(e.target.value)}
              className={selectCls}
            >
              <option value="exploratory">
                Exploratory (no efficacy claim)
              </option>
              <option value="confirmatory">Confirmatory</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Charts show</label>
            <select
              value={chartMetric}
              onChange={(e) => set("chartMetric")(e.target.value)}
              className={selectCls}
            >
              <option value="precision">Precision ({ciLevel}% CI ±)</option>
              <option value="mde">Min detectable effect</option>
            </select>
          </div>
          <div className="col-span-2 text-xs text-gray-500 flex items-center">
            {exploratory
              ? "No confirmatory claim, so no multiplicity adjustment is applied. Size the study on precision: the CI half-width does not depend on alpha or multiplicity at all."
              : "Confirmatory: arm-level multiplicity is applied to the active-vs-control family."}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <div>
            <label className={labelCls}>Design</label>
            <select
              value={designArms}
              onChange={(e) => set("designArms")(parseInt(e.target.value))}
              className={selectCls}
            >
              <option value={2}>2-arm (Treatment / Control)</option>
              <option value={3}>3-arm (Clin+Pt / Pt-only / Control)</option>
            </select>
          </div>

          {threeArm ? (
            <>
              <div>
                <label className={labelCls}>Randomization</label>
                <select
                  value={randomization}
                  onChange={(e) => set("randomization")(e.target.value)}
                  className={selectCls}
                >
                  <option value="hybrid">Hybrid (cluster + individual)</option>
                  <option value="cluster">Cluster only</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Allocation (A : B : C)</label>
                <div className="flex gap-1 mb-1">
                  {[
                    ["B.1", [1, 1, 1], "33/33/33 — even allocation"],
                    ["B.2", [2, 1, 1], "50/25/25 — measurement-protective"],
                    [
                      "B.3",
                      [4, 3, 3],
                      "40/30/30 — recommended: matches 45/27.5/27.5 on the binding contrast and beats it elsewhere",
                    ],
                  ].map(([name, w, hint]) => {
                    const active =
                      allocA === w[0] && allocB === w[1] && allocC === w[2];
                    return (
                      <button
                        key={name}
                        title={hint}
                        onClick={() =>
                          setSettings((prev) => ({
                            ...prev,
                            allocA: w[0],
                            allocB: w[1],
                            allocC: w[2],
                          }))
                        }
                        className={`px-2 py-0.5 text-xs rounded border ${
                          active
                            ? "bg-blue-600 text-white border-blue-600"
                            : "bg-white text-gray-600 hover:bg-gray-100"
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-1">
                  {[
                    ["allocA", allocA],
                    ["allocB", allocB],
                    ["allocC", allocC],
                  ].map(([key, val]) => (
                    <input
                      key={key}
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={val}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (v > 0) set(key)(v);
                      }}
                      className="w-full border rounded p-1.5 md:p-2 text-sm"
                    />
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>
                  Arm-level multiplicity
                  {exploratory && (
                    <span className="text-gray-400"> (not applied)</span>
                  )}
                </label>
                <select
                  value={multiplicity}
                  onChange={(e) => set("multiplicity")(e.target.value)}
                  className={selectCls}
                  disabled={exploratory}
                >
                  <option value="dunnett">Dunnett (active vs control)</option>
                  <option value="bonferroni">
                    Bonferroni (all {contrasts.length} pairwise)
                  </option>
                  <option value="none">None</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Contrast shown</label>
                <select
                  value={selectedContrast}
                  onChange={(e) => set("selectedContrast")(e.target.value)}
                  className={selectCls}
                >
                  {contrasts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.short} — {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div>
              <label className={labelCls}>Tx:Ctrl Ratio</label>
              <select
                value={treatmentRatio}
                onChange={(e) =>
                  set("treatmentRatio")(parseInt(e.target.value))
                }
                className={selectCls}
              >
                <option value={1}>1:1</option>
                <option value={2}>2:1</option>
                <option value={3}>3:1</option>
                <option value={4}>4:1</option>
              </select>
            </div>
          )}
        </div>

        {threeArm && randomization === "hybrid" && (
          <div className="mt-2 text-xs text-gray-600 bg-blue-50 rounded p-2">
            <span className="font-medium">Hybrid randomization:</span>{" "}
            clinicians are randomized to ROM vs no-ROM (
            {currentAlloc.groupClusters[0]} vs {currentAlloc.groupClusters[1]}),
            then patients inside no-ROM clinicians are individually randomized
            to app-only vs TAU. That makes{" "}
            <span className="font-medium">
              app-only vs TAU a within-clinician contrast
            </span>
            , so the between-clinician variance cancels from it — the reason the
            memo calls hybrid strictly superior. Assumes no spillover between
            app-only and TAU patients sharing a clinician, which is not modelled
            here.
          </div>
        )}
        <div className="mt-2 text-xs text-gray-500">
          Cluster split:{" "}
          <span className="font-medium text-gray-700">
            {threeArm && randomization === "hybrid"
              ? // Under hybrid, arms B and C occupy the SAME clinicians, so listing a
                // count per arm would imply more clinicians than exist. Report the
                // randomization units instead, then how each no-ROM panel divides.
                `ROM ${currentAlloc.groupClusters[0]} · no-ROM ${currentAlloc.groupClusters[1]}`
              : model.arms
                  .map((a, i) => `${a.label} ${currentAlloc.clusters[i]}`)
                  .join(" · ")}
          </span>{" "}
          ({currentAlloc.nClusters} clinicians
          {threeArm && randomization === "hybrid"
            ? `; each no-ROM panel splits ${Math.round(currentAlloc.armClusterSize[1] * 10) / 10} app-only / ${Math.round(currentAlloc.armClusterSize[2] * 10) / 10} TAU`
            : ""}
          ). Critical value for the shown contrast:{" "}
          <span className="font-medium text-gray-700">{critLabel}</span>.
          {threeArm && multiplicity === "dunnett" && (
            <>
              {" "}
              A-vs-B shares no control arm, so it sits outside the Dunnett
              family and is reported unadjusted and exploratory.
            </>
          )}
        </div>
      </div>

      {/* Parameter Controls */}
      <div className={cardCls}>
        <h2 className="font-semibold mb-3 text-sm md:text-base">Parameters</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <div>
            <label className={labelCls}>Power</label>
            <select
              value={power}
              onChange={(e) => set("power")(parseFloat(e.target.value))}
              className={selectCls}
            >
              <option value={0.7}>70%</option>
              <option value={0.75}>75%</option>
              <option value={0.8}>80%</option>
              <option value={0.85}>85%</option>
              <option value={0.9}>90%</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Alpha (per outcome)</label>
            <select
              value={alpha}
              onChange={(e) => set("alpha")(parseFloat(e.target.value))}
              className={selectCls}
            >
              <option value={0.05}>0.05 (none)</option>
              <option value={0.025}>0.025 (B-H across outcomes)</option>
              <option value={0.01}>0.01</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Clinicians</label>
            <select
              value={nClinicians}
              onChange={(e) => set("nClinicians")(parseInt(e.target.value))}
              className={selectCls}
            >
              <option value={60}>60</option>
              <option value={80}>80</option>
              <option value={90}>90</option>
              <option value={100}>100</option>
              <option value={110}>110</option>
              <option value={120}>120</option>
              <option value={140}>140</option>
              <option value={150}>150</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Patients/Clinician</label>
            <select
              value={patientsPerCluster}
              onChange={(e) =>
                set("patientsPerCluster")(parseInt(e.target.value))
              }
              className={selectCls}
            >
              <option value={5}>5</option>
              <option value={8}>8</option>
              <option value={10}>10</option>
              <option value={12}>12</option>
              <option value={15}>15</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Cluster Size Variation</label>
            <select
              value={clusterSizeCV}
              onChange={(e) => set("clusterSizeCV")(parseFloat(e.target.value))}
              className={selectCls}
            >
              <option value={0}>0 (equal)</option>
              <option value={0.2}>0.2 (low)</option>
              <option value={0.4}>0.4 (moderate)</option>
              <option value={0.6}>0.6 (high)</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Control Attrition</label>
            <select
              value={controlAttrition}
              onChange={(e) =>
                set("controlAttrition")(parseFloat(e.target.value))
              }
              className={selectCls}
            >
              <option value={0.2}>20%</option>
              <option value={0.25}>25%</option>
              <option value={0.3}>30%</option>
              <option value={0.35}>35%</option>
              <option value={0.4}>40%</option>
            </select>
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center text-xs md:text-sm text-gray-600">
              <input
                type="checkbox"
                checked={smallSampleT}
                onChange={(e) => set("smallSampleT")(e.target.checked)}
                className="mr-2 h-4 w-4"
              />
              Small-sample t correction
            </label>
          </div>
          <div className="text-xs text-gray-400 flex items-end pb-1">
            df = {model.dfFor(currentN)} (clusters − arms)
          </div>
        </div>
        {threeArm &&
          !exploratory &&
          multiplicity === "dunnett" &&
          randomization === "hybrid" && (
            <div className="mt-2 text-xs text-amber-700">
              Note: under hybrid randomization the Dunnett correlation structure
              is only approximate — app-only vs TAU is a within-clinician
              contrast with a smaller variance than clinician+patient vs TAU, so
              the true critical value is slightly higher than shown. Bonferroni
              is the conservative choice here.
            </div>
          )}
        {smallSampleT &&
          threeArm &&
          !exploratory &&
          multiplicity === "dunnett" && (
            <div className="mt-2 text-xs text-amber-700">
              Note: the t correction applies a univariate t at the Dunnett tail
              rather than the exact Dunnett multivariate-t quantile. Slightly
              conservative; the gap is small at these degrees of freedom.
            </div>
          )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mt-3 md:mt-4">
          <div>
            <label className={labelCls}>
              HAM-D Intracluster Corr: {iccHamd}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.10"
              step="0.01"
              value={iccHamd}
              onChange={(e) => set("iccHamd")(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className={labelCls}>HAM-D R²: {r2Hamd}</label>
            <input
              type="range"
              min="0.20"
              max="0.50"
              step="0.05"
              value={r2Hamd}
              onChange={(e) => set("r2Hamd")(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className={labelCls}>
              Retention Intracluster Corr: {iccRetention}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.10"
              step="0.01"
              value={iccRetention}
              onChange={(e) => set("iccRetention")(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className={labelCls}>Retention R²: {r2Retention}</label>
            <input
              type="range"
              min="0.00"
              max="0.20"
              step="0.02"
              value={r2Retention}
              onChange={(e) => set("r2Retention")(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className={labelCls}>
              Survival eff: {survivalEfficiency}×
            </label>
            <input
              type="range"
              min="1"
              max="5"
              step="0.5"
              value={survivalEfficiency}
              onChange={(e) =>
                set("survivalEfficiency")(parseFloat(e.target.value))
              }
              className="w-full"
            />
            <div className="text-xs text-gray-400 hidden sm:block">
              1× = binary, 4-5× = continuous monitoring
            </div>
          </div>
          <div>
            <label className={labelCls}>
              Assumed HAM-D effect: {assumedEffect} pts
            </label>
            <input
              type="range"
              min="0.5"
              max="5"
              step="0.25"
              value={assumedEffect}
              onChange={(e) => set("assumedEffect")(parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="text-xs text-gray-500">
              Power for {activeContrast.short}:{" "}
              <span
                className={`font-medium ${currentPower >= power ? "text-green-600" : "text-red-600"}`}
              >
                {(currentPower * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        </div>
        <div className="mt-2 text-xs text-gray-500">
          {exploratory ? (
            <>
              Exploratory framing: no efficacy claim, so no multiplicity
              adjustment is applied at either level. Alpha sets the confidence
              level ({ciLevel}% CI) rather than a significance threshold. The CI
              half-width is driven entirely by the standard error — changing
              alpha or the multiplicity rule does not change how precisely the
              effect is estimated, only what you could declare.
            </>
          ) : (
            <>
              Alpha is the per-outcome level; 0.025 reflects Benjamini-Hochberg
              adjustment across the three outcomes. Any arm-level adjustment is
              applied on top of it — these are two separate layers. All power
              figures are per-comparison.
            </>
          )}
        </div>
      </div>

      {/* Measurement Model Controls */}
      <div className={cardCls}>
        <h2 className="font-semibold mb-3 text-sm md:text-base">
          Measurement Model (HAM-D)
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-3 md:mb-4">
          {[
            ["sum", "Sum score"],
            ["rasch", "Rasch Partial Credit Model"],
            ["mfrm", "Multi-Facet Rasch Model"],
          ].map(([value, label]) => (
            <div className="flex items-center" key={value}>
              <input
                type="radio"
                id={`model-${value}`}
                name="measurementModel"
                value={value}
                checked={measurementModel === value}
                onChange={(e) => set("measurementModel")(e.target.value)}
                className="mr-2 h-4 w-4"
              />
              <label htmlFor={`model-${value}`} className="text-xs md:text-sm">
                {label}
              </label>
            </div>
          ))}
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
              <label className={labelCls}>
                Sum reliability: {sumScoreReliability}
              </label>
              <input
                type="range"
                min="0.80"
                max="0.92"
                step="0.01"
                value={sumScoreReliability}
                onChange={(e) =>
                  set("sumScoreReliability")(parseFloat(e.target.value))
                }
                className="w-full"
              />
            </div>
            <div>
              <label className={labelCls}>Rasch rel: {raschReliability}</label>
              <input
                type="range"
                min="0.85"
                max="0.95"
                step="0.01"
                value={raschReliability}
                onChange={(e) =>
                  set("raschReliability")(parseFloat(e.target.value))
                }
                className="w-full"
              />
            </div>
            <div>
              <label className={labelCls}>
                Rater var: {(raterVarianceProp * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0.03"
                max="0.15"
                step="0.01"
                value={raterVarianceProp}
                onChange={(e) =>
                  set("raterVarianceProp")(parseFloat(e.target.value))
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
      <div className={cardCls}>
        <h2 className="font-semibold mb-3 text-sm md:text-base">
          Intraclass Correlation Validation (arms{" "}
          {currentIcc.armKeys.join(" + ")})
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <div>
            <label className={labelCls}>
              Expected Intraclass Corr: {expectedIcc}
            </label>
            <input
              type="range"
              min="0.70"
              max="0.95"
              step="0.01"
              value={expectedIcc}
              onChange={(e) => set("expectedIcc")(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className={labelCls}>
              Target Intraclass Corr: {targetIcc}
            </label>
            <input
              type="range"
              min="0.60"
              max="0.80"
              step="0.05"
              value={targetIcc}
              onChange={(e) => set("targetIcc")(parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          <div>
            <label className={labelCls}>Follow-ups</label>
            <select
              value={nFollowups}
              onChange={(e) => set("nFollowups")(parseInt(e.target.value))}
              className={selectCls}
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
              <option value={6}>6</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>
              Cluster Intracluster Corr: {iccClusterCorr}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.10"
              step="0.01"
              value={iccClusterCorr}
              onChange={(e) =>
                set("iccClusterCorr")(parseFloat(e.target.value))
              }
              className="w-full"
            />
          </div>
        </div>
        <div className="mt-2 text-xs text-gray-500">
          Tests if AURORA-clinician agreement exceeds threshold for "good"
          reliability (intraclass correlation {">"} {targetIcc}).
          {threeArm
            ? " In the 3-arm design both the clinician+patient and patient-only arms generate AURORA scores alongside clinician ratings; arm-B clinicians simply do not see the output."
            : " Treatment arm only."}
        </div>
      </div>

      {/* Fairness / DIF substudy */}
      <div className={cardCls}>
        <h2 className="font-semibold mb-1 text-sm md:text-base">
          Measurement Fairness (arms {currentDif.armKeys.join(" + ")})
        </h2>
        <p className="text-xs text-gray-500 mb-3">
          Differential item functioning across subgroups. Only AURORA users
          produce item responses, so this draws on the same arms as the
          agreement substudy — and on all randomized patients, since DIF is
          assessed on baseline responses rather than follow-up pairs.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <div>
            <label className={labelCls}>
              Smallest subgroup: {(difSubgroupShare * 100).toFixed(0)}% of
              sample
            </label>
            <input
              type="range"
              min="0.05"
              max="0.5"
              step="0.01"
              value={difSubgroupShare}
              onChange={(e) =>
                set("difSubgroupShare")(parseFloat(e.target.value))
              }
              className="w-full"
            />
          </div>
          <div>
            <label className={labelCls}>Minimum N per group</label>
            <select
              value={difThresholdN}
              onChange={(e) => set("difThresholdN")(parseInt(e.target.value))}
              className={selectCls}
            >
              <option value={100}>100 (large DIF only)</option>
              <option value={150}>150</option>
              <option value={200}>200 (common minimum)</option>
              <option value={250}>250</option>
              <option value={300}>300 (conservative)</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>
              DIF to detect: {difTargetLogits} logits
            </label>
            <input
              type="range"
              min="0.1"
              max="1.5"
              step="0.01"
              value={difTargetLogits}
              onChange={(e) =>
                set("difTargetLogits")(parseFloat(e.target.value))
              }
              className="w-full"
            />
            <div className="text-xs text-gray-400">
              0.43 ≈ 1.0 ETS delta (negligible/moderate boundary)
            </div>
          </div>
          <div>
            <label className={labelCls}>Item information: {difItemInfo}</label>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={difItemInfo}
              onChange={(e) => set("difItemInfo")(parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="text-xs text-gray-400">
              0.25 is the ceiling for a dichotomous item (perfect targeting);
              HAM-D's partial-credit items carry more. Per item, not per test.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 md:gap-4 mt-3 pt-3 border-t text-xs md:text-sm">
          <div
            className={`p-2 md:p-3 rounded ${currentDif.adequate ? "bg-teal-50" : "bg-red-50"}`}
          >
            <div className="text-gray-500 text-xs">Smallest subgroup</div>
            <div
              className={`text-lg md:text-xl font-bold ${currentDif.adequate ? "text-teal-700" : "text-red-700"}`}
            >
              {currentDif.nFocal}
            </div>
            <div className="text-gray-500 text-xs">
              of {currentDif.nUsers} AURORA users
            </div>
          </div>
          <div className="bg-gray-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">Comparison group</div>
            <div className="text-lg md:text-xl font-bold text-gray-700">
              {currentDif.nReference}
            </div>
            <div className="text-gray-500 text-xs">remaining users</div>
          </div>
          <div className="bg-blue-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">DIF precision</div>
            <div className="text-lg md:text-xl font-bold text-blue-700">
              ±{currentDif.ciHalfWidth.toFixed(2)}
            </div>
            <div className="text-gray-500 text-xs">logits ({ciLevel}% CI)</div>
          </div>
          <div className="bg-purple-50 p-2 md:p-3 rounded">
            <div className="text-gray-500 text-xs">Smallest detectable DIF</div>
            <div className="text-lg md:text-xl font-bold text-purple-700">
              {currentDif.mde.toFixed(2)}
            </div>
            <div className="text-gray-500 text-xs">
              logits at {(power * 100).toFixed(0)}% power
            </div>
          </div>
          <div
            className={`p-2 md:p-3 rounded ${currentDif.power >= power ? "bg-green-50" : "bg-orange-50"}`}
          >
            <div className="text-gray-500 text-xs">
              Power at {difTargetLogits} logits
            </div>
            <div
              className={`text-lg md:text-xl font-bold ${currentDif.power >= power ? "text-green-700" : "text-orange-700"}`}
            >
              {(currentDif.power * 100).toFixed(0)}%
            </div>
            <div className="text-gray-500 text-xs">
              design effect {currentDif.designEffect.toFixed(2)}
            </div>
          </div>
        </div>

        <div className="mt-2 text-xs">
          {currentDif.adequate ? (
            <span className="text-teal-700">
              The smallest subgroup clears the {difThresholdN}-per-group
              minimum, so a DIF analysis on this dimension is supportable at N=
              {currentN.toLocaleString()}.
            </span>
          ) : (
            <span className="text-red-700">
              The smallest subgroup falls {currentDif.shortfall} short of the{" "}
              {difThresholdN}-per-group minimum. Reaching it on this dimension
              needs roughly N={currentDif.nRequired.toLocaleString()} overall
              {threeArm &&
                " (fewer if allocation is weighted toward the AURORA arms — try the 2:2:1 preset)"}
              , or a narrower fairness claim restricted to larger subgroups.
            </span>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4 md:gap-6 mb-4 md:mb-6">
        {/* HAM-D Chart */}
        <div className="bg-white rounded-lg shadow p-3 md:p-4">
          <h2 className="font-semibold mb-1 text-sm md:text-base">
            Depression Severity (HAM-D)
          </h2>
          <p className="text-xs text-gray-500 mb-1">
            {showPrecision
              ? `Precision: half-width of the ${ciLevel}% CI on the effect estimate`
              : `Minimum detectable effect at ${(power * 100).toFixed(0)}% power`}
          </p>
          {(useRasch || useMFRM) && (
            <p className="text-xs text-green-600 mb-2">
              Measurement optimization: -
              {currentHamd.varianceReduction?.toFixed(1)}% variance
            </p>
          )}
          <ResponsiveContainer
            width="100%"
            height={280}
            className="md:!h-[330px]"
          >
            <ComposedChart
              data={powerData}
              margin={{ bottom: 15, left: 0, right: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="n"
                ticks={xTicks}
                label={{
                  value: "Total N (patients)",
                  position: "bottom",
                  offset: 0,
                }}
              />
              <YAxis
                label={{
                  value: showPrecision
                    ? `${ciLevel}% CI half-width (HAM-D points)`
                    : "MDE (HAM-D points)",
                  angle: -90,
                  position: "insideLeft",
                  style: { textAnchor: "middle" },
                }}
                domain={[0, hamdMax]}
              />
              <Tooltip
                formatter={(value, name) => [value.toFixed(2) + " pts", name]}
                labelFormatter={(n) =>
                  `N = ${n} (${Math.round(n / patientsPerCluster)} clusters)`
                }
              />
              {(threeArm || useRasch || useMFRM) && (
                <Legend verticalAlign="top" height={28} iconSize={10} />
              )}
              {!showPrecision && (
                <Area
                  type="monotone"
                  dataKey={() => 3}
                  fill="#dcfce7"
                  stroke="none"
                  fillOpacity={0.5}
                  legendType="none"
                  tooltipType="none"
                />
              )}
              {!showPrecision && (
                <Area
                  type="monotone"
                  dataKey={() => 2}
                  fill="#bbf7d0"
                  stroke="none"
                  fillOpacity={0.5}
                  legendType="none"
                  tooltipType="none"
                />
              )}
              {(useRasch || useMFRM) && (
                <Line
                  type="monotone"
                  dataKey="hamdBaseline"
                  stroke={INK_MUTED}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  name="Sum score baseline"
                />
              )}
              {threeArm && (
                <Line
                  type="monotone"
                  dataKey="hamdTwoArm"
                  stroke={INK_SECONDARY}
                  strokeWidth={2}
                  strokeDasharray="10 4"
                  dot={false}
                  name={`2-arm (${treatmentRatio}:1) baseline`}
                />
              )}
              {chartContrasts.map((c) => (
                <Line
                  key={c.id}
                  type="monotone"
                  dataKey={`hamd_${c.id}`}
                  stroke={CONTRAST_COLORS[c.id]}
                  strokeWidth={2}
                  dot={false}
                  name={threeArm ? c.short : "MDE"}
                />
              ))}
              <ReferenceLine x={currentN} stroke="#666" strokeDasharray="5 5" />
              {showPrecision ? (
                // On a precision axis the MCID band is a category error: a CI half-width
                // is not an effect size. The useful reference is half the MCID - roughly
                // the precision at which a 2-point effect is distinguishable from null.
                <ReferenceLine
                  y={1}
                  stroke="#16a34a"
                  strokeDasharray="3 3"
                  label={{
                    value: "±1 pt",
                    position: "right",
                    fill: "#16a34a",
                    fontSize: 11,
                  }}
                />
              ) : (
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
              )}
              {!showPrecision && (
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
              )}
            </ComposedChart>
          </ResponsiveContainer>
          <div className="text-xs md:text-sm text-gray-600 mt-2">
            {showPrecision ? (
              <span>
                ±1 pt is roughly the precision needed to separate a 2-point
                (minimally important) effect from no effect.
              </span>
            ) : (
              <>
                <span className="inline-block w-3 h-3 bg-green-200 mr-1"></span>{" "}
                <span className="hidden sm:inline">
                  Minimally clinically important difference (2-3 points)
                </span>
                <span className="sm:hidden">Min Clinical Diff (2-3 pts)</span>
              </>
            )}
          </div>
        </div>

        {/* Retention Chart */}
        <div className="bg-white rounded-lg shadow p-3 md:p-4">
          <h2 className="font-semibold mb-1 text-sm md:text-base">
            Study Retention
          </h2>
          <p className="text-xs text-gray-500 mb-1">
            {showPrecision
              ? `Precision: half-width of the ${ciLevel}% CI`
              : `Minimum detectable effect at ${(power * 100).toFixed(0)}% power`}
          </p>
          <p className="text-xs text-gray-500 mb-2 md:mb-3">
            Survival analysis with {survivalEfficiency}× efficiency (binary MDE:{" "}
            {currentRetention.binaryMDE?.toFixed(1) || "N/A"} pp)
          </p>
          <ResponsiveContainer
            width="100%"
            height={280}
            className="md:!h-[330px]"
          >
            <ComposedChart
              data={powerData}
              margin={{ bottom: 15, left: 0, right: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="n"
                ticks={xTicks}
                label={{
                  value: "Total N (patients)",
                  position: "bottom",
                  offset: 0,
                }}
              />
              <YAxis
                label={{
                  value: showPrecision
                    ? `${ciLevel}% CI half-width (percentage points)`
                    : "MDE (percentage points)",
                  angle: -90,
                  position: "insideLeft",
                  style: { textAnchor: "middle" },
                }}
                domain={[0, retMax]}
              />
              <Tooltip
                formatter={(value, name) => [value.toFixed(2) + " pp", name]}
                labelFormatter={(n) =>
                  `N = ${n} (${Math.round(n / patientsPerCluster)} clusters)`
                }
              />
              {threeArm && (
                <Legend verticalAlign="top" height={28} iconSize={10} />
              )}
              {chartContrasts.map((c) => (
                <Line
                  key={c.id}
                  type="monotone"
                  dataKey={`ret_${c.id}`}
                  stroke={CONTRAST_COLORS[c.id]}
                  strokeWidth={2}
                  dot={false}
                  name={threeArm ? c.short : "MDE"}
                />
              ))}
              <ReferenceLine x={currentN} stroke="#666" strokeDasharray="5 5" />
              <ReferenceLine
                y={showPrecision ? 2.5 : 5}
                stroke="#f59e0b"
                strokeDasharray="3 3"
                label={{
                  value: showPrecision ? "±2.5 pp" : "5 pp",
                  position: "right",
                  fill: "#f59e0b",
                  fontSize: 11,
                }}
              />
              {!showPrecision && (
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
              )}
            </ComposedChart>
          </ResponsiveContainer>
          <div className="text-xs md:text-sm text-gray-600 mt-2">
            Control attrition: {(controlAttrition * 100).toFixed(0)}% →{" "}
            {activeContrast.short}:{" "}
            {(controlAttrition * 100 - currentRetention.mde).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* ICC Validation Chart */}
      <div className={cardCls}>
        <h2 className="font-semibold mb-1 text-sm md:text-base">
          Intraclass Correlation Validation (arms{" "}
          {currentIcc.armKeys.join(" + ")})
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
              ticks={xTicks}
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
              formatter={(value) => [value.toFixed(3), "CI half-width (±)"]}
              labelFormatter={(n) => {
                const iccVal = model.icc(n);
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
              dataKey="iccHalf"
              stroke="#0d9488"
              strokeWidth={2}
              dot={false}
              name="CI half-width"
            />
            <ReferenceLine x={currentN} stroke="#666" strokeDasharray="5 5" />
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
      <div className={cardCls}>
        <h2 className="font-semibold mb-3 text-sm md:text-base">
          Sample Size Requirements
        </h2>
        <div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0">
          <table className="w-full text-xs md:text-sm min-w-[500px] tabular-nums">
            <thead>
              <tr className="border-b">
                <th className="text-left p-1.5 md:p-2">N</th>
                <th className="text-left p-1.5 md:p-2 hidden sm:table-cell">
                  Clusters
                </th>
                {contrasts.map((c) => (
                  <th
                    key={c.id}
                    className="text-left p-1.5 md:p-2"
                    style={{ color: CONTRAST_COLORS[c.id] }}
                  >
                    {showPrecision ? "HAM-D ±" : "HAM-D"}{" "}
                    {threeArm ? c.short : ""}
                  </th>
                ))}
                {(useRasch || useMFRM) && (
                  <th className="text-left p-1.5 md:p-2 text-gray-400 hidden md:table-cell">
                    (Sum)
                  </th>
                )}
                <th className="text-left p-1.5 md:p-2">d</th>
                <th className="text-left p-1.5 md:p-2">
                  {showPrecision ? "Retention ±" : "Retention"}
                </th>
                <th className="text-left p-1.5 md:p-2 hidden sm:table-cell">
                  Tx Attrition
                </th>
                <th className="text-left p-1.5 md:p-2 hidden md:table-cell">
                  Intraclass Corr ±
                </th>
              </tr>
            </thead>
            <tbody>
              {nTable.map((n) => {
                const hamdSel = model.hamd(n, activeContrast);
                const retention = model.retention(n, activeContrast);
                const iccVal = model.icc(n);
                const isCurrentDesign = n === currentN;
                return (
                  <tr
                    key={n}
                    className={`border-b ${isCurrentDesign ? "bg-blue-50 font-semibold" : ""}`}
                  >
                    <td className="p-1.5 md:p-2">{n}</td>
                    <td className="p-1.5 md:p-2 hidden sm:table-cell">
                      {hamdSel.nClusters}
                    </td>
                    {contrasts.map((c) => (
                      <td key={c.id} className="p-1.5 md:p-2">
                        {showPrecision
                          ? model.hamd(n, c).ciHalfWidth.toFixed(2)
                          : model.hamd(n, c).mde.toFixed(2)}
                      </td>
                    ))}
                    {(useRasch || useMFRM) && (
                      <td className="p-1.5 md:p-2 text-gray-400 hidden md:table-cell">
                        {hamdSel.baselineMDE.toFixed(2)}
                      </td>
                    )}
                    <td className="p-1.5 md:p-2">
                      {hamdSel.effectSize.toFixed(2)}
                    </td>
                    <td className="p-1.5 md:p-2">
                      {showPrecision
                        ? retention.ciHalfWidth.toFixed(1)
                        : retention.mde.toFixed(1)}
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
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {threeArm && (
            <>
              HAM-D columns cover all three contrasts; d, Retention and
              Intraclass Corr are for the selected contrast (
              {activeContrast.short}). A-vs-B is both the least-powered contrast
              and the one where the true difference is likely smallest, so its
              MDE should not be read as a realistic target.{" "}
            </>
          )}
          {(useRasch || useMFRM) &&
            "Gray column shows MDE with traditional sum scoring for comparison."}
        </p>
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
                onClick={() => runRCode(rCode)}
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
              <code>{rCode}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
