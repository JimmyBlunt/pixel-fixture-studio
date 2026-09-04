/** Geometry regressions run without a browser; optional CSV paths stay local, never in Git. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const geometry = source.split('function MapCanvas')[0];
const normalization = source.slice(source.indexOf('function normalizeDegrees'), source.indexOf('function FixturePreview'));
const context = { exports: {} };
vm.createContext(context);
vm.runInContext(ts.transpileModule(`${geometry}\n${normalization}\nglobalThis.api = { analyze, parseMarimapperCsv, placeMissingCoordinates, frontalPanelBasis, frontalPanelCamera, projectXyz, projectScanToCamera, quantizePanelScanGrid, suggestModulesFromScan, moduleGrid, makeModule, moduleCells, moveModulePixel, scaleFixtureModules, newCollisionCount, buildModuleMmfl };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);
const api = context.api;

for (const rotation of [0, 37, 90, -90, 180]) {
  const strip = { ...api.makeModule('Test', 'strip', 0, 1, 8, 0), rotation };
  const before = api.moduleCells(strip, 3);
  const updated = api.moveModulePixel(strip, 3, 1, -1);
  const after = api.moduleCells(updated, 3);
  for (let index = 0; index < before.length; index++) {
    assert.ok(Math.abs(after[index].x - before[index].x - (index === 3 ? 1 : 0)) < 1e-9);
    assert.ok(Math.abs(after[index].y - before[index].y - (index === 3 ? -1 : 0)) < 1e-9);
    assert.equal(after[index].value, before[index].value);
  }
  assert.equal(strip.pixelOffsets, undefined, 'Preview edits must not mutate original modules');
  const scaled = api.scaleFixtureModules([updated], .5);
  api.moduleCells(scaled[0], 3).forEach((cell, index) => {
    assert.ok(Math.abs(cell.x - after[index].x * .5) < 1e-9);
    assert.ok(Math.abs(cell.y - after[index].y * .5) < 1e-9);
    assert.equal(cell.value, after[index].value);
  });
}
const sparse = { ...api.makeModule('Sparse', 'strip', 0, 1, 8, 0), width: 28 };
assert.ok(api.moduleGrid(api.scaleFixtureModules([sparse], .5), 3).width < api.moduleGrid([sparse], 3).width);
assert.equal(api.newCollisionCount([sparse], api.scaleFixtureModules([sparse], .5), 3), 0);
assert.ok(api.newCollisionCount([sparse], api.scaleFixtureModules([sparse], .1), 3) > 0);
const multiMoved = [1, 2, 3].reduce((module, index) => api.moveModulePixel(module, index, 0, 1), sparse);
api.moduleCells(multiMoved, 3).forEach((cell, index) => {
  const before = api.moduleCells(sparse, 3)[index];
  assert.equal(cell.x, before.x);
  assert.equal(cell.y - before.y, [1, 2, 3].includes(index) ? 1 : 0);
});
for (const channels of [3, 4]) {
  const compact = api.scaleFixtureModules([multiMoved], .5);
  const xml = api.buildModuleMmfl(compact, 8, { channels, definition: 'Edited fixture' });
  const values = xml.match(/<PixelMapping[^>]*>([^<]+)<\/PixelMapping>/)[1].trim().split(/\s+/).map(Number).filter(Boolean).sort((a, b) => a - b);
  assert.deepEqual(values, Array.from({ length: 8 }, (_, index) => 1 + index * channels));
  assert.ok(xml.includes('product="Edited fixture"'));
}
console.log('PASS: single-pixel movement, rotated strips, immutable preview, spacing reduction, collision guard, unchanged addresses.');

// Unequal horizontal and vertical serpentine runs, with an intentionally empty centre.
const coords = [];
for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) coords.push([row % 2 ? 5 - col : col, row, 0]);
for (let col = 0; col < 4; col++) for (let row = 0; row < 9; row++) coords.push([8 + col, col % 2 ? 8 - row : row, 0]);
const ranges = [{ first: 0, last: 23 }, { first: 24, last: 59 }];
for (const [yaw, tilt] of [[0, 0], [.65, .83], [1.4, -.7]]) {
  const points = coords.map(([x, y, z], sourceIndex) => ({ sourceIndex, status: 'ok', xyz: [x * Math.cos(yaw) + y * Math.sin(tilt) * Math.sin(yaw), y * Math.cos(tilt), -x * Math.sin(yaw) + y * Math.sin(tilt) * Math.cos(yaw)] }));
  const panel = { indices: points.map(p => p.sourceIndex), id: 'test' };
  const basis = api.frontalPanelBasis(panel, points, 1);
  const camera = api.frontalPanelCamera(panel, points, 1);
  const cameraPoints = api.projectScanToCamera(points, camera);
  for (const point of points) {
    const projected = api.projectXyz(point.xyz, basis), viewed = cameraPoints.get(point.sourceIndex);
    assert.ok(Math.hypot(projected.u - viewed.u, projected.v - viewed.v) < 1e-6, 'Camera and export must share the same front-facing plane');
  }
  const grid = api.quantizePanelScanGrid(panel, points, 1, ranges);
  assert.equal(grid.cells.size, coords.length);
  assert.equal(new Set([...grid.cells.values()].map(p => `${p.column}:${p.row}`)).size, coords.length);
  for (let first = 0; first < coords.length; first++) for (let next = first + 1; next < coords.length; next++) {
    const a = grid.cells.get(first), b = grid.cells.get(next);
    const actual = Math.hypot(a.column - b.column, a.row - b.row) / grid.gridSubdivisions;
    const expected = Math.hypot(coords[first][0] - coords[next][0], coords[first][1] - coords[next][1]);
    assert.ok(Math.abs(actual - expected) < 1e-6, 'Turning or rotating a panel must not move its strands');
  }
}
console.log('PASS: mixed horizontal/vertical strips, empty regions, rotated planes, camera/export agreement.');

for (const path of process.argv.slice(2)) {
  const parsed = api.parseMarimapperCsv(fs.readFileSync(path, 'utf8'), 'en');
  const scan = api.analyze(parsed.coords, parsed.missingIndices);
  const recovered = api.placeMissingCoordinates(scan.points, scan.panels, scan.pitch, parsed.missingIndices);
  const modules = api.suggestModulesFromScan(recovered.points, recovered.panels, scan.pitch, { yaw: -.5, pitch: -.28, zoom: 1 });
  const grid = api.moduleGrid(modules, 3);
  assert.equal(grid.cells.length, parsed.coords.length, 'Every source slot must be retained');
  assert.equal(new Set(grid.cells.map(cell => cell.sourceIndex)).size, parsed.coords.length);
  console.log(JSON.stringify({ file: path, slots: grid.cells.length, matrices: modules.filter(m => m.kind === 'matrix').length, scanPaths: modules.filter(m => m.sourceCells).length, grid: `${grid.width}x${grid.height}`, collisions: grid.collisions }));
}
