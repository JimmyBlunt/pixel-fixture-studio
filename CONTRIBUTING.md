# Contributing to Pixel Fixture Studio

Thanks for helping improve the workflow for irregular LED installations.

## Before you start

1. Search existing issues for the same device, import format, or MadMapper behaviour.
2. For larger changes, open a feature request describing the workflow and expected export.
3. Do not publish private installation coordinates without the owner's permission. Prefer a reduced or synthetic sample map.

## Development setup

```bash
git clone https://github.com/JimmyBlunt/pixel-fixture-studio.git
cd pixel-fixture-studio
pnpm install
pnpm dev
```

Create a focused branch such as `fix/csv-index-order` or `feature/new-export-format`.

## Code guidelines

- Keep browser processing local-first; do not add uploads or analytics without an explicit design discussion.
- Preserve source LED indices and original 3D measurements unless the user confirms a repair.
- Add visible UI copy in both English and German. English remains the default.
- Use English names and comments in source code.
- Treat SVG as the recommended MadMapper path and clearly label undocumented formats as experimental.
- Keep interaction usable with mouse, trackpad, touch, and keyboard focus.

## Verification checklist

Before submitting a pull request:

```bash
pnpm lint
pnpm build
```

Then verify in the browser:

- the demo renders three panels in 3D;
- EN/DE changes every visible workflow and dialog label;
- 2D rotation, snap, scale, and both flip controls update the preview;
- Auto Repair opens and changing sensitivity updates the review;
- the export filename follows Fixture Definition;
- Pixelblaze JSON and both Marimapper CSV variants still load.

## Submitting an issue or pull request

For import bugs, include a minimal anonymised file, its header/shape, the expected LED count, and the exact error shown. For export bugs, include the selected format, fixture definition, channel count, MadMapper version, and the smallest generated example that reproduces the issue.

Pull requests should explain the user-facing change, link the relevant issue, and include updated screenshots when the interface changes. Keep unrelated refactors separate.
