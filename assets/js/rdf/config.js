// Centralized constants for the RDF/SPARQL layer (no DOM/UI imports).

// Content types
export const MIME_TTL = "text/turtle";

// Base IRIs / prefixes
export const BASE_ONTO = "https://w3id.org/OntoGSN/ontology#";
export const BASE_CASE = "https://w3id.org/OntoGSN/cases/ACT-FAST-robust-llm#";
export const BASE_CAR  = "https://example.org/car-demo#";
export const BASE_CODE = "https://example.org/python-code#";

// Paths to data files
export const PATHS = {
  // Ontologies
  onto    : "/assets/data/ontologies/ontogsn_lite.ttl",
  example : "/assets/data/ontologies/example_ac.ttl",
  car     : "/assets/data/ontologies/car.ttl",
  code    : "/assets/data/ontologies/example_python_code.ttl",

  // Base queries
  q: {
    nodes          : "/assets/data/queries/read_all_nodes.sparql",
    rels           : "/assets/data/queries/read_all_relations.sparql",
    visualize      : "/assets/data/queries/visualize_graph.sparql",
    propCtx        : "/assets/data/queries/propagate_context.sparql",
    propDef        : "/assets/data/queries/propagate_defeater.sparql",
    listModules    : "/assets/data/queries/list_modules.sparql",
    visualizeByMod : "/assets/data/queries/visualize_graph_by_module.sparql",
  },
};

// Convenience: ordered datasets for load loops in store.js
export const DATASETS = [
  { path: PATHS.onto,    base: BASE_ONTO },
  { path: PATHS.example, base: BASE_CASE },
  { path: PATHS.car,     base: BASE_CAR  },
  { path: PATHS.code,    base: BASE_CODE },
];
