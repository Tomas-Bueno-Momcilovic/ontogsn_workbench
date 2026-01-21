export const ORC_ONTO_BASE = new URL("./ontos", import.meta.url).href.replace(/\/$/, "");

export const ORC_ONTOLOGIES = [
  "tap.ttl",
  "tapGuardianSelection.ttl",
  "testCaseGuardianClassification.ttl",
  "harmbench_targets_text.ttl",
  "graniteGuardian.ttl",
];

export function getOrchestratorOntologyUrls({ base } = {}) {
  const resolvedBase = (base ?? ORC_ONTO_BASE);
  const b = String(resolvedBase || "").replace(/\/$/, "");
  return ORC_ONTOLOGIES.map(f => `${b}/${f}`);
}
