# Architecture

Pixel Fixture Studio is a single-page, local-first React application. Mapping files are read with the browser `File` API and are never sent to a server.

## Data flow

```text
Pixelblaze JSON / Marimapper CSV
              │
              ▼
       normalised Vec3 slots
              │
              ▼
  spatial clustering + pixel editor
              │
       ┌──────┴──────┐
       ▼             ▼
  3D workspace   panel collection
  click/search      │
  move/insert       │
                         │
                         ▼
              best-fit plane projection
                         │
              rotate / snap / scale / flip
                         │
                         ▼
                  SVG / CSV / MMFL
```

## Core decisions

- **Source order is stable by default.** Imported LED indices survive clustering, selection, repair, projection, and export. Explicit insertion is the one intentional exception: it creates a new slot and shifts following indices.
- **Alignment is non-destructive.** A panel stores rotation, scale, and flip flags separately from its 3D points.
- **Missing CSV slots are recovered automatically.** Sparse indices and blank coordinate rows are placed from average panel spacing, the matrix/zigzag model, and up to four previous/four following measured readings. Inferred points join the panel and export but never train the model.
- **Measured repairs are opt-in.** Scanned coordinates are protected by default. Outlier review must be enabled explicitly and only suggests deviations over the selected threshold; coordinates change only after approval.
- **3D becomes local 2D.** Principal component analysis derives a best-fit plane for each panel. MadMapper exports use coordinates on that plane.
- **The MMFL preview is export-exact.** The transparent 2D cell overlay and MMFL generator share one quantisation function, so empty preview cells match exported zeros.
- **DMX packing is deterministic.** Fixture instances are sorted by source index and roll to a new universe before crossing channel 512.
- **Language is presentation state.** Internal diagnostic codes remain language-neutral and are translated at the UI boundary.

## Main modules

The compact application currently lives in `app/page.tsx`:

- input parsers normalise Pixelblaze and Marimapper data;
- spatial analysis finds connected LED panels and flags placeholders/outliers;
- canvas components render the 3D, 2D, and repair-review workspaces;
- export builders generate MadMapper SVG, CSV, and MMFL text;
- the page component owns workflow state and English/German presentation.

As the project grows, these boundaries are natural candidates for extraction into `lib/` modules with unit tests.
