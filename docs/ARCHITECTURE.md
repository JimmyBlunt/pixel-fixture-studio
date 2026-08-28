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
- **CSV recovery has explicit bounds and locally varying rows.** The first/last source indices define the default normalised scan range, and the user confirms the authoritative LED count before import. No leading pixels are invented; trailing pixels require an explicitly larger count. Repeated direction reversals nearest each missing pixel determine that region's serpentine row period. Row length is inferred independently of row count, so arbitrary square and rectangular matrices can coexist. Missing cells are predicted from corresponding columns in intact neighbouring rows and checked against local row spacing. Inferred points join the panel and export but never train row detection.
- **Repair is origin-aware and conservative.** Inferred, inserted, and manually moved points remain distinguishable from measured scan data. Generated points can be reviewed against the nearest supported model. Measured coordinates are protected by default and require explicit opt-in plus agreement between a clean four-neighbour 3D line fit and the wider neighbourhood. Curves, normal scan noise, and row turns are rejected; nothing is preselected.
- **3D becomes local 2D.** Principal component analysis derives a best-fit plane for each panel. MadMapper exports use coordinates on that plane.
- **The MMFL preview is export-exact, compact, and collision-free.** The transparent 2D cell overlay and MMFL generator share one quantisation function. Its pitch is reduced when mixed physical spacings would round multiple LEDs into one cell; a deterministic nearest-free fallback guarantees one cell per LED. Globally empty rows and columns are removed before the user's spacing scale is applied, so compacting never cancels the 2D size control.
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
