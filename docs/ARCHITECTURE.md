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
       spatial clustering
              │
       ┌──────┴──────┐
       ▼             ▼
  3D workspace   module allocation
  scan selection  matrix / strip / single
                         │
                         ▼
              wiring + physical geometry
              order / corner / zigzag
              X / Y / width / height / rotation
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
        panel projection      modular grid
            SVG / CSV             MMFL
```

## Core decisions

- **Source order is stable.** Imported LED indices survive clustering, module allocation, projection, and export. A module always owns one contiguous source range, and ranges may not overlap.
- **Alignment is non-destructive.** A panel stores rotation, scale, and flip flags separately from its 3D points.
- **CSV recovery has explicit bounds and locally varying rows.** The first/last source indices define the default normalised scan range, and the user confirms the authoritative LED count before import. No leading pixels are invented; trailing pixels require an explicitly larger count. Repeated direction reversals nearest each missing pixel determine that region's serpentine row period. Row length is inferred independently of row count, so arbitrary square and rectangular matrices can coexist. Missing cells are predicted from corresponding columns in intact neighbouring rows and checked against local row spacing. Inferred points join the panel and export but never train row detection.
- **Allocation is physically constrained.** The UI derives all available choices from unassigned contiguous source-index ranges. A fixture is MMFL-ready only when every confirmed LED slot belongs to exactly one matrix, strip, or single-pixel module.
- **Module suggestions use the indexed scan path.** Regular large return jumps group row-major matrices; close direction reversals identify serpentine row periods; unmatched runs remain strips. Suggestions cover every confirmed slot exactly once, open directly in the MMFL preview, and remain fully editable.
- **CSV index origin is explicit.** A scan beginning above index 0 can retain its original leading slots instead of silently renumbering every measurement. The import dialog shows the resulting minimum physical slot count and exact internal gaps before applying it.
- **Wiring is scan-assisted, not imposed.** Assigned scan ranges are inspected for serpentine row periods and likely start corners. Row/column flow, start corner, and zigzag remain explicit module properties that the user can override.
- **Unused physical LEDs reserve their address.** A hidden LED remains a module cell and a source index. MMFL writes that grid cell as `0`, while later visible cells use `1 + sourceIndex × channelCount`; therefore the hidden LED still reserves its wiring and channel offset.
- **3D becomes local 2D.** Principal component analysis derives a best-fit plane for each panel. MadMapper exports use coordinates on that plane.
- **The MMFL preview is export-exact.** Each module applies its own X/Y position, width, height, rotation, start corner, traversal direction, and zigzag rule before coordinates are rounded to grid cells. Preview and exporter share this function. Collisions and incomplete allocation block MMFL export.
- **DMX packing is deterministic.** Fixture instances are sorted by source index and roll to a new universe before crossing channel 512.
- **Language is presentation state.** Internal diagnostic codes remain language-neutral and are translated at the UI boundary.

## Main modules

The compact application currently lives in `app/page.tsx`:

- input parsers normalise Pixelblaze and Marimapper data;
- spatial analysis finds connected LED panels and flags placeholders/outliers;
- canvas components render the 3D scan, legacy panel projection, and modular MMFL builder;
- export builders generate MadMapper SVG, CSV, and MMFL text;
- the page component owns workflow state and English/German presentation.

As the project grows, these boundaries are natural candidates for extraction into `lib/` modules with unit tests.
