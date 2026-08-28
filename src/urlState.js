// Reversible encoding of the calculator configuration into a single URL token, so any
// state can be linked to and restored exactly.
//
// The token lists EVERY setting positionally rather than storing a diff. That makes a
// link mean one fixed configuration forever: changing an app default later cannot
// re-interpret a link shared before the change, because the link names every value it
// depends on. (A diff-against-defaults scheme would need a frozen baseline to get the
// same guarantee, which is more machinery for a shorter string.)
//
// Format:  1_<v0>_<v1>_...   e.g. "1_0_0_3_3_1_1_1_0_1_0_2_0.8_0.05_10_100_0.2_..."
//   - leading "1" is the format version
//   - enums encode as their index, booleans as 0/1, numbers verbatim
//   - values appear in FIELD_ORDER, which is APPEND-ONLY: never insert or reorder,
//     or every previously shared link silently changes meaning
//
// Token contents are untrusted input. Every value is range- and type-checked before it
// reaches the model; anything invalid falls back to that setting's default. This is not
// decorative - normInv() throws outside (0,1), so an edited "power" would otherwise
// blank the page.

import { defaults } from "./defaults.js";
import { parseRoster } from "./sites.js";

export const TOKEN_PARAM = "c";
const VERSION = "1";
// "_" is unreserved AND left alone by URLSearchParams serialisation. "~" is unreserved
// per RFC 3986 but URLSearchParams still percent-encodes it to %7E, which would more
// than double the visible length of every link.
const SEP = "_";

export const SETTING_SPEC = {
  analysisFraming: {
    type: "enum",
    values: ["exploratory", "confirmatory"],
  },
  chartMetric: { type: "enum", values: ["precision", "mde"] },
  designArms: { type: "int", min: 2, max: 3 },
  treatmentRatio: { type: "number", min: 0.1, max: 20 },
  allocA: { type: "number", min: 0.01, max: 100 },
  allocB: { type: "number", min: 0.01, max: 100 },
  allocC: { type: "number", min: 0.01, max: 100 },
  multiplicity: {
    type: "enum",
    values: ["dunnett", "bonferroni", "none"],
  },
  smallSampleT: { type: "bool" },
  selectedContrast: { type: "enum", values: ["AC", "BC", "AB", "PC"] },
  assumedEffect: { type: "number", min: 0, max: 50 },
  // Bounded strictly inside (0,1): normInv throws at the endpoints.
  power: { type: "number", min: 0.01, max: 0.999 },
  alpha: { type: "number", min: 0.0001, max: 0.5 },
  patientsPerCluster: { type: "int", min: 1, max: 1000 },
  nClinicians: { type: "int", min: 2, max: 100000 },
  clusterSizeCV: { type: "number", min: 0, max: 5 },
  controlAttrition: { type: "number", min: 0, max: 0.95 },
  iccHamd: { type: "number", min: 0, max: 0.99 },
  iccRetention: { type: "number", min: 0, max: 0.99 },
  r2Hamd: { type: "number", min: 0, max: 0.99 },
  r2Retention: { type: "number", min: 0, max: 0.99 },
  survivalEfficiency: { type: "number", min: 0.01, max: 50 },
  measurementModel: { type: "enum", values: ["sum", "rasch", "mfrm"] },
  sumScoreReliability: { type: "number", min: 0.01, max: 0.999 },
  raschReliability: { type: "number", min: 0.01, max: 0.999 },
  raterVarianceProp: { type: "number", min: 0, max: 0.99 },
  targetIcc: { type: "number", min: 0, max: 0.99 },
  expectedIcc: { type: "number", min: 0, max: 0.99 },
  iccClusterCorr: { type: "number", min: 0, max: 0.99 },
  nFollowups: { type: "int", min: 1, max: 100 },
  // Appended after the initial release - see the append-only note below.
  difSubgroupShare: { type: "number", min: 0.01, max: 0.5 },
  difThresholdN: { type: "int", min: 10, max: 100000 },
  difTargetLogits: { type: "number", min: 0.01, max: 5 },
  difItemInfo: { type: "number", min: 0.01, max: 5 },
  randomization: { type: "enum", values: ["cluster", "hybrid"] },
  mixedShare: { type: "number", min: 0, max: 0.6 },
  // Free-form, so it needs a pattern as well as a length bound. "." and "-" both survive
  // URLSearchParams untouched, which is why the roster uses them as separators.
  // Validated by the roster parser itself rather than by a pattern here, so the codec
  // and the model cannot disagree about what counts as a valid roster. The parser also
  // enforces what a regex cannot: every site needs at least as many patients as
  // clinicians.
  siteRoster: { type: "string", maxLength: 400, validate: parseRoster },
  spilloverPreset: { type: "number", min: 0.01, max: 0.6 },
};

// APPEND-ONLY. Adding a setting means pushing it onto the end; older (shorter) tokens
// then simply omit it and it falls back to its default, which is the correct reading -
// those links genuinely did not specify it.
export const FIELD_ORDER = Object.keys(SETTING_SPEC);

// --- value <-> string --------------------------------------------------------

function encodeValue(spec, value) {
  switch (spec.type) {
    case "string":
      return typeof value === "string" ? value : "";
    case "enum": {
      const i = spec.values.indexOf(value);
      return i < 0 ? "" : String(i);
    }
    case "bool":
      return value ? "1" : "0";
    default:
      return String(value);
  }
}

// Returns the decoded value, or undefined if it fails validation.
function decodeValue(spec, raw) {
  if (raw === undefined || raw === "") return undefined;
  switch (spec.type) {
    case "enum": {
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= spec.values.length)
        return undefined;
      return spec.values[i];
    }
    case "bool":
      if (raw === "1") return true;
      if (raw === "0") return false;
      return undefined;
    case "int":
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      if (spec.type === "int" && !Number.isInteger(n)) return undefined;
      if (n < spec.min || n > spec.max) return undefined;
      return n;
    }
    case "string": {
      if (typeof raw !== "string") return undefined;
      if (spec.maxLength && raw.length > spec.maxLength) return undefined;
      if (spec.validate && spec.validate(raw) === null) return undefined;
      return raw;
    }
    default:
      return undefined;
  }
}

// --- encode / decode ---------------------------------------------------------

/** Encode a full settings object into a URL token. */
export function encodeSettings(settings) {
  const parts = FIELD_ORDER.map((key) =>
    encodeValue(SETTING_SPEC[key], settings[key]),
  );
  return [VERSION, ...parts].join(SEP);
}

/**
 * Decode a token back into a complete settings object. Unknown versions, malformed
 * tokens, missing trailing fields and out-of-range values all degrade gracefully to
 * the corresponding default rather than throwing.
 */
export function decodeSettings(token, base = defaults) {
  const result = { ...base };
  if (!token || typeof token !== "string") return result;

  const parts = token.split(SEP);
  if (parts.shift() !== VERSION) return result;

  FIELD_ORDER.forEach((key, i) => {
    const value = decodeValue(SETTING_SPEC[key], parts[i]);
    if (value !== undefined) result[key] = value;
  });
  return result;
}

// --- browser helpers ---------------------------------------------------------

export function readTokenFromLocation(search) {
  try {
    const params = new URLSearchParams(
      search !== undefined ? search : window.location.search,
    );
    return params.get(TOKEN_PARAM) || "";
  } catch (e) {
    return "";
  }
}

export function shareableUrl(settings, href) {
  const base =
    href !== undefined
      ? href
      : typeof window !== "undefined"
        ? window.location.href
        : "";
  if (!base) return "";
  const url = new URL(base);
  url.searchParams.set(TOKEN_PARAM, encodeSettings(settings));
  return url.toString();
}

/**
 * Reflect the current settings in the address bar. Uses replaceState so that dragging a
 * slider does not push hundreds of entries onto the back stack.
 */
export function syncLocation(settings) {
  if (typeof window === "undefined" || !window.history?.replaceState) return "";
  const next = shareableUrl(settings);
  if (next && next !== window.location.href) {
    window.history.replaceState(null, "", next);
  }
  return next;
}
