# CSS Stylesheets

This directory contains the stylesheets for the OntoGSN Playground application.

| File | Purpose | Styled Elements and Variables |
| :--- | :--- | :--- |
| `graph.css` | Provides all styles for the GSN graph visualizations, including nodes, links, the legend, and interaction states. It uses a comprehensive set of CSS variables to allow for easy theming (e.g., light and dark modes). | **Variables**: `--bg`, `--text`, `--node-fill`, `--link`, `--def`, `--highlight-stroke`, `--highlight-fill`, `--badge-border`, `--btn-bg`, `--radius-md`, `--pad-sm`, `--stroke-thin`, and more for colors, sizes, and fonts.<br>**Theme**: `[data-theme="dark"]`<br>**Layout**: `.gsn-host`, `.gsn-legend`, `.gsn-legend-item`, `.gsn-controls`, `.gsn-btn`<br>**Graph Elements**: `.gsn-svg`, `.gsn-link`, `.gsn-node`, `.gsn-marker`<br>**Node Modifiers**: `.gsn-node.ctx`, `.gsn-node.def`, `.gsn-node.valid`, `.gsn-node.invalid`, `.gsn-node.in-context`, `.gsn-node.collection`<br>**Link Modifiers**: `.gsn-link.ctx`, `.gsn-link.def`, `.gsn-link.valid`, `.gsn-link.invalid` |
| `app.css` | Defines the main layout and component styles for the application shell. It handles the two-pane structure, tabs, buttons, SPARQL results tables, and the module selection bar. | **Base**: `body`, `h1`, `button`<br>**Layout**: `.split`, `#leftPane`, `#rightPane`, `.panes`<br>**Components**: `table.sparql`, `#results`, `#out`, `.tabs`, `.tab`, `.modules-bar`, `.doc-entity-tooltip`<br>**States**: `button:hover`, `.tab.active`, `body[aria-busy="true"]` |
