# OntoGSN Workbench 
*Ontology-based framework for semantic management and extension of assurance cases*

![Screenshot showing two interface views: a Markdown document view on the left detailing an assurance case, and a 3D interactive car model view on the right highlighting vehicle parts and displaying roof load status.](assets/images/interface_docVSmodel.PNG "Interface, document view (left pane) and model view (right pane).")

![Screenshot showing two interface views: a scrollable table displaying GSN node details (ID, type, statement) on the left, and a graph visualization of an OntoGSN assurance case with interconnected nodes and edges on the right.](assets/images/interface_tableVSgraph.PNG "Interface, table view (left pane) and graph view (right pane).")

This is the client-side OntoGSN workbench for visualizing, interacting and building on Goal Structuring Notation (GSN v3) assurance cases. The interface has two facets:
1. a **prototypical app** for users to explore complex arguments, view underlying data in different ways, and dynamically integrate domain ontologies;
2. an **open sandbox** for developers to test and extend what is possible with assurance cases and related artifacts (e.g., models, documents, code, etc.).

The interface leverages an in-browser RDF triple store via Oxigraph to load and query ontologies, visualizing them as interactive 2D graphs (using D3.js) and 3D models (using Three.js).

## Table of Contents
```
- Folder Structure
- How to Use this
- Core functionalities
- Data interaction flow
```

## Folder Structure

```
.
└───assets
    ├───css
    ├───data
    │   ├───ontologies
    │   └───queries
    └───js
```

## How to Use This

If you just want to see how the interface works, check out our [OntoGSN Playground](https://fortiss.github.io/OntoGSN/playground/) from your browser, preferably on the PC. Mobile devices are currently not supported.

For more advanced use cases, follow the instructions below.

#### >> Note for less technical users

The current version of the interface is **not yet** easy to deploy or extend for users who are not comfortable with coding. 

However, we may change this in the future, and will be happy to support less technical users (e.g., *assurance engineers*) who would nonetheless like to contribute in the meantime. If you fit that description, please reach out to me via `momcilovic [at] fortiss [dot] org`.


### Deploy locally

To deploy this application locally, you need to clone this repository and serve the `index.html` file using a local web server. 

Steps using Python[¹](#footnote-id) from your terminal:

1. Clone this repository with `git`[²](#footnote-id).
```bash
git clone https://github.com/Tomas-Bueno-Momcilovic/html_ontogsn_test.git path/ontogsn_sandbox
```

2. Navigate to the folder with the cloned repo.

```bash
cd path/ontogsn_sandbox
```

3. Start your HTTP server on your chosen port (default: `8000`).

```bash
python -m http.server 8000
```

4. Open your web browser and navigate to `http://localhost:8000` (or the port you specified).

### Customize the data

To use the web app with your data [³](#footnote-id), follow the steps below:
1. Create your GSN assurance case as an ontology.
2. Create (or reuse) your domain ontologies, and add hooks to your assurance case.
3. Save the ontologies as `.ttl` (Turtle) files and place them in `./assets/data/ontologies/`.
4. Open `queries.js` and add your ontology prefixes and paths following the syntax below.
```js
// PREFIXES
// --OntoGSN prefix (KEEP THIS)
const BASE_ONTO = "https://w3id.org/OntoGSN/ontology#";
// --Assurance case prefix (REPLACE THIS)
const BASE_CASE = "https://w3id.org/OntoGSN/cases/ACT-FAST-robust-llm#";
// --Domain ontology prefix (REPLACE THIS)
const BASE_CAR  = "https://example.org/car-demo#";

// FILE PATHS
const PATHS = {
  // --OntoGSN path (KEEP THIS)
  onto    : "/assets/data/ontologies/ontogsn_lite.ttl",
  // --Assurance case path (REPLACE THIS)
  example : "/assets/data/ontologies/example_ac.ttl",
  // --Domain ontology path (REPLACE THIS)
  car     : "/assets/data/ontologies/car.ttl",
  // ...
```
5. Add these variable names to appropriate sections of the `_loadTTL()` function definition. 
- **Note:** *remove `${BASE_PATH}` if your path references are absolute, i.e., they are not relative to the root of this repo!*
```js
  async _loadTTL() {
    // OntoGSN path var (KEEP THIS)
    const ontoURL    = `${BASE_PATH}${PATHS.onto}`;
    // Assurance case path var (REPLACE IF NOT example)
    const exampleURL = `${BASE_PATH}${PATHS.example}`;
    // Domain ontology path var (REPLACE IF NOT car)
    const carURL     = `${BASE_PATH}${PATHS.car}`;

    const [ttlOnto, ttlExample, ttlCar] = await Promise.all([getTTL(ontoURL), getTTL(exampleURL), getTTL(carURL),]);
    try {
      // OntoGSN prefix var (KEEP THIS)
      this.store.load(ttlOnto, MIME_TTL, BASE_ONTO);
      // Assurance case prefix var (REPLACE IF NOT BASE_CASE)
      this.store.load(ttlExample, MIME_TTL, BASE_CASE);
      // Domain ontology prefix var (REPLACE THIS)
      this.store.load(ttlCar,     MIME_TTL, BASE_CAR);
    } catch (e) {
      //...
    }
```

### Extend and test (WORK IN PROGRESS)
This interface is relatively easy to extend and run in a sandbox environment. To do so, you can follow the best practices we identified below.
1. Create a single-view, unidirectional and self-contained JavaScript file (or sets of files).

| Property       | Our suggestion                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| single-view    | Keep each view limited to one "page" that is easy to put and read in one vertical half of a standard laptop screen with HD resolution (1280×720).                                                                                                                                                                     |
| unidirectional | Reuse the functionalities provided by `queries.js` and `graph.js`, and/or duplicate and modify existing panes (e.g., `model.js`), but do not change or extend the functionalities in existing files. If you believe that your functionality would be a good contribution to the interface hosted by us, get in touch. |
| self-contained | Make sure all (additional) needed utility functions and code dependencies are either available from an online source (e.g., JS packages hosted online), or . At the moment, we cannot predict if anything that depends on external components won't affect the existing functionalities.                              |


2. Pipe the view into the left or right pane.
3. Add the call to the script from `index.html`.


### Footnotes

<a name="footnote-id"></a>
¹ *Make sure you install Python version 3.12 or higher for your chosen operating system (e.g., Windows) from [python.org](https://www.python.org/downloads/).*

² *If you're new to `git`, I recommend downloading and installing Github Desktop from *[github.com](https://docs.github.com/en/desktop/installing-and-authenticating-to-github-desktop/installing-github-desktop)*, and following the steps in their [documentation](https://docs.github.com/en/desktop/adding-and-cloning-repositories/cloning-a-repository-from-github-to-github-desktop).*

³ *You can also replace or extend the content of the example `.ttl` files without changing anything in the `queries.js`. However, we recommend adapting the names of files and variables for readability purposes.*

⁴ *You are free to use an LLM to help with the extension. We have had a positive experience with ChatGPT 5/5.1 in "Extended Thinking" mode (as of November 2025).*

## Core Functionalities

The application's logic is modularized into several JavaScript files, each responsible for a distinct piece of functionality.

### `index.html`
The main entry point of the application. It defines the UI layout, including buttons for triggering actions, panes for displaying results, and placeholders for graph and model visualizations. It loads all necessary JavaScript modules and external libraries like D3.js, Three.js, and N3.js.

### Data & Querying (`/assets/js/model.js` & `/assets/js/queries.js`)

-   **`model.js`**: This is the data core of the application. It initializes an `oxigraph` WebAssembly-based RDF store in the browser. Its primary role is to fetch and load RDF data from Turtle (`.ttl`) files located in `/assets/data/ontologies/`. It exposes methods to perform SPARQL SELECT and UPDATE queries on the loaded data.
-   **`queries.js`**: Acts as the main application controller. It orchestrates the interactions between the UI, the data model, and the visualizations.
    -   It attaches event listeners to UI elements (like buttons and checkboxes) defined in `index.html`.
    -   When a user clicks a button, it fetches the corresponding SPARQL query from the `/assets/data/queries/` directory.
    -   It executes the query using `model.js` and processes the results.
    -   Based on the query result, it can either render data into an HTML table, trigger a graph visualization, or apply an overlay to an existing graph.

### Visualization (`/assets/js/graph.js`, `/assets/js/layers.js`, `/assets/js/model.js`)

-   **`graph.js`**: Responsible for rendering the primary 2D GSN graph. It takes SPARQL query results (containing `?s ?p ?o` bindings) and uses the D3.js library to create a force-directed graph. It correctly styles nodes based on their GSN type (Goal, Strategy, Solution, etc.) and renders different types of relationships (e.g., `supportedBy`, `inContextOf`).
-   **`layers.js`**: Implements an alternative "Layered View" or "Swimlane" visualization. It organizes nodes into vertical lanes based on their depth and relationships in the argument structure, which can be useful for understanding the flow of an argument.
-   **`model.js`**: This script handles the 3D visualization, specifically for the "Model View" which displays a 3D car. It uses Three.js to construct and render a 3D scene from geometric parameters defined in the `car.ttl` ontology. It also manages user interactions like clicking on car parts and dynamically updating the scene based on SPARQL UPDATE queries (e.g., showing or hiding luggage on the roof).

### UI & Interaction (`/assets/js/panes.js`, `/assets/js/editor.js`, `/assets/js/document.js`)

-   **`panes.js`**: A simple UI manager that controls the content of the left and right panes. It handles the lifecycle (creation, destruction) of the controllers for the different views (graph, model, layers).
-   **`editor.js`**: Provides a simple form-based editor to create new GSN elements. It uses a SPARQL `INSERT` template (`create_gsn_element.sparql`) and populates it with user-provided data to add new nodes to the graph.
-   **`document.js`**: Manages the "Document" view. It fetches and renders Markdown files (e.g., `report.md`). A key feature is its ability to parse special links within the Markdown (e.g., `$roof-rack`) and turn them into interactive elements that query the ontology to display tooltips with details about the referenced entity.

## Data Interaction Flow

The interaction between the JavaScript files and the data assets is central to the application:

1.  **Loading**: On startup, `model.js` loads the ontology schemas and instance data from `.ttl` files (e.g., `ontogsn_lite.ttl`, `example_ac.ttl`, `car.ttl`) into the Oxigraph store.

2.  **Reading & Visualization**:
    -   A user clicks the "Tree View" button.
    -   `queries.js` detects the click, fetches `/assets/data/queries/visualize_graph.sparql`.
    -   The SPARQL query is executed by `model.js` against the in-memory RDF data.
    -   The results (a list of subject-predicate-object triples) are passed to `graph.js`.
    -   `graph.js` uses D3.js to render the nodes and links, creating the interactive GSN graph.

3.  **Dynamic Updates**:
    -   A user checks the "Overloaded car" rule checkbox.
    -   `queries.js` detects the change and executes a chain of SPARQL queries.
    -   `propagate_overloadedCar.sparql` and `write_defeater_overloadedCar.sparql` are executed. These are `INSERT` queries that add new triples to the graph, including a new `gsn:Defeater` node that challenges a goal.
    -   The visualization is updated to show the new "defeated" state, demonstrating the system's ability to react to dynamic changes in the underlying data.
    -   The 3D car model in `model.js` is also updated to visually highlight the overloaded parts.

4.  **Content Integration**:
    -   A user clicks the "Document" tab.
    -   `document.js` executes `read_document.sparql` to find the path to the relevant Markdown file.
    -   It then fetches and renders `report.md`, creating a bridge between the formal GSN graph and its narrative description.
