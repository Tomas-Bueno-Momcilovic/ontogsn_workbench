# Model Pane

Interactive 3D “car demo” pane (Three.js) used to showcase ontology-driven UI behavior in OntoGSN. Renders a clickable car model, syncs roof-load toggles with SPARQL updates, and highlights overloaded parts based on rule propagation.

![alt text](image.png)

## Features
- Three.js orthographic scene + OrbitControls
- Click parts to show label + IRI
- Toggle roof `Box` / `Luggage` → runs SPARQL UPDATEs
- Overload rule integration via `car:overloadChanged` (warning bar + part highlighting)
- Reads live load weights (current / max) from the RDF store

## Data & queries
- TTL source: `data/ontologies/car.ttl`
- Updates: `update_box_on/off.sparql`, `update_luggage_on/off.sparql`
- Rules: `propagate_overloadedCar.sparql`
- Metrics: `read_carLoadWeight.sparql`

## Exports
- Pane lifecycle: `mount`, `resume`, `suspend`, `unmount`
- Renderer: `renderModelView({ mount, height })`
