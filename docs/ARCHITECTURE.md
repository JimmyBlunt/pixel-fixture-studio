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
  spatial clustering + diagnostics
              │
       ┌──────┴──────┐
       ▼             ▼
  3D workspace   panel collection
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

- **Source indices are stable.** Imported LED indices survive clustering, selection, repair, projection, and export.
- **Alignment is non-destructive.** A panel stores rotation, scale, and flip flags separately from its 3D points.
- **Repairs require confirmation.** Analysis generates suggestions with a reason and confidence; coordinates change only after explicit approval.
- **3D becomes local 2D.** Principal component analysis derives a best-fit plane for each panel. MadMapper exports use coordinates on that plane.
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
