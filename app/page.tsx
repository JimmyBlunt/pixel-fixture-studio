'use client';

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';

type Vec3 = [number, number, number];
type Language = 'en' | 'de';
type MapPoint = { sourceIndex: number; xyz: Vec3; status: 'ok' | 'inferred' | 'manual' | 'placeholder' | 'outlier' };
type PanelTransform = { rotation: number; scale: number; flipX: boolean; flipY: boolean };
type Panel = { id: string; name: string; indices: number[]; color: string; enabled: boolean; transform: PanelTransform };
type PixelModuleKind = 'matrix' | 'strip' | 'single' | 'scan';
type ModuleOrder = 'rows' | 'columns';
type ModuleCorner = 'tl' | 'tr' | 'bl' | 'br';
type ModuleSourceCell = { sourceIndex: number; row: number; column: number };
type PixelModule = {
  id: string;
  name: string;
  kind: PixelModuleKind;
  startIndex: number;
  rows: number;
  columns: number;
  order: ModuleOrder;
  zigzag: boolean;
  startCorner: ModuleCorner;
  wiringDetected: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  sourceCells?: ModuleSourceCell[];
  sourceStep?: number;
  sourceGridStep?: number;
  hiddenIndices: number[];
  color: string;
};
type Camera = { yaw: number; pitch: number; zoom: number };
type Projection = { sourceIndex: number; u: number; v: number };
type PanelBasis = { center: Vec3; e1: Vec3; e2: Vec3 };
type RepairSuggestion = {
  id: string;
  sourceIndex: number;
  before: Vec3;
  after: Vec3;
  reason: 'missing-reading' | 'generated-position' | 'threshold-deviation' | 'local-line-deviation';
  confidence: 'high' | 'medium' | 'low';
  deviationRatio: number;
  supportCount: number;
  selected: boolean;
};
type ParsedMap = { coords: Vec3[]; missingIndices: Set<number>; sourceLabel: string; measuredCount: number; sourceRange?: [number, number] };
type MatrixModel = {
  averagePitch: number;
  rowLength: number;
  serpentine: boolean;
  positionAt: (sourceIndex: number) => Vec3;
};
type SerpentineLayout = { rowLength: number; rowStartPhase: number };
type LocalLineEstimate = { position: Vec3; deviationRatio: number; lineNoiseRatio: number; supportCount: number };
type ModuleCell = { moduleId: string; sourceIndex: number; x: number; y: number; hidden: boolean; value: number };

const COLORS = ['#ff4f87', '#8c7cff', '#37d9c5', '#ffae4f', '#4fa8ff', '#d875ff'];

function translated(language: Language, english: string, german: string) {
  return language === 'en' ? english : german;
}

function median(values: number[]) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trimmedMean(values: number[], trimFraction = .1) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const trim = Math.min(Math.floor(sorted.length * trimFraction), Math.floor((sorted.length - 1) / 2));
  const kept = sorted.slice(trim, sorted.length - trim);
  return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

function dist(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function makeDemo() {
  const coords: Vec3[] = [];
  const addPanel = (cx: number, cy: number, cz: number, tilt: number) => {
    for (let row = 0; row < 8; row++) for (let col = 0; col < 12; col++) {
      coords.push([cx + col * 1.05, cy + row * 1.05, cz + col * tilt + Math.sin(row * .7) * .08]);
    }
  };
  addPanel(-20, -4, 3, -.16); addPanel(-4, -5, 0, .02); addPanel(13, -3, -2, .18);
  // Keep two missing readings in the demo so the confirmation-based repair flow is testable.
  coords[29] = [0, 0, 0];
  coords[65] = [0, 0, 0];
  return coords;
}

/** Parse the common Pixelblaze array and object-based mapping shapes. */
function extractCoordinates(value: unknown, language: Language): Vec3[] {
  const parseRows = (rows: unknown[]): Vec3[] => rows.map((row, index) => {
    if (Array.isArray(row) && row.length >= 2) {
      const nums = [Number(row[0]), Number(row[1]), Number(row[2] ?? 0)];
      if (nums.every(Number.isFinite)) return nums as Vec3;
    }
    if (row && typeof row === 'object') {
      const item = row as Record<string, unknown>;
      const nums = [Number(item.x), Number(item.y), Number(item.z ?? 0)];
      if (nums.every(Number.isFinite)) return nums as Vec3;
    }
    throw new Error(translated(language, `Entry ${index + 1} does not contain valid x/y/z coordinates.`, `Eintrag ${index + 1} enthält keine gültigen x/y/z-Koordinaten.`));
  });
  if (Array.isArray(value)) return parseRows(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['coordinates', 'points', 'map', 'pixelMap']) if (Array.isArray(obj[key])) return parseRows(obj[key] as unknown[]);
  }
  throw new Error(translated(language, 'Expected a JSON array containing [x, y, z] points.', 'Erwartet wird ein JSON-Array mit [x, y, z]-Punkten.'));
}

/** Preserve sparse Marimapper indices as repairable placeholder slots. */
function parseMarimapperCsv(text: string, language: Language): ParsedMap {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error(translated(language, 'The Marimapper CSV does not contain measurement data.', 'Die Marimapper-CSV enthält keine Messdaten.'));
  const headers = lines[0].split(',').map(header => header.trim().toLowerCase());
  const column = (name: string) => headers.indexOf(name);
  const is3d = ['index', 'x', 'y', 'z'].every(name => column(name) >= 0);
  const is2d = ['index', 'u', 'v'].every(name => column(name) >= 0);
  if (!is3d && !is2d) throw new Error(translated(language, 'Unknown CSV structure. Expected Marimapper index,x,y,z,xn,yn,zn,error or index,u,v.', 'Unbekannte CSV-Struktur. Marimapper erwartet index,x,y,z,xn,yn,zn,error oder index,u,v.'));

  const measured = new Map<number, Vec3>();
  const declaredIndices = new Set<number>();
  lines.slice(1).forEach((line, rowIndex) => {
    const values = line.split(',').map(value => value.trim());
    const index = Number(values[column('index')]);
    if (!Number.isInteger(index) || index < 0) throw new Error(translated(language, `Marimapper row ${rowIndex + 2} contains an invalid index.`, `Marimapper-Zeile ${rowIndex + 2} enthält einen ungültigen Index.`));
    if (declaredIndices.has(index)) throw new Error(translated(language, `Marimapper index ${index} occurs more than once.`, `Der Marimapper-Index ${index} kommt mehrfach vor.`));
    declaredIndices.add(index);
    const read = (name: string) => { const raw = values[column(name)]; return raw === '' || raw === undefined ? NaN : Number(raw); };
    const xyz = is3d ? [read('x'), read('y'), read('z')] : [read('u'), read('v'), 0];
    // A valid index without finite coordinates is a missing scan, not a fatal CSV error.
    if (xyz.every(Number.isFinite)) measured.set(index, xyz as Vec3);
  });
  if (!measured.size) throw new Error(translated(language, 'The Marimapper CSV does not contain valid LEDs.', 'Die Marimapper-CSV enthält keine gültigen LEDs.'));
  const firstIndex = Math.min(...declaredIndices), lastIndex = Math.max(...declaredIndices);
  const span = lastIndex - firstIndex + 1;
  if (span > 20000) throw new Error(translated(language, 'The interactive preview supports up to 20,000 LED slots.', 'Für die interaktive Vorschau sind maximal 20.000 LED-Slots vorgesehen.'));
  // Normalise the loaded scan range so indices before the first CSV row never become invented LEDs.
  const coords = Array.from({ length: span }, (_, index) => measured.get(firstIndex + index) ?? [0, 0, 0] as Vec3);
  const missingIndices = new Set(coords.map((_, index) => index).filter(index => !measured.has(firstIndex + index)));
  return { coords, missingIndices, sourceLabel: is3d ? 'Marimapper 3D-CSV' : 'Marimapper 2D-CSV', measuredCount: measured.size, sourceRange: [firstIndex, lastIndex] };
}

/** Detect spatially connected panels while retaining placeholders and outliers. */
function analyze(coords: Vec3[], explicitMissing = new Set<number>()) {
  const originCount = coords.filter(([x, y, z]) => x === 0 && y === 0 && z === 0).length;
  const isPlaceholder = (xyz: Vec3, sourceIndex: number) => explicitMissing.has(sourceIndex) || (originCount > 1 && xyz[0] === 0 && xyz[1] === 0 && xyz[2] === 0);
  const candidates = coords.map((xyz, sourceIndex) => ({ xyz, sourceIndex })).filter(point => !isPlaceholder(point.xyz, point.sourceIndex));
  const nearest = candidates.map((point, i) => {
    let best = Infinity;
    for (let j = 0; j < candidates.length; j++) if (i !== j) best = Math.min(best, dist(point.xyz, candidates[j].xyz));
    return best;
  }).filter(Number.isFinite);
  const pitch = median(nearest);
  const eps = Math.max(pitch * 3, 1e-6);
  const parent = candidates.map((_, i) => i);
  const find = (n: number): number => parent[n] === n ? n : (parent[n] = find(parent[n]));
  const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) if (dist(candidates[i].xyz, candidates[j].xyz) <= eps) unite(i, j);
  const grouped = new Map<number, number[]>();
  candidates.forEach((point, i) => { const root = find(i); grouped.set(root, [...(grouped.get(root) ?? []), point.sourceIndex]); });
  const minSize = Math.max(6, Math.ceil(candidates.length * .005));
  const clusters = [...grouped.values()].filter(group => group.length >= minSize).sort((a, b) => Math.min(...a) - Math.min(...b));
  const clustered = new Set(clusters.flat());
  const points: MapPoint[] = coords.map((xyz, sourceIndex) => ({
    sourceIndex, xyz,
    status: isPlaceholder(xyz, sourceIndex) ? 'placeholder' : clustered.has(sourceIndex) ? 'ok' : 'outlier',
  }));
  const panels: Panel[] = clusters.map((indices, i) => ({ id: `panel-${Date.now()}-${i}`, name: `Panel ${String(i + 1).padStart(2, '0')}`, indices: indices.sort((a, b) => a - b), color: COLORS[i % COLORS.length], enabled: true, transform: { rotation: 0, scale: 1, flipX: false, flipY: false } }));
  return { points, panels, pitch, originCount, outliers: points.filter(p => p.status === 'outlier').length };
}

function dot(a: Vec3, b: Vec3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(v: Vec3): Vec3 { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
function mul(m: number[][], v: Vec3): Vec3 { return [dot(m[0] as Vec3, v), dot(m[1] as Vec3, v), dot(m[2] as Vec3, v)]; }
function power(m: number[][], seed: Vec3): Vec3 { let v = norm(seed); for (let i = 0; i < 24; i++) v = norm(mul(m, v)); return v; }

function getPanelBasis(panel: Panel, points: MapPoint[]): PanelBasis | null {
  const pts = panel.indices.map(index => points[index]).filter(Boolean);
  if (!pts.length) return null;
  const c: Vec3 = [0, 0, 0];
  pts.forEach(p => p.xyz.forEach((n, i) => { c[i] += n / pts.length; }));
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  pts.forEach(p => { const d: Vec3 = [p.xyz[0] - c[0], p.xyz[1] - c[1], p.xyz[2] - c[2]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j]; });
  let e1 = power(cov, [1, .4, .2]);
  const lambda = dot(e1, mul(cov, e1));
  const deflated = cov.map((row, i) => row.map((value, j) => value - lambda * e1[i] * e1[j]));
  let e2 = power(deflated, [.2, 1, .3]);
  const first = pts[0].xyz, last = pts[pts.length - 1].xyz;
  const travel: Vec3 = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
  if (dot(e1, travel) < 0) e1 = [-e1[0], -e1[1], -e1[2]];
  if (Math.abs(dot(e1, e2)) > .15) e2 = norm([e2[0] - dot(e1, e2) * e1[0], e2[1] - dot(e1, e2) * e1[1], e2[2] - dot(e1, e2) * e1[2]]);
  return { center: c, e1, e2 };
}

function projectXyz(xyz: Vec3, basis: PanelBasis) {
  const d: Vec3 = [xyz[0] - basis.center[0], xyz[1] - basis.center[1], xyz[2] - basis.center[2]];
  return { u: dot(d, basis.e1), v: -dot(d, basis.e2) };
}

function projectPanel(panel: Panel, points: MapPoint[]): Projection[] {
  const basis = getPanelBasis(panel, points);
  if (!basis) return [];
  return panel.indices.map(index => points[index]).filter(Boolean).map(point => ({ sourceIndex: point.sourceIndex, ...projectXyz(point.xyz, basis) }));
}

/** Apply the non-destructive 2D orientation used by every preview and export. */
function transformProjection(projected: Projection[], transform: PanelTransform, includeScale = true) {
  const angle = transform.rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle), scale = includeScale ? transform.scale : 1;
  return projected.map(point => {
    const rotatedU = point.u * c - point.v * s, rotatedV = point.u * s + point.v * c;
    return { ...point, u: rotatedU * (transform.flipX ? -1 : 1) * scale, v: rotatedV * (transform.flipY ? -1 : 1) * scale };
  });
}

function adjustedPanelProjection(panel: Panel, points: MapPoint[]) {
  return transformProjection(projectPanel(panel, points), panel.transform);
}

function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scaleVec(v: Vec3, factor: number): Vec3 { return [v[0] * factor, v[1] * factor, v[2] * factor]; }
function averageVec(values: Vec3[]): Vec3 {
  return values.reduce<Vec3>((sum, value) => add(sum, value), [0, 0, 0]).map(value => value / Math.max(values.length, 1)) as Vec3;
}

function mode(values: number[]) {
  const counts = new Map<number, number>();
  values.forEach(value => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function modulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function modulePixelCount(module: PixelModule) {
  return module.sourceCells?.length ?? Math.max(1, module.rows) * Math.max(1, module.columns);
}

function moduleIndices(module: PixelModule) {
  if (module.sourceCells) return module.sourceCells.map(cell => cell.sourceIndex);
  return Array.from({ length: modulePixelCount(module) }, (_, offset) => module.startIndex + offset);
}

function unassignedRanges(modules: PixelModule[], total: number) {
  const assigned = new Set(modules.flatMap(moduleIndices).filter(index => index >= 0 && index < total));
  const ranges: { first: number; last: number }[] = [];
  let first = -1;
  for (let index = 0; index <= total; index++) {
    if (index < total && !assigned.has(index)) {
      if (first < 0) first = index;
    } else if (first >= 0) {
      ranges.push({ first, last: index - 1 });
      first = -1;
    }
  }
  return ranges;
}

function firstFreeRange(modules: PixelModule[], total: number, count: number) {
  const assigned = new Set(modules.flatMap(moduleIndices));
  for (let first = 0; first + count <= total; first++) {
    if (Array.from({ length: count }, (_, offset) => first + offset).every(index => !assigned.has(index))) return first;
  }
  return -1;
}

function moduleLocalCell(module: PixelModule, offset: number) {
  const rows = Math.max(1, module.rows), columns = Math.max(1, module.columns);
  let row = 0, column = 0;
  if (module.order === 'rows') {
    row = Math.floor(offset / columns);
    const step = offset % columns;
    column = module.zigzag && row % 2 ? columns - 1 - step : step;
  } else {
    column = Math.floor(offset / rows);
    const step = offset % rows;
    row = module.zigzag && column % 2 ? rows - 1 - step : step;
  }
  if (module.startCorner.includes('r')) column = columns - 1 - column;
  if (module.startCorner.includes('b')) row = rows - 1 - row;
  return { row, column };
}

function moduleCellForSource(module: PixelModule, sourceIndex: number) {
  return module.sourceCells?.find(cell => cell.sourceIndex === sourceIndex) ?? moduleLocalCell(module, sourceIndex - module.startIndex);
}

function moduleCells(module: PixelModule, channels: number): ModuleCell[] {
  const hidden = new Set(module.hiddenIndices);
  const radians = module.rotation * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const assignments = module.sourceCells ?? Array.from({ length: modulePixelCount(module) }, (_, offset) => ({
    sourceIndex: module.startIndex + offset,
    ...moduleLocalCell(module, offset),
  }));
  return assignments.map(({ sourceIndex, row, column }) => {
    const localX = module.columns <= 1 ? module.width / 2 : column / (module.columns - 1) * module.width;
    const localY = module.rows <= 1 ? module.height / 2 : row / (module.rows - 1) * module.height;
    const dx = localX - module.width / 2, dy = localY - module.height / 2;
    return {
      moduleId: module.id,
      sourceIndex,
      x: module.x + module.width / 2 + dx * c - dy * s,
      y: module.y + module.height / 2 + dx * s + dy * c,
      hidden: hidden.has(sourceIndex),
      value: 1 + sourceIndex * channels,
    };
  });
}

function moduleGrid(modules: PixelModule[], channels: number) {
  const raw = modules.flatMap(module => moduleCells(module, channels));
  if (!raw.length) return { cells: [] as (ModuleCell & { gridX: number; gridY: number })[], width: 1, height: 1, collisions: [] as string[] };
  const rounded = raw.map(cell => ({ ...cell, gridX: Math.round(cell.x), gridY: Math.round(cell.y) }));
  const minX = Math.min(...rounded.map(cell => cell.gridX)), minY = Math.min(...rounded.map(cell => cell.gridY));
  const cells = rounded.map(cell => ({ ...cell, gridX: cell.gridX - minX, gridY: cell.gridY - minY }));
  const occupied = new Map<string, ModuleCell & { gridX: number; gridY: number }>();
  const collisions: string[] = [];
  cells.forEach(cell => {
    const key = `${cell.gridX}:${cell.gridY}`, previous = occupied.get(key);
    if (previous) collisions.push(`#${previous.sourceIndex + 1} / #${cell.sourceIndex + 1}`);
    else occupied.set(key, cell);
  });
  return {
    cells,
    width: Math.max(...cells.map(cell => cell.gridX)) + 1,
    height: Math.max(...cells.map(cell => cell.gridY)) + 1,
    collisions,
  };
}

function makeModule(name: string, kind: PixelModuleKind, startIndex: number, rows: number, columns: number, position: number): PixelModule {
  const safeRows = kind === 'matrix' || kind === 'scan' ? Math.max(1, rows) : 1;
  const safeColumns = kind === 'matrix' || kind === 'scan' ? Math.max(1, columns) : kind === 'strip' ? Math.max(1, columns) : 1;
  return {
    id: `module-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    kind,
    startIndex,
    rows: safeRows,
    columns: safeColumns,
    order: 'rows',
    zigzag: kind === 'matrix',
    startCorner: 'tl',
    wiringDetected: false,
    x: position * (safeColumns + 3),
    y: 0,
    width: Math.max(safeColumns - 1, 0),
    height: Math.max(safeRows - 1, 0),
    rotation: 0,
    hiddenIndices: [],
    color: COLORS[position % COLORS.length],
  };
}

function detectModuleWiring(module: PixelModule, points: MapPoint[], panels: Panel[], pitch: number): PixelModule {
  if (module.sourceCells) return { ...module, wiringDetected: true };
  const indices = moduleIndices(module).filter(index => points[index]);
  if (indices.length < 2) return { ...module, wiringDetected: false };
  const owner = panels.find(panel => indices.some(index => panel.indices.includes(index)));
  const panel = owner ?? { id: 'detect', name: 'Detect', indices, color: module.color, enabled: true, transform: { rotation: 0, scale: 1, flipX: false, flipY: false } };
  const layout = detectSerpentineLayout(panel, points, pitch, module.startIndex);
  const projected = projectPanel({ ...panel, indices }, points);
  const first = projected.find(point => point.sourceIndex === module.startIndex) ?? projected[0];
  const middleU = median(projected.map(point => point.u)), middleV = median(projected.map(point => point.v));
  const horizontal = !first || first.u <= middleU ? 'l' : 'r';
  const vertical = !first || first.v <= middleV ? 't' : 'b';
  const rowMatch = layout?.rowLength === module.columns;
  const columnMatch = layout?.rowLength === module.rows;
  return {
    ...module,
    order: columnMatch && !rowMatch ? 'columns' : 'rows',
    zigzag: Boolean(layout),
    startCorner: `${vertical}${horizontal}` as ModuleCorner,
    wiringDetected: Boolean(layout || first),
  };
}

/** Project the imported coordinates exactly like the interactive 3D camera, but in scan units. */
function projectScanToCamera(points: MapPoint[], camera: Camera) {
  const usable = points.filter(point => point.status !== 'placeholder' && point.xyz.every(Number.isFinite));
  const center: Vec3 = [0, 0, 0];
  usable.forEach(point => point.xyz.forEach((value, axis) => { center[axis] += value / Math.max(usable.length, 1); }));
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  return new Map(usable.map(point => {
    const x = point.xyz[0] - center[0], y = point.xyz[1] - center[1], z = point.xyz[2] - center[2];
    const u = x * cy - z * sy, depth = x * sy + z * cy, vertical = y * cp - depth * sp;
    return [point.sourceIndex, { u, v: -vertical }] as const;
  }));
}

function averageVector(vectors: { u: number; v: number }[]) {
  if (!vectors.length) return null;
  return vectors.reduce((sum, vector) => ({ u: sum.u + vector.u / vectors.length, v: sum.v + vector.v / vectors.length }), { u: 0, v: 0 });
}

/**
 * Preserve the relative arrangement visible in the 3D camera when constructing the editable
 * orthogonal MMFL modules. Each module gets a scan-derived centre, rotation and projected size.
 */
function alignModulesToScanView(modules: PixelModule[], points: MapPoint[], camera: Camera, pitch: number) {
  const projected = projectScanToCamera(points, camera);
  const safePitch = Math.max(pitch, .0001);
  const aligned = modules.map(module => {
    // Crossed strands from one panel already share an exact scan-derived lattice. Aligning each
    // strand independently to the camera would destroy that shared basis and create collisions.
    if (module.sourceCells) return module;
    const cellPoints = moduleIndices(module).flatMap(sourceIndex => {
      const position = projected.get(sourceIndex);
      if (!position) return [];
      const local = moduleCellForSource(module, sourceIndex);
      return [{ sourceIndex, row: local.row, column: local.column, ...position }];
    });
    if (!cellPoints.length) return module;
    const byCell = new Map(cellPoints.map(point => [`${point.row}:${point.column}`, point]));
    const horizontal: { u: number; v: number }[] = [], vertical: { u: number; v: number }[] = [];
    cellPoints.forEach(point => {
      const right = byCell.get(`${point.row}:${point.column + 1}`);
      if (right) horizontal.push({ u: right.u - point.u, v: right.v - point.v });
      const below = byCell.get(`${point.row + 1}:${point.column}`);
      if (below) vertical.push({ u: below.u - point.u, v: below.v - point.v });
    });
    const columnVector = averageVector(horizontal), rowVector = averageVector(vertical);
    const columnStep = columnVector ? Math.hypot(columnVector.u, columnVector.v) / safePitch : 1;
    const rowStep = rowVector ? Math.hypot(rowVector.u, rowVector.v) / safePitch : 1;
    // Never compress below one MMFL cell per physical step: perspective may make a panel
    // appear edge-on, but its output grid must still keep every LED in a unique cell.
    const width = module.columns > 1 ? Math.max(1, columnStep) * (module.columns - 1) : 0;
    const height = module.rows > 1 ? Math.max(1, rowStep) * (module.rows - 1) : 0;
    const columnSpan = columnVector ? Math.hypot(columnVector.u, columnVector.v) * Math.max(module.columns - 1, 1) : 0;
    const rowSpan = rowVector ? Math.hypot(rowVector.u, rowVector.v) * Math.max(module.rows - 1, 1) : 0;
    const direction = rowVector && rowSpan > columnSpan
      ? Math.atan2(rowVector.v, rowVector.u) - Math.PI / 2
      : columnVector ? Math.atan2(columnVector.v, columnVector.u) : rowVector ? Math.atan2(rowVector.v, rowVector.u) - Math.PI / 2 : 0;
    const center = cellPoints.reduce((sum, point) => ({ u: sum.u + point.u / cellPoints.length, v: sum.v + point.v / cellPoints.length }), { u: 0, v: 0 });
    return {
      ...module,
      x: center.u / safePitch - width / 2,
      y: center.v / safePitch - height / 2,
      width,
      height,
      rotation: normalizeDegrees(direction * 180 / Math.PI),
    };
  });
  // A 3D camera can visually overlap panels that live at different depths. MMFL is a single
  // plane, so gently separate their rotated bounds while retaining the scan-derived ordering
  // and orientation. This keeps the automatic draft exportable instead of creating collisions.
  let separated = aligned.map(module => ({ ...module }));
  for (let iteration = 0; iteration < 80; iteration++) {
    const bounds = separated.map(module => {
      const cells = moduleCells(module, 3);
      return {
        minX: Math.min(...cells.map(cell => cell.x)), maxX: Math.max(...cells.map(cell => cell.x)),
        minY: Math.min(...cells.map(cell => cell.y)), maxY: Math.max(...cells.map(cell => cell.y)),
      };
    });
    let moved = false;
    for (let left = 0; left < separated.length; left++) for (let right = left + 1; right < separated.length; right++) {
      // Scan-path modules may be interwoven on the same physical panel. Their bounding boxes
      // overlap by design, so only separate modules when their actual rounded MMFL cells collide.
      const leftKeys = new Set(moduleCells(separated[left], 3).map(cell => `${Math.round(cell.x)}:${Math.round(cell.y)}`));
      const hasCellCollision = moduleCells(separated[right], 3).some(cell => leftKeys.has(`${Math.round(cell.x)}:${Math.round(cell.y)}`));
      if (!hasCellCollision) continue;
      const overlapX = Math.min(bounds[left].maxX, bounds[right].maxX) - Math.max(bounds[left].minX, bounds[right].minX) + 2;
      const overlapY = Math.min(bounds[left].maxY, bounds[right].maxY) - Math.max(bounds[left].minY, bounds[right].minY) + 2;
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      if (overlapX < overlapY) {
        const leftCenter = (bounds[left].minX + bounds[left].maxX) / 2, rightCenter = (bounds[right].minX + bounds[right].maxX) / 2;
        const direction = leftCenter <= rightCenter ? -1 : 1, amount = overlapX / 2 + .05;
        separated[left].x += direction * amount; separated[right].x -= direction * amount;
      } else {
        const leftCenter = (bounds[left].minY + bounds[left].maxY) / 2, rightCenter = (bounds[right].minY + bounds[right].maxY) / 2;
        const direction = leftCenter <= rightCenter ? -1 : 1, amount = overlapY / 2 + .05;
        separated[left].y += direction * amount; separated[right].y -= direction * amount;
      }
    }
    if (!moved) break;
  }
  const cells = separated.flatMap(module => moduleCells(module, 3));
  if (!cells.length) return aligned;
  const offsetX = 2 - Math.min(...cells.map(cell => cell.x)), offsetY = 2 - Math.min(...cells.map(cell => cell.y));
  return separated.map(module => ({ ...module, x: module.x + offsetX, y: module.y + offsetY }));
}

/**
 * Snap a measured panel to its dominant square-grid axes while retaining empty cells. Using
 * four-times-angle averaging makes horizontal and vertical strip travel reinforce each other,
 * so crossed paths share one stable output grid instead of competing for a single zigzag model.
 */
function quantizePanelScanGrid(panel: Panel, points: MapPoint[], pitch: number, strandRanges: { first: number; last: number }[]) {
  const projected = projectPanel(panel, points);
  const byIndex = new Map(projected.map(point => [point.sourceIndex, point]));
  let cosine = 0, sine = 0, support = 0;
  const ordered = [...panel.indices].sort((a, b) => a - b);
  for (let offset = 0; offset < ordered.length - 1; offset++) {
    const firstIndex = ordered[offset], nextIndex = ordered[offset + 1];
    if (nextIndex !== firstIndex + 1) continue;
    const first = byIndex.get(firstIndex), next = byIndex.get(nextIndex);
    if (!first || !next) continue;
    const du = next.u - first.u, dv = next.v - first.v, length = Math.hypot(du, dv);
    if (length < pitch * .35 || length > pitch * 1.7) continue;
    const angle = Math.atan2(dv, du);
    cosine += Math.cos(angle * 4); sine += Math.sin(angle * 4); support++;
  }
  const angle = support ? Math.atan2(sine, cosine) / 4 : 0;
  const c = Math.cos(angle), s = Math.sin(angle);
  const strandPitches = strandRanges.map(range => {
    const distances = Array.from({ length: Math.max(0, range.last - range.first) }, (_, offset) => range.first + offset).flatMap(index => {
      const first = points[index], next = points[index + 1];
      return first && next && first.status === 'ok' && next.status === 'ok' ? [dist(first.xyz, next.xyz)] : [];
    });
    return { ...range, pitch: median(distances) };
  });
  const basePitch = Math.max(Math.min(...strandPitches.map(strand => strand.pitch), pitch), .0001);
  // The densest strip defines one MMFL cell: 144/m LEDs remain directly adjacent, while a
  // half-density 72/m strip advances by two cells. Dense horizontal rows use every second row,
  // leaving the intermediate row for the crossing strip and creating a symmetric weave.
  const gridSubdivisions = 1;
  const cellPitch = basePitch / gridSubdivisions;
  const raw = projected.map(point => ({
    sourceIndex: point.sourceIndex,
    column: (point.u * c + point.v * s) / cellPitch,
    row: (-point.u * s + point.v * c) / cellPitch,
  }));
  const minColumn = Math.min(...raw.map(cell => cell.column)), minRow = Math.min(...raw.map(cell => cell.row));
  const rawByIndex = new Map(raw.map(cell => [cell.sourceIndex, { ...cell, column: cell.column - minColumn, row: cell.row - minRow }]));
  const occupied = new Set<string>(), cells = new Map<number, ModuleSourceCell>(), steps = new Map<number, number>();
  let denseRowParity: number | null = null;
  strandPitches.forEach(strand => {
    const relativeStep = Math.max(1, Math.round(strand.pitch / basePitch));
    const step = relativeStep * gridSubdivisions;
    steps.set(strand.first, relativeStep);
    const strandCells = Array.from({ length: strand.last - strand.first + 1 }, (_, offset) => rawByIndex.get(strand.first + offset)).filter(Boolean) as { sourceIndex: number; row: number; column: number }[];
    const lineRuns: typeof strandCells[] = [];
    let lineStart = 0;
    let lineAxis: 'horizontal' | 'vertical' | null = null, lineDirection = 0;
    for (let offset = 0; offset < strandCells.length - 1; offset++) {
      const first = strandCells[offset], next = strandCells[offset + 1];
      const dc = next.column - first.column, dr = next.row - first.row;
      const major = Math.max(Math.abs(dc), Math.abs(dr)), minor = Math.min(Math.abs(dc), Math.abs(dr));
      const physicalDistance = dist(points[first.sourceIndex].xyz, points[next.sourceIndex].xyz);
      const nextAxis = Math.abs(dc) >= Math.abs(dr) ? 'horizontal' : 'vertical';
      const nextDirection = (nextAxis === 'horizontal' ? dc : dr) >= 0 ? 1 : -1;
      const axisAligned = major > 0 && minor <= major * .65 && physicalDistance <= strand.pitch * 2.4;
      const changesDirection = lineAxis !== null && (lineAxis !== nextAxis || lineDirection !== nextDirection);
      if (!axisAligned || changesDirection) {
        lineRuns.push(strandCells.slice(lineStart, offset + 1));
        lineStart = offset + 1;
        lineAxis = null;
        lineDirection = 0;
      } else if (lineAxis === null) {
        lineAxis = nextAxis;
        lineDirection = nextDirection;
      }
    }
    lineRuns.push(strandCells.slice(lineStart));

    // A turn measurement can appear as a one-pixel run. Fold that endpoint into the following
    // straight row so it cannot create an artificial extra row or gap in the woven layout.
    const regularRuns: typeof strandCells[] = [];
    for (let index = 0; index < lineRuns.length; index++) {
      const line = lineRuns[index];
      if (line.length <= 2 && index + 1 < lineRuns.length) {
        lineRuns[index + 1] = [...line, ...lineRuns[index + 1]];
      } else if (line.length <= 2 && regularRuns.length) {
        regularRuns[regularRuns.length - 1] = [...regularRuns.at(-1)!, ...line];
      } else if (line.length) regularRuns.push(line);
    }

    const denseStrip = relativeStep === 1;
    const denseRowMedians = denseStrip ? regularRuns.map(line => median(line.map(cell => cell.row))) : [];
    const denseRowStart = denseStrip && denseRowMedians.length ? Math.round(denseRowMedians[0]) : 0;
    const denseRowDirection = denseStrip && denseRowMedians.length > 1 && denseRowMedians.at(-1)! < denseRowMedians[0] ? -1 : 1;
    if (denseStrip) denseRowParity = modulo(denseRowStart, 2);
    const snapToOppositeRowParity = (rounded: number, rawValue: number) => {
      if (denseRowParity === null || modulo(rounded, 2) !== denseRowParity) return rounded;
      return Math.abs(rawValue - (rounded - 1)) <= Math.abs(rawValue - (rounded + 1)) ? rounded - 1 : rounded + 1;
    };

    regularRuns.forEach((line, lineIndex) => {
      const columnSpan = Math.abs(line.at(-1)!.column - line[0].column), rowSpan = Math.abs(line.at(-1)!.row - line[0].row);
      const horizontal = denseStrip || columnSpan >= rowSpan;
      const firstMajor = horizontal ? line[0].column : line[0].row;
      const lastMajor = horizontal ? line.at(-1)!.column : line.at(-1)!.row;
      const direction = lastMajor >= firstMajor ? 1 : -1;
      const rawMajorOrigin = median(line.map((cell, offset) => (horizontal ? cell.column : cell.row) - direction * offset * step));
      const rawMinorOrigin = median(line.map(cell => horizontal ? cell.row : cell.column));
      let majorOrigin = Math.round(rawMajorOrigin);
      let minorOrigin = denseStrip ? denseRowStart + lineIndex * 2 * denseRowDirection : Math.round(rawMinorOrigin);
      if (!denseStrip && denseRowParity !== null) {
        if (horizontal) minorOrigin = snapToOppositeRowParity(minorOrigin, rawMinorOrigin);
        else majorOrigin = snapToOppositeRowParity(majorOrigin, rawMajorOrigin);
      }
      const ideal = line.map((cell, offset) => ({
        sourceIndex: cell.sourceIndex,
        column: horizontal ? majorOrigin + direction * offset * step : minorOrigin,
        row: horizontal ? minorOrigin : majorOrigin + direction * offset * step,
      }));

      // Preserve spacing by moving a complete straight run when it would share a cell with an
      // already placed run. Never push just one LED aside and create a new hole in the strip.
      let translation = { column: 0, row: 0 };
      const candidates: { column: number; row: number; score: number }[] = [];
      for (let radius = 0; radius <= 32; radius++) for (let row = -radius; row <= radius; row++) for (let column = -radius; column <= radius; column++) {
        if (Math.max(Math.abs(column), Math.abs(row)) !== radius) continue;
        // Never move a run from an even dense row onto an odd crossing row or vice versa.
        if (row % 2 !== 0) continue;
        const along = horizontal ? Math.abs(column) : Math.abs(row);
        candidates.push({ column, row, score: column ** 2 + row ** 2 + along * 4 });
      }
      candidates.sort((left, right) => left.score - right.score);
      const available = candidates.find(candidate => ideal.every(cell => !occupied.has(`${cell.column + candidate.column}:${cell.row + candidate.row}`)));
      if (available) translation = available;
      ideal.forEach(cell => {
        const placed = { sourceIndex: cell.sourceIndex, column: cell.column + translation.column, row: cell.row + translation.row };
        occupied.add(`${placed.column}:${placed.row}`);
        cells.set(placed.sourceIndex, placed);
      });
    });
  });
  return { cells, steps, gridSubdivisions };
}

/**
 * Build an editable first draft from the measured index path. Large, regularly repeated
 * return jumps describe row-major matrices; close direction reversals describe serpentine
 * matrices. Isolated runs remain strips. The result always covers every confirmed slot once.
 */
function suggestModulesFromScan(points: MapPoint[], panels: Panel[], pitch: number, camera: Camera) {
  if (!points.length) return [] as PixelModule[];
  const resetEdges: { after: number; distance: number }[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index], next = points[index + 1];
    // Calculated placeholders must not create artificial panel boundaries.
    if (!current || !next || current.status !== 'ok' || next.status !== 'ok') continue;
    const distance = dist(current.xyz, next.xyz);
    if (distance > pitch * 2.2) resetEdges.push({ after: index, distance });
  }

  const resetByIndex = new Map(resetEdges.map(edge => [edge.after, edge.distance]));
  const runs: { first: number; last: number; length: number }[] = [];
  let first = 0;
  resetEdges.forEach(edge => {
    runs.push({ first, last: edge.after, length: edge.after - first + 1 });
    first = edge.after + 1;
  });
  runs.push({ first, last: points.length - 1, length: points.length - first });

  type ModuleDraft = { first: number; count: number; rows: number; columns: number; zigzag: boolean; confidence: 'high' | 'medium'; sourceCells?: ModuleSourceCell[]; sourceStep?: number; sourceGridStep?: number; x?: number; y?: number };
  const drafts: ModuleDraft[] = [];
  for (let offset = 0; offset < runs.length;) {
    const start = runs[offset];
    const resetDistances: number[] = [];
    let endOffset = offset;
    while (endOffset + 1 < runs.length && runs[endOffset + 1].length === start.length) {
      const distance = resetByIndex.get(runs[endOffset].last) ?? 0;
      const typical = resetDistances.length ? median(resetDistances) : distance;
      if (resetDistances.length >= 2 && (distance > typical * 1.25 || distance < typical * .72)) break;
      resetDistances.push(distance);
      endOffset++;
    }
    const repeatedRows = endOffset - offset + 1;
    if (repeatedRows >= 2 && start.length >= 2) {
      const last = runs[endOffset].last;
      drafts.push({ first: start.first, count: last - start.first + 1, rows: repeatedRows, columns: start.length, zigzag: false, confidence: repeatedRows >= 3 ? 'high' : 'medium' });
      offset = endOffset + 1;
      continue;
    }

    const indices = Array.from({ length: start.length }, (_, index) => start.first + index);
    const scanPanel: Panel = { id: `suggest-${start.first}`, name: 'Suggestion', indices, color: COLORS[drafts.length % COLORS.length], enabled: true, transform: { rotation: 0, scale: 1, flipX: false, flipY: false } };
    const serpentine = detectSerpentineLayout(scanPanel, points, pitch, start.first + Math.floor(start.length / 2));
    if (serpentine && serpentine.rowLength >= 2 && start.length % serpentine.rowLength === 0 && start.length / serpentine.rowLength >= 2) {
      drafts.push({ first: start.first, count: start.length, rows: start.length / serpentine.rowLength, columns: serpentine.rowLength, zigzag: true, confidence: 'high' });
    } else {
      drafts.push({ first: start.first, count: start.length, rows: 1, columns: start.length, zigzag: false, confidence: 'medium' });
    }
    offset++;
  }

  // A very long jump inside one spatially connected panel is a cable/strip change, not a row
  // return. Replace any forced rectangular draft for that panel with one scan-path module per
  // physical strand. This supports crossed and differently oriented zigzag strips on one panel.
  const ownerByIndex = new Map<number, Panel>();
  panels.forEach(panel => panel.indices.forEach(index => ownerByIndex.set(index, panel)));
  const strandBreaks = Array.from({ length: Math.max(0, points.length - 1) }, (_, index) => index).filter(index => {
    const current = points[index], next = points[index + 1];
    return current?.status === 'ok' && next?.status === 'ok'
      && ownerByIndex.get(index)?.id === ownerByIndex.get(index + 1)?.id
      && dist(current.xyz, next.xyz) > pitch * 8;
  });
  const hardBreakPanelIds = new Set(strandBreaks.map(index => ownerByIndex.get(index)?.id).filter(Boolean));
  // A large jump is also the normal cable transition between separate matrix tiles. Protect a
  // panel when the regular detector already explains most LEDs as high-confidence matrices;
  // only poorly explained panels fall back to the crossed/free scan-path model.
  const multiPathPanels = new Set(panels.filter(panel => {
    if (!hardBreakPanelIds.has(panel.id)) return false;
    const panelIndices = new Set(panel.indices), matrixCovered = new Set<number>();
    drafts.filter(draft => draft.rows > 1 && draft.confidence === 'high').forEach(draft => {
      for (let offset = 0; offset < draft.count; offset++) {
        const sourceIndex = draft.first + offset;
        if (panelIndices.has(sourceIndex)) matrixCovered.add(sourceIndex);
      }
    });
    return matrixCovered.size / Math.max(panel.indices.length, 1) < .72;
  }).map(panel => panel.id));
  const specialDrafts: ModuleDraft[] = [];
  panels.filter(panel => multiPathPanels.has(panel.id)).forEach(panel => {
    const indices = [...panel.indices].sort((a, b) => a - b);
    if (!indices.length) return;
    const first = indices[0], last = indices.at(-1)!;
    const breaks = strandBreaks.filter(index => index >= first && index < last);
    const strandRanges = [...breaks, last].map((boundary, index) => ({ first: index ? breaks[index - 1] + 1 : first, last: boundary }));
    const grid = quantizePanelScanGrid(panel, points, pitch, strandRanges);
    let segmentFirst = first;
    [...breaks, last].forEach((boundary, boundaryIndex) => {
      const segmentLast = boundaryIndex < breaks.length ? boundary : last;
      const absoluteCells = Array.from({ length: segmentLast - segmentFirst + 1 }, (_, offset) => grid.cells.get(segmentFirst + offset)).filter(Boolean) as ModuleSourceCell[];
      if (absoluteCells.length) {
        const minColumn = Math.min(...absoluteCells.map(cell => cell.column)), minRow = Math.min(...absoluteCells.map(cell => cell.row));
        const sourceCells = absoluteCells.map(cell => ({ ...cell, column: cell.column - minColumn, row: cell.row - minRow }));
        const columns = Math.max(...sourceCells.map(cell => cell.column)) + 1, rows = Math.max(...sourceCells.map(cell => cell.row)) + 1;
        const sourceStep = grid.steps.get(segmentFirst) ?? 1;
        specialDrafts.push({ first: segmentFirst, count: sourceCells.length, rows, columns, zigzag: true, confidence: 'high', sourceCells, sourceStep, sourceGridStep: sourceStep * grid.gridSubdivisions, x: minColumn, y: minRow });
      }
      segmentFirst = boundary + 1;
    });
  });
  if (specialDrafts.length) {
    const covered = new Set(specialDrafts.flatMap(draft => draft.sourceCells!.map(cell => cell.sourceIndex)));
    const retained = drafts.filter(draft => !Array.from({ length: draft.count }, (_, offset) => draft.first + offset).some(index => covered.has(index)));
    drafts.splice(0, drafts.length, ...retained, ...specialDrafts);
    drafts.sort((a, b) => a.first - b.first);
  }

  const suggestions = drafts.map((draft, index) => {
    const kind: PixelModuleKind = draft.sourceCells ? 'scan' : draft.rows > 1 ? 'matrix' : draft.columns > 1 ? 'strip' : 'single';
    let module = makeModule(
      draft.sourceCells ? `${draft.count} LED Scan path ${index + 1}` : draft.rows > 1 ? `${draft.rows}×${draft.columns} Suggested matrix` : `${draft.columns} LED Suggested strip`,
      kind,
      draft.first,
      draft.rows,
      draft.columns,
      index,
    );
    module = draft.sourceCells ? { ...module, sourceCells: draft.sourceCells, sourceStep: draft.sourceStep, sourceGridStep: draft.sourceGridStep } : detectModuleWiring(module, points, panels, pitch);
    module = {
      ...module,
      zigzag: draft.zigzag,
      wiringDetected: draft.confidence === 'high' || module.wiringDetected,
      ...(draft.sourceCells ? { x: draft.x ?? 0, y: draft.y ?? 0, width: Math.max(0, draft.columns - 1), height: Math.max(0, draft.rows - 1) } : {}),
    };
    return module;
  });
  return alignModulesToScanView(suggestions, points, camera, pitch);
}

function buildModuleMmfl(modules: PixelModule[], total: number, settings: ExportSettings) {
  const ranges = unassignedRanges(modules, total);
  if (ranges.length) throw new Error(`Assign all LED slots before MMFL export. ${ranges.reduce((sum, range) => sum + range.last - range.first + 1, 0)} remain unassigned.`);
  const grid = moduleGrid(modules, settings.channels);
  if (grid.collisions.length) throw new Error(`Move or resize modules before export: ${grid.collisions.length} grid collisions remain.`);
  if (grid.width * grid.height > 2000000) throw new Error('The module grid is too large for a practical MMFL fixture.');
  const values = Array.from({ length: grid.width * grid.height }, () => 0);
  grid.cells.forEach(cell => { if (!cell.hidden) values[cell.gridY * grid.width + cell.gridX] = cell.value; });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<LEDFixtureLibrary>\n  <LEDFixture favorite="1" group="Pixel Fixture Studio" product="${xmlEscape(settings.definition)}">\n    <PixelMapping avoidCrossUniversePixels="1" type="${settings.channels === 4 ? 'RGBW' : 'RGB'}" height="${grid.height}" width="${grid.width}">${values.join(' ')}</PixelMapping>\n  </LEDFixture>\n</LEDFixtureLibrary>\n`;
}

/** Find the indexed spatial run around one pixel, separating distant matrices and strips. */
function localIndexSegment(panel: Panel, points: MapPoint[], pitch: number, sourceIndex: number) {
  const valid = panel.indices.filter(index => points[index]?.status === 'ok').sort((a, b) => a - b);
  if (!valid.length) return { first: sourceIndex, last: sourceIndex };
  const segments: { first: number; last: number }[] = [];
  let first = valid[0];
  for (let offset = 1; offset < valid.length; offset++) {
    const previous = valid[offset - 1], current = valid[offset];
    const indexGap = current - previous;
    const spatialGap = dist(points[previous].xyz, points[current].xyz);
    if (spatialGap > pitch * Math.max(indexGap * 2.5, 4)) {
      segments.push({ first, last: previous });
      first = current;
    }
  }
  segments.push({ first, last: valid.at(-1)! });
  return segments.sort((a, b) => {
    const distanceTo = (segment: { first: number; last: number }) => sourceIndex < segment.first ? segment.first - sourceIndex : sourceIndex > segment.last ? sourceIndex - segment.last : 0;
    return distanceTo(a) - distanceTo(b);
  })[0];
}

/** Detect the serpentine row period nearest one pixel without assuming a square or fixed-size matrix. */
function detectSerpentineLayout(panel: Panel, points: MapPoint[], pitch: number, sourceIndex: number): SerpentineLayout | null {
  const panelSet = new Set(panel.indices);
  const usable = (index: number) => panelSet.has(index) && points[index]?.status === 'ok';
  const boundaries: number[] = [];
  const { first, last } = localIndexSegment(panel, points, pitch, sourceIndex);
  for (let index = first + 1; index <= last - 2; index++) {
    if (![index - 1, index, index + 1, index + 2].every(usable)) continue;
    const before = sub(points[index].xyz, points[index - 1].xyz);
    const after = sub(points[index + 2].xyz, points[index + 1].xyz);
    const turn = dist(points[index].xyz, points[index + 1].xyz);
    const beforeLength = Math.hypot(...before), afterLength = Math.hypot(...after);
    const directionChange = dot(before, after) / Math.max(beforeLength * afterLength, .0001);
    if (directionChange < -.55 && turn <= pitch * 2.5 && beforeLength >= pitch * .2 && beforeLength <= pitch * 2.5 && afterLength >= pitch * .2 && afterLength <= pitch * 2.5) boundaries.push(index);
  }
  const gapSamples = boundaries.slice(1).map((boundary, index) => ({
    gap: boundary - boundaries[index],
    midpoint: (boundary + boundaries[index]) / 2,
    left: boundaries[index],
    right: boundary,
  })).filter(sample => sample.gap >= 2 && sample.gap <= 2048);
  if (!gapSamples.length) return null;
  // Score every observed period by proximity and repeated local support. Row length and row count
  // remain independent, so 5x5, 9x9, 8x32, 32x8 and other local layouts can coexist.
  const periods = [...new Set(gapSamples.map(sample => sample.gap))].map(rowLength => {
    const matching = gapSamples.filter(sample => sample.gap === rowLength);
    const nearestDistance = Math.min(...matching.map(sample => Math.abs(sample.midpoint - sourceIndex)));
    const localSupport = matching.filter(sample => Math.abs(sample.midpoint - sourceIndex) <= rowLength * 6).length;
    const totalSupport = matching.length;
    const harmonicSupport = gapSamples.filter(sample => sample.gap % rowLength === 0).length;
    return { rowLength, matching, nearestDistance, localSupport, totalSupport, harmonicSupport, score: nearestDistance / rowLength - Math.min(localSupport, 6) * .65 };
  });
  // Missed row turns produce harmonic gaps (for example 16 instead of the real period 8).
  // Prefer the smallest repeated period that explains most observed gaps within this spatial run.
  const fundamental = periods.filter(candidate => candidate.totalSupport >= 2 && candidate.harmonicSupport >= Math.max(2, Math.ceil(gapSamples.length * .55))).sort((a, b) => a.rowLength - b.rowLength)[0];
  const selected = fundamental ?? periods.filter(candidate => candidate.nearestDistance <= candidate.rowLength * 4).sort((a, b) => a.score - b.score)[0];
  if (!selected) return null;
  const { rowLength } = selected;
  const matchingBoundaries = selected.matching.sort((a, b) => Math.abs(a.midpoint - sourceIndex) - Math.abs(b.midpoint - sourceIndex)).slice(0, 6).flatMap(sample => [sample.left, sample.right]);
  const boundaryPhase = mode(matchingBoundaries.map(boundary => modulo(boundary, rowLength)));
  const rowStartPhase = boundaryPhase === undefined ? modulo(first, rowLength) : modulo(boundaryPhase + 1, rowLength);
  return { rowLength, rowStartPhase };
}

/** Predict one missing serpentine cell from intact neighbouring rows and local row spacing. */
function estimateSerpentinePosition(sourceIndex: number, panel: Panel, points: MapPoint[], pitch: number) {
  const layout = detectSerpentineLayout(panel, points, pitch, sourceIndex);
  if (!layout) return null;
  const { rowLength, rowStartPhase } = layout;
  const rowStart = sourceIndex - modulo(sourceIndex - rowStartPhase, rowLength);
  const offset = sourceIndex - rowStart;
  const pointAt = (index: number) => {
    const point = points[index];
    return point && (point.status === 'ok' || point.status === 'inferred') ? point.xyz : null;
  };
  const predictions: Vec3[] = [];
  const previousRow = pointAt(rowStart - rowLength + (rowLength - 1 - offset));
  const twoRowsBack = pointAt(rowStart - 2 * rowLength + offset);
  if (previousRow && twoRowsBack) predictions.push(add(previousRow, sub(previousRow, twoRowsBack)));
  const nextRow = pointAt(rowStart + rowLength + (rowLength - 1 - offset));
  const twoRowsAhead = pointAt(rowStart + 2 * rowLength + offset);
  if (nextRow && twoRowsAhead) predictions.push(sub(nextRow, sub(twoRowsAhead, nextRow)));
  if (!predictions.length) return null;

  const sameRow = Array.from({ length: rowLength }, (_, localOffset) => ({ index: rowStart + localOffset, xyz: pointAt(rowStart + localOffset) })).filter(item => item.xyz && item.index !== sourceIndex) as { index: number; xyz: Vec3 }[];
  const nearest = sameRow.sort((a, b) => Math.abs(a.index - sourceIndex) - Math.abs(b.index - sourceIndex))[0];
  if (!nearest) return averageVec(predictions);
  const expectedDistance = Math.abs(nearest.index - sourceIndex) * pitch;
  const ranked = predictions.map(position => ({ position, score: Math.abs(dist(position, nearest.xyz) - expectedDistance) })).sort((a, b) => a.score - b.score);
  const compatible = ranked.filter(candidate => candidate.score <= ranked[0].score + pitch * .45 && dist(candidate.position, ranked[0].position) <= pitch * 1.5);
  return averageVec((compatible.length ? compatible : [ranked[0]]).map(candidate => candidate.position));
}

/** Fit a short 3D line to intact neighbours and project the measured pixel onto that line. */
function estimateLocalLinePosition(sourceIndex: number, panel: Panel, points: MapPoint[], pitch: number): LocalLineEstimate | null {
  const panelSet = new Set(panel.indices);
  const usable = (index: number) => panelSet.has(index) && points[index]?.status === 'ok' && index !== sourceIndex;
  const groups = [
    [sourceIndex - 2, sourceIndex - 1, sourceIndex + 1, sourceIndex + 2],
    [sourceIndex - 4, sourceIndex - 3, sourceIndex - 2, sourceIndex - 1],
    [sourceIndex + 1, sourceIndex + 2, sourceIndex + 3, sourceIndex + 4],
  ];
  const candidates = groups.flatMap(indices => {
    if (!indices.every(usable)) return [];
    // Reject groups containing a row jump or a large spatial break.
    for (let index = 1; index < indices.length; index++) {
      const sourceGap = indices[index] - indices[index - 1];
      const spatialGap = dist(points[indices[index - 1]].xyz, points[indices[index]].xyz);
      if (spatialGap < pitch * .15 * sourceGap || spatialGap > pitch * 2.2 * sourceGap) return [];
    }
    const neighbours = indices.map(index => points[index].xyz);
    const center = averageVec(neighbours);
    const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    neighbours.forEach(position => {
      const delta = sub(position, center);
      for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) covariance[row][column] += delta[row] * delta[column];
    });
    const direction = power(covariance, [1, .4, .2]);
    const residuals = neighbours.map(position => {
      const delta = sub(position, center);
      return Math.hypot(...sub(delta, scaleVec(direction, dot(delta, direction))));
    });
    const lineNoiseRatio = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length) / Math.max(pitch, .0001);
    // Curved corners and matrix turns are not straight-line evidence.
    if (lineNoiseRatio > .06) return [];
    const current = points[sourceIndex].xyz;
    const oneSided = sourceIndex < indices[0] || sourceIndex > indices.at(-1)!;
    if (oneSided && Math.min(dist(current, neighbours[0]), dist(current, neighbours.at(-1)!)) > pitch * 1.8) return [];
    const delta = sub(current, center);
    const position = add(center, scaleVec(direction, dot(delta, direction)));
    return [{ position, deviationRatio: dist(current, position) / Math.max(pitch, .0001), lineNoiseRatio, supportCount: neighbours.length }];
  });
  // At a legitimate row turn, one neighbour group follows the new line and another the old one.
  // Keeping the smallest correction prevents the turn itself from becoming a false positive.
  return candidates.sort((a, b) => a.deviationRatio - b.deviationRatio)[0] ?? null;
}

/** Learn a quantised row/column model from the complete panel measurement. */
function buildMatrixModel(panel: Panel, points: MapPoint[], fallbackPitch: number): MatrixModel | null {
  const basis = getPanelBasis(panel, points);
  const valid = panel.indices.map(index => points[index]).filter(point => point?.status === 'ok');
  if (!basis || valid.length < 8) return null;
  const projected = valid.map(point => ({ point, ...projectXyz(point.xyz, basis) }));
  const nearest = projected.map((point, index) => Math.min(...projected.filter((_, other) => index !== other).map(other => Math.hypot(point.u - other.u, point.v - other.v)))).filter(Number.isFinite);
  const averagePitch = Math.max(trimmedMean(nearest), fallbackPitch * .25, .0001);
  const consecutive = projected.flatMap((point, index) => {
    const next = projected[index + 1];
    if (!next || next.point.sourceIndex !== point.point.sourceIndex + 1) return [];
    const du = next.u - point.u, dv = next.v - point.v, length = Math.hypot(du, dv);
    return length <= averagePitch * 1.8 ? [{ sourceIndex: point.point.sourceIndex, du, dv, length }] : [];
  });
  if (consecutive.length < 4) return null;

  const angleBins = Array.from({ length: 36 }, () => 0);
  consecutive.forEach(step => {
    const angle = modulo(Math.atan2(step.dv, step.du), Math.PI);
    angleBins[Math.min(35, Math.floor(angle / Math.PI * angleBins.length))] += 1 / Math.max(Math.abs(step.length - averagePitch), averagePitch * .08);
  });
  const dominantBin = angleBins.indexOf(Math.max(...angleBins));
  const rowAngle = (dominantBin + .5) / angleBins.length * Math.PI;
  const rowUnit = { u: Math.cos(rowAngle), v: Math.sin(rowAngle) };
  const columnUnit = { u: -rowUnit.v, v: rowUnit.u };
  const anchor = projected[0];
  const gridByIndex = new Map(projected.map(item => {
    const du = item.u - anchor.u, dv = item.v - anchor.v;
    return [item.point.sourceIndex, { x: Math.round((du * rowUnit.u + dv * rowUnit.v) / averagePitch), y: Math.round((du * columnUnit.u + dv * columnUnit.v) / averagePitch) }] as const;
  }));
  const gridSteps = consecutive.flatMap(step => {
    const current = gridByIndex.get(step.sourceIndex), next = gridByIndex.get(step.sourceIndex + 1);
    if (!current || !next) return [];
    const dx = next.x - current.x, dy = next.y - current.y;
    return Math.abs(dx) + Math.abs(dy) <= 2 ? [{ sourceIndex: step.sourceIndex, dx, dy }] : [];
  });
  const breaks = gridSteps.filter(step => Math.abs(step.dy) >= Math.abs(step.dx));
  const breakGaps = breaks.slice(1).map((step, index) => step.sourceIndex - breaks[index].sourceIndex).filter(gap => gap >= 2);
  const xValues = [...gridByIndex.values()].map(value => value.x);
  const rowLength = Math.max(2, Math.round(breakGaps.length ? median(breakGaps) : Math.max(...xValues) - Math.min(...xValues) + 1));
  const breakPhase = mode(breaks.map(step => modulo(step.sourceIndex, rowLength))) ?? modulo(panel.indices[0] + rowLength - 1, rowLength);
  const rowStartPhase = modulo(breakPhase + 1, rowLength);
  const rowOf = (sourceIndex: number) => Math.floor((sourceIndex - rowStartPhase) / rowLength);
  const columnOf = (sourceIndex: number) => modulo(sourceIndex - rowStartPhase, rowLength);
  const horizontal = gridSteps.filter(step => Math.abs(step.dx) > Math.abs(step.dy));
  const signs = new Set(horizontal.map(step => Math.sign(step.dx)).filter(Boolean));
  const serpentine = signs.size > 1;
  const referenceRow = Math.min(...valid.map(point => rowOf(point.sourceIndex)));
  const referenceSteps = horizontal.filter(step => modulo(rowOf(step.sourceIndex) - referenceRow, 2) === 0);
  const xSign = Math.sign(median((referenceSteps.length ? referenceSteps : horizontal).map(step => step.dx))) || 1;
  const ySign = Math.sign(median(breaks.map(step => step.dy))) || 1;
  const patternX = (sourceIndex: number) => {
    const row = rowOf(sourceIndex), column = columnOf(sourceIndex);
    const reverse = serpentine && modulo(row - referenceRow, 2) === 1;
    return (reverse ? rowLength - 1 - column : column) * xSign;
  };
  const patternY = (sourceIndex: number) => (rowOf(sourceIndex) - referenceRow) * ySign;
  const xOrigin = median(valid.map(point => gridByIndex.get(point.sourceIndex)!.x - patternX(point.sourceIndex)));
  const yOrigin = median(valid.map(point => gridByIndex.get(point.sourceIndex)!.y - patternY(point.sourceIndex)));
  const positionAt = (sourceIndex: number): Vec3 => {
    const gridX = xOrigin + patternX(sourceIndex), gridY = yOrigin + patternY(sourceIndex);
    const u = anchor.u + (rowUnit.u * gridX + columnUnit.u * gridY) * averagePitch;
    const v = anchor.v + (rowUnit.v * gridX + columnUnit.v * gridY) * averagePitch;
    return add(basis.center, add(scaleVec(basis.e1, u), scaleVec(basis.e2, -v)));
  };
  return { averagePitch, rowLength, serpentine, positionAt };
}

/** Combine the matrix prediction with residuals from four previous and four following pixels. */
function estimateExpectedPosition(sourceIndex: number, panel: Panel, points: MapPoint[], pitch: number, model = buildMatrixModel(panel, points, pitch)) {
  const panelSet = new Set(panel.indices);
  const valid = points.filter(point => panelSet.has(point.sourceIndex) && point.status === 'ok' && point.sourceIndex !== sourceIndex);
  const before = valid.filter(point => point.sourceIndex < sourceIndex).sort((a, b) => b.sourceIndex - a.sourceIndex).slice(0, 4);
  const after = valid.filter(point => point.sourceIndex > sourceIndex).sort((a, b) => a.sourceIndex - b.sourceIndex).slice(0, 4);
  const neighbours = [...before, ...after];
  if (model && neighbours.length >= 2) {
    const residuals = neighbours.map(point => sub(point.xyz, model.positionAt(point.sourceIndex))).filter(residual => Math.hypot(...residual) <= model.averagePitch * 2.5);
    const correction = residuals.length ? averageVec(residuals) : [0, 0, 0] as Vec3;
    return { position: add(model.positionAt(sourceIndex), correction), supportCount: neighbours.length, model };
  }
  const candidates: Vec3[] = [];
  if (before[0] && after[0]) {
    const span = after[0].sourceIndex - before[0].sourceIndex;
    candidates.push(add(before[0].xyz, scaleVec(sub(after[0].xyz, before[0].xyz), (sourceIndex - before[0].sourceIndex) / Math.max(span, 1))));
  }
  if (before[0] && before[1]) {
    const step = scaleVec(sub(before[0].xyz, before[1].xyz), 1 / Math.max(before[0].sourceIndex - before[1].sourceIndex, 1));
    candidates.push(add(before[0].xyz, scaleVec(step, sourceIndex - before[0].sourceIndex)));
  }
  if (after[0] && after[1]) {
    const step = scaleVec(sub(after[1].xyz, after[0].xyz), 1 / Math.max(after[1].sourceIndex - after[0].sourceIndex, 1));
    candidates.push(sub(after[0].xyz, scaleVec(step, after[0].sourceIndex - sourceIndex)));
  }
  return candidates.length ? { position: averageVec(candidates), supportCount: neighbours.length, model: null } : null;
}

/** Suggest generated pixels and only measured points that are clear local outliers. */
function findRepairSuggestions(panel: Panel, points: MapPoint[], pitch: number, threshold: number, lineThreshold: number, includeMeasured = false): RepairSuggestion[] {
  if (!panel.indices.length) return [];
  const panelSet = new Set(panel.indices);
  const model = buildMatrixModel(panel, points, pitch);
  const sorted = [...panel.indices].sort((a, b) => a - b);
  const minIndex = sorted[0], maxIndex = sorted[sorted.length - 1];
  return points.slice(minIndex, maxIndex + 1).flatMap<RepairSuggestion>(point => {
    const isMissing = point.status === 'placeholder';
    const isGenerated = point.status === 'inferred' || point.status === 'manual';
    if (!isMissing && !panelSet.has(point.sourceIndex)) return [];
    if (!isMissing && !isGenerated && !includeMeasured) return [];
    const estimate = estimateExpectedPosition(point.sourceIndex, panel, points, pitch, model);
    const lineEstimate = !isMissing && !isGenerated && includeMeasured ? estimateLocalLinePosition(point.sourceIndex, panel, points, pitch) : null;
    if ((!estimate || estimate.supportCount < 2) && !lineEstimate) return [];
    const averagePitch = model?.averagePitch ?? pitch;
    const deviationRatio = isMissing ? Infinity : estimate ? dist(point.xyz, estimate.position) / Math.max(averagePitch, .0001) : 0;
    // Generated positions are reviewed when a supported model can improve them. For measured
    // points, a local straight-line fit is the gate: a broad/global matrix model alone must never
    // flag a whole valid matrix or a legitimate row turn.
    if (isGenerated) {
      if (!estimate || estimate.supportCount < 4 || deviationRatio <= Math.max(lineThreshold, .08)) return [];
      const confidence: RepairSuggestion['confidence'] = estimate.supportCount >= 6 && model ? 'high' : 'medium';
      return [{ id: `repair-${point.sourceIndex}`, sourceIndex: point.sourceIndex, before: point.xyz, after: estimate.position, reason: 'generated-position', confidence, deviationRatio, supportCount: estimate.supportCount, selected: false }];
    }
    const isLineDeviation = Boolean(lineEstimate
      && lineEstimate.deviationRatio > lineThreshold
      && lineEstimate.deviationRatio > Math.max(lineEstimate.lineNoiseRatio * 5, .08)
      && (!estimate || deviationRatio > threshold));
    if (!isMissing && !isLineDeviation) return [];
    if (isLineDeviation && lineEstimate) {
      const confidence: RepairSuggestion['confidence'] = lineEstimate.deviationRatio > Math.max(lineThreshold * 2, lineEstimate.lineNoiseRatio * 8) ? 'high' : 'medium';
      return [{ id: `repair-${point.sourceIndex}`, sourceIndex: point.sourceIndex, before: point.xyz, after: lineEstimate.position, reason: 'local-line-deviation', confidence, deviationRatio: lineEstimate.deviationRatio, supportCount: lineEstimate.supportCount, selected: false }];
    }
    if (!estimate) return [];
    const confidence: RepairSuggestion['confidence'] = estimate.supportCount >= 6 && model ? 'high' : estimate.supportCount >= 4 ? 'medium' : 'low';
    return [{ id: `repair-${point.sourceIndex}`, sourceIndex: point.sourceIndex, before: point.xyz, after: estimate.position, reason: isMissing ? 'missing-reading' : 'threshold-deviation', confidence, deviationRatio, supportCount: estimate.supportCount, selected: false }];
  });
}

/** Automatically place sparse CSV slots without allowing inferred points to train the model. */
function placeMissingCoordinates(points: MapPoint[], panels: Panel[], pitch: number, missingIndices: Set<number>) {
  const placedPoints = points.map(point => ({ ...point, xyz: [...point.xyz] as Vec3 }));
  const placedPanels = panels.map(panel => ({ ...panel, indices: [...panel.indices] }));
  let placed = 0;

  [...missingIndices].sort((a, b) => a - b).forEach(sourceIndex => {
    const point = placedPoints[sourceIndex];
    if (!point || !placedPanels.length) return;
    const panel = [...placedPanels].sort((a, b) => {
      const distanceToRange = (candidate: Panel) => {
        const first = candidate.indices[0] ?? Infinity, last = candidate.indices.at(-1) ?? -Infinity;
        return sourceIndex < first ? first - sourceIndex : sourceIndex > last ? sourceIndex - last : 0;
      };
      return distanceToRange(a) - distanceToRange(b);
    })[0];
    if (!panel?.indices.length) return;
    const model = buildMatrixModel(panel, placedPoints, pitch);
    const estimate = estimateExpectedPosition(sourceIndex, panel, placedPoints, pitch, model);
    const serpentinePosition = estimateSerpentinePosition(sourceIndex, panel, placedPoints, pitch);
    const position = serpentinePosition ?? estimate?.position ?? model?.positionAt(sourceIndex);
    if (!position || !position.every(Number.isFinite)) return;
    point.xyz = position;
    point.status = 'inferred';
    panel.indices = [...new Set([...panel.indices, sourceIndex])].sort((a, b) => a - b);
    placed += 1;
  });

  return { points: placedPoints, panels: placedPanels, placed, unresolved: missingIndices.size - placed };
}

function xmlEscape(value: string) { return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c)); }
function safeName(value: string) { return value.trim().replace(/[^a-z0-9äöüß_-]+/gi, '-').replace(/^-|-$/g, '') || 'fixture'; }

function layoutPanels(panels: Panel[], points: MapPoint[], ledSize: number) {
  let offsetX = ledSize * 2;
  let maxHeight = 100;
  const laid: { panel: Panel; pixels: (Projection & { x: number; y: number })[] }[] = [];
  panels.forEach(panel => {
    const baseProjected = projectPanel(panel, points);
    const projected = transformProjection(baseProjected, panel.transform, false);
    const uMin = Math.min(...projected.map(p => p.u)), uMax = Math.max(...projected.map(p => p.u));
    const vMin = Math.min(...projected.map(p => p.v)), vMax = Math.max(...projected.map(p => p.v));
    const nearest2d = baseProjected.map((p, i) => Math.min(...baseProjected.filter((_, j) => i !== j).map(q => Math.hypot(p.u - q.u, p.v - q.v)))).filter(Number.isFinite);
    const scale = 14 / Math.max(median(nearest2d), .001) * panel.transform.scale;
    const pixels = projected.map(p => ({ ...p, x: offsetX + (p.u - uMin) * scale, y: ledSize * 2 + (p.v - vMin) * scale }));
    const width = Math.max((uMax - uMin) * scale + ledSize * 4, ledSize * 6);
    maxHeight = Math.max(maxHeight, (vMax - vMin) * scale + ledSize * 4);
    laid.push({ panel, pixels }); offsetX += width + 36;
  });
  return { groups: laid, width: Math.ceil(offsetX), height: Math.ceil(maxHeight) };
}

function addressMap(indices: number[], universeStart: number, channelStart: number, channels: number) {
  let universe = universeStart, channel = channelStart;
  const result = new Map<number, { universe: number; channel: number }>();
  indices.sort((a, b) => a - b).forEach(index => {
    if (channel + channels - 1 > 512) { universe += 1; channel = 1; }
    result.set(index, { universe, channel }); channel += channels;
  });
  return result;
}

/** Generate MadMapper 6.1 SVG fixture instances with explicit DMX attributes. */
function buildSvg(panels: Panel[], points: MapPoint[], settings: ExportSettings) {
  const layout = layoutPanels(panels, points, settings.ledSize);
  const indices = panels.flatMap(p => p.indices).sort((a, b) => a - b);
  const addresses = addressMap(indices, settings.universe, settings.channel, settings.channels);
  const groups = layout.groups.map(group => `  <g id="${xmlEscape(group.panel.name)}">\n${group.pixels.map(pixel => {
    const patch = addresses.get(pixel.sourceIndex)!;
    return `    <rect id="${xmlEscape(group.panel.name)}-Pixel-${String(pixel.sourceIndex + 1).padStart(4, '0')}" x="${pixel.x.toFixed(2)}" y="${pixel.y.toFixed(2)}" width="${settings.ledSize}" height="${settings.ledSize}" universe="${patch.universe}" channel="${patch.channel}" fixture_type="fixture_quad" fixture_definition="${xmlEscape(settings.definition)}"/>`;
  }).join('\n')}\n  </g>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">\n${groups}\n</svg>\n`;
}

/** Generate MadMapper's semicolon-delimited fixture instance table. */
function buildCsv(panels: Panel[], points: MapPoint[], settings: ExportSettings) {
  const layout = layoutPanels(panels, points, settings.ledSize);
  const indices = panels.flatMap(p => p.indices).sort((a, b) => a - b);
  const addresses = addressMap(indices, settings.universe, settings.channel, settings.channels);
  const rows = ['Fixture Definition Name;Start Universe;Start Channel;StartX;StartY;EndX;EndY;Width;Fixture Name (optional)'];
  layout.groups.forEach(group => group.pixels.forEach(pixel => {
    const patch = addresses.get(pixel.sourceIndex)!;
    rows.push(`${settings.definition};${patch.universe};${patch.channel};${pixel.x.toFixed(2)};${pixel.y.toFixed(2)};${(pixel.x + settings.ledSize).toFixed(2)};${(pixel.y + settings.ledSize).toFixed(2)};${settings.ledSize};${group.panel.name}/Pixel-${String(pixel.sourceIndex + 1).padStart(4, '0')}`);
  }));
  return rows.join('\n') + '\n';
}

type GridCell = { x: number; y: number; value: number; sourceIndex: number };

function makeCellsUnique(cells: GridCell[]) {
  const occupied = new Set<string>();
  return cells.map(cell => {
    let x = cell.x, y = cell.y, radius = 0;
    while (occupied.has(`${x}:${y}`)) {
      radius += 1;
      const alternatives: [number, number][] = [];
      for (let delta = -radius; delta <= radius; delta++) alternatives.push(
        [cell.x + delta, cell.y - radius], [cell.x + delta, cell.y + radius],
        [cell.x - radius, cell.y + delta], [cell.x + radius, cell.y + delta],
      );
      const available = alternatives.find(([candidateX, candidateY]) => candidateX >= 0 && candidateY >= 0 && !occupied.has(`${candidateX}:${candidateY}`));
      if (available) [x, y] = available;
    }
    occupied.add(`${x}:${y}`);
    return { ...cell, x, y };
  });
}

/** Remove globally empty rows and columns without changing LED order or creating collisions. */
function compactCellAxes(cells: GridCell[]) {
  const xs = [...new Set(cells.map(cell => cell.x))].sort((a, b) => a - b);
  const ys = [...new Set(cells.map(cell => cell.y))].sort((a, b) => a - b);
  const xRank = new Map(xs.map((value, index) => [value, index]));
  const yRank = new Map(ys.map((value, index) => [value, index]));
  return cells.map(cell => ({ ...cell, x: xRank.get(cell.x)!, y: yRank.get(cell.y)! }));
}

/** Use the same compact, collision-free cells for MMFL and its transparent preview grid. */
function quantizePanelGrid(panel: Panel, points: MapPoint[], channels = 3) {
  const baseProjected = projectPanel(panel, points);
  const oriented = transformProjection(baseProjected, panel.transform, false);
  const projected = transformProjection(baseProjected, panel.transform);
  if (!projected.length) return { projected, cells: [] as GridCell[], width: 1, height: 1, baseWidth: 1, baseHeight: 1 };
  const nearest2d = baseProjected.map((p, i) => Math.min(...baseProjected.filter((_, j) => i !== j).map(q => Math.hypot(p.u - q.u, p.v - q.v)))).filter(Number.isFinite);
  const basePitch = Math.max(median(nearest2d), .001);
  const uMin = Math.min(...oriented.map(point => point.u));
  const vMin = Math.min(...oriented.map(point => point.v));
  // A panel may combine sections with different physical spacing. Reduce the cell pitch until
  // rounding no longer places two LEDs in the same MMFL cell; the old exporter silently dropped
  // every later LED in such a collision.
  let pitch = basePitch;
  let cells = oriented.map((point, rank) => ({ x: Math.round((point.u - uMin) / pitch), y: Math.round((point.v - vMin) / pitch), value: 1 + rank * channels, sourceIndex: point.sourceIndex }));
  for (let attempt = 0; attempt < 24; attempt++) {
    const occupied = new Set(cells.map(cell => `${cell.x}:${cell.y}`));
    if (occupied.size === cells.length) break;
    pitch *= .9;
    cells = oriented.map((point, rank) => ({ x: Math.round((point.u - uMin) / pitch), y: Math.round((point.v - vMin) / pitch), value: 1 + rank * channels, sourceIndex: point.sourceIndex }));
  }
  cells = compactCellAxes(makeCellsUnique(cells));
  const baseWidth = Math.max(...cells.map(cell => cell.x)) + 1;
  const baseHeight = Math.max(...cells.map(cell => cell.y)) + 1;
  // Scale the compact integer layout, not the original floating coordinates. This keeps the
  // 2D size control effective instead of having collision avoidance silently cancel it.
  cells = makeCellsUnique(cells.map(cell => ({ ...cell, x: Math.round(cell.x * panel.transform.scale), y: Math.round(cell.y * panel.transform.scale) })));
  if (panel.transform.scale <= 1) cells = compactCellAxes(cells);
  const width = Math.max(...cells.map(cell => cell.x)) + 1;
  const height = Math.max(...cells.map(cell => cell.y)) + 1;
  return { projected, cells, width, height, baseWidth, baseHeight };
}

/** Generate an experimental MMFL fixture library using a quantised LED grid. */
function buildMmfl(panels: Panel[], points: MapPoint[], settings: ExportSettings) {
  const fixtures = panels.map(panel => {
    const { cells, width, height } = quantizePanelGrid(panel, points, settings.channels);
    const grid = Array.from({ length: width * height }, () => 0);
    cells.forEach(cell => { if (!grid[cell.y * width + cell.x]) grid[cell.y * width + cell.x] = cell.value; });
    const fixtureName = panels.length === 1 ? settings.definition : `${settings.definition} · ${panel.name}`;
    return `  <LEDFixture favorite="1" group="Pixel Fixture Studio" product="${xmlEscape(fixtureName)}">\n    <PixelMapping avoidCrossUniversePixels="1" type="${settings.channels === 4 ? 'RGBW' : 'RGB'}" height="${height}" width="${width}">${grid.join(' ')}</PixelMapping>\n  </LEDFixture>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<LEDFixtureLibrary>\n${fixtures.join('\n')}\n</LEDFixtureLibrary>\n`;
}

type ExportSettings = { universe: number; channel: number; channels: number; ledSize: number; definition: string };

function download(name: string, content: string, type: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type })); link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function MapCanvas({ points, panels, selectionMode, showPixelNumbers, hiddenIndices = [], selectedIndices, onSelection, camera, onCameraChange, language }: { points: MapPoint[]; panels: Panel[]; selectionMode: boolean; showPixelNumbers: boolean; hiddenIndices?: number[]; selectedIndices: number[]; onSelection: (indices: number[], additive?: boolean) => void; camera: Camera; onCameraChange: (camera: Camera) => void; language: Language }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number; selecting: boolean; additive: boolean; moved: boolean } | null>(null);
  const [box, setBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const projectedRef = useRef<{ index: number; x: number; y: number }[]>([]);

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const visible = panels.filter(p => p.enabled).flatMap(panel => panel.indices.map(index => ({ index, color: panel.color }))).filter(item => points[item.index]);
      const selected = new Set(selectedIndices);
      const hidden = new Set(hiddenIndices);
      const center: Vec3 = [0, 0, 0]; visible.forEach(item => points[item.index].xyz.forEach((n, i) => center[i] += n / Math.max(visible.length, 1)));
      const rotated = visible.map(item => {
        const p = points[item.index].xyz, x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
        const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
        const x1 = x * cy - z * sy, z1 = x * sy + z * cy, y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
        return { ...item, x: x1, y: y1, z: z2 };
      });
      const span = Math.max(...rotated.map(p => Math.abs(p.x)), ...rotated.map(p => Math.abs(p.y)), 1);
      const scale = Math.min(rect.width, rect.height) * .39 / span * camera.zoom;
      ctx.strokeStyle = 'rgba(137,151,178,.12)'; ctx.lineWidth = 1;
      for (let i = -5; i <= 5; i++) { ctx.beginPath(); ctx.moveTo(rect.width * .08, rect.height / 2 + i * 38); ctx.lineTo(rect.width * .92, rect.height / 2 + i * 38); ctx.stroke(); }
      rotated.sort((a, b) => a.z - b.z);
      projectedRef.current = rotated.map(p => ({ index: p.index, x: rect.width / 2 + p.x * scale, y: rect.height / 2 - p.y * scale }));
      rotated.forEach((p, i) => {
        const screen = projectedRef.current[i], isSelected = selected.has(p.index), isHidden = hidden.has(p.index);
        ctx.shadowColor = p.color; ctx.shadowBlur = isHidden ? 0 : isSelected ? 15 : 8; ctx.fillStyle = isHidden ? '#475064' : isSelected ? '#ffffff' : p.color; ctx.globalAlpha = isHidden ? .34 : .66 + i / Math.max(rotated.length, 1) * .34;
        ctx.beginPath(); ctx.arc(screen.x, screen.y, Math.max(2, Math.min(isSelected ? 6.5 : 4.2, (isSelected ? 3.8 : 2.3) * camera.zoom)), 0, Math.PI * 2); ctx.fill();
        if (isHidden) { ctx.strokeStyle = '#8c96a9'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(screen.x - 4, screen.y - 4); ctx.lineTo(screen.x + 4, screen.y + 4); ctx.moveTo(screen.x + 4, screen.y - 4); ctx.lineTo(screen.x - 4, screen.y + 4); ctx.stroke(); }
        if (isSelected) { ctx.globalAlpha = 1; ctx.strokeStyle = '#ff4f87'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(screen.x, screen.y, Math.max(7, 5 * camera.zoom), 0, Math.PI * 2); ctx.stroke(); }
        if (showPixelNumbers) { ctx.globalAlpha = .95; ctx.shadowBlur = 3; ctx.font = `${Math.max(9, Math.min(13, 9 * camera.zoom))}px ui-monospace, monospace`; ctx.fillStyle = '#eef3ff'; ctx.fillText(String(p.index + 1), screen.x + 6, screen.y - 6); }
      });
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      points.filter(p => p.status !== 'ok').forEach(p => {
        const visiblePoint = projectedRef.current.find(q => q.index === p.sourceIndex); if (!visiblePoint) return;
        ctx.strokeStyle = p.status === 'outlier' ? '#ffb454' : p.status === 'manual' ? '#ffd166' : p.status === 'inferred' ? '#49dcb3' : '#5f6a80'; ctx.strokeRect(visiblePoint.x - 4, visiblePoint.y - 4, 8, 8);
      });
      if (box) { ctx.fillStyle = 'rgba(255,79,135,.12)'; ctx.strokeStyle = '#ff4f87'; ctx.setLineDash([5, 4]); ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.setLineDash([]); }
    };
    render(); const observer = new ResizeObserver(render); observer.observe(canvas); return () => observer.disconnect();
  }, [points, panels, box, revision, camera, selectedIndices, showPixelNumbers, hiddenIndices]);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const r = event.currentTarget.getBoundingClientRect(); const x = event.clientX - r.left, y = event.clientY - r.top;
    const selecting = selectionMode || event.shiftKey;
    drag.current = { x, y, yaw: camera.yaw, pitch: camera.pitch, selecting, additive: event.shiftKey || event.ctrlKey || event.metaKey, moved: false };
    if (selecting) setBox({ x1: x, y1: y, x2: x, y2: y });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return; const r = event.currentTarget.getBoundingClientRect(); const x = event.clientX - r.left, y = event.clientY - r.top;
    if (Math.hypot(x - drag.current.x, y - drag.current.y) > 4) drag.current.moved = true;
    if (drag.current.selecting) setBox(old => old ? { ...old, x2: x, y2: y } : null);
    else { onCameraChange({ ...camera, yaw: drag.current.yaw + (x - drag.current.x) * .008, pitch: Math.max(-1.5, Math.min(1.5, drag.current.pitch + (y - drag.current.y) * .008)) }); setRevision(v => v + 1); }
  };
  const pointerUp = () => {
    if (!drag.current) return;
    if (drag.current.selecting && box && drag.current.moved) {
      const minX = Math.min(box.x1, box.x2), maxX = Math.max(box.x1, box.x2), minY = Math.min(box.y1, box.y2), maxY = Math.max(box.y1, box.y2);
      onSelection(projectedRef.current.filter(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY).map(p => p.index), drag.current.additive);
    } else if (!drag.current.moved) {
      const nearest = projectedRef.current.map(point => ({ ...point, distance: Math.hypot(point.x - drag.current!.x, point.y - drag.current!.y) })).sort((a, b) => a.distance - b.distance)[0];
      if (nearest?.distance <= 14) onSelection([nearest.index], drag.current.additive);
      else if (!drag.current.additive) onSelection([]);
    }
    setBox(null);
    drag.current = null;
  };
  const wheel = (event: React.WheelEvent<HTMLCanvasElement>) => { event.preventDefault(); onCameraChange({ ...camera, zoom: Math.max(.3, Math.min(5, camera.zoom * Math.exp(-event.deltaY * .001))) }); setRevision(v => v + 1); };

  return <canvas ref={ref} className={`map-canvas ${selectionMode ? 'selecting' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel} aria-label={translated(language, 'Interactive 3D preview of the LED coordinates', 'Interaktive 3D-Vorschau der LED-Koordinaten')} />;
}

function normalizeDegrees(value: number) {
  let normalized = value % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;
  return Math.round(normalized * 10) / 10;
}

function FixturePreview({ panel, points, ledSize, interactive = false, showOutputGrid = false, onTransform, language }: { panel?: Panel; points: MapPoint[]; ledSize: number; interactive?: boolean; showOutputGrid?: boolean; onTransform?: (transform: PanelTransform) => void; language: Language }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ angle: number; rotation: number } | null>(null);
  useEffect(() => {
    const canvas = ref.current, baseProjected = panel ? projectPanel(panel, points) : [], projected = panel ? adjustedPanelProjection(panel, points) : []; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
      const centerX = rect.width / 2, centerY = rect.height / 2;
      ctx.strokeStyle = 'rgba(137,151,178,.1)'; ctx.lineWidth = 1;
      for (let x = centerX % 28; x < rect.width; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke(); }
      for (let y = centerY % 28; y < rect.height; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.moveTo(0, centerY); ctx.lineTo(rect.width, centerY); ctx.moveTo(centerX, 0); ctx.lineTo(centerX, rect.height); ctx.stroke();
      if (!projected.length || !baseProjected.length) return;
      const span = Math.max(...baseProjected.flatMap(point => [Math.abs(point.u), Math.abs(point.v)]), .001);
      const scale = Math.min(rect.width, rect.height) * .4 / span;
      if (showOutputGrid && panel) {
        const grid = quantizePanelGrid(panel, points);
        const occupied = new Set(grid.cells.map(cell => `${cell.x}:${cell.y}`));
        const cellSize = Math.max(3, Math.min(rect.width / (grid.baseWidth + 3), rect.height / (grid.baseHeight + 3)) * .9);
        const gridCenterX = centerX - (grid.width - 1) * cellSize / 2;
        const gridCenterY = centerY - (grid.height - 1) * cellSize / 2;
        for (let row = 0; row < grid.height; row++) for (let column = 0; column < grid.width; column++) {
          const x = gridCenterX + column * cellSize;
          const y = gridCenterY + row * cellSize;
          ctx.fillStyle = occupied.has(`${column}:${row}`) ? 'rgba(140,124,255,.12)' : 'rgba(140,124,255,.035)';
          ctx.strokeStyle = occupied.has(`${column}:${row}`) ? 'rgba(184,174,255,.5)' : 'rgba(140,124,255,.22)';
          ctx.lineWidth = 1; ctx.fillRect(x - cellSize / 2, y - cellSize / 2, cellSize, cellSize); ctx.strokeRect(x - cellSize / 2, y - cellSize / 2, cellSize, cellSize);
        }
        const cellByIndex = new Map(grid.cells.map(cell => [cell.sourceIndex, cell]));
        projected.forEach((point, index) => {
          const cell = cellByIndex.get(point.sourceIndex); if (!cell) return;
          const x = gridCenterX + cell.x * cellSize, y = gridCenterY + cell.y * cellSize;
          ctx.fillStyle = panel.color; ctx.shadowColor = panel.color; ctx.shadowBlur = interactive ? 7 : 4; ctx.globalAlpha = .62 + .38 * index / projected.length;
          const size = Math.max(2.4, Math.min(cellSize * .65, ledSize / (interactive ? 1.5 : 2.5)));
          ctx.fillRect(x - size / 2, y - size / 2, size, size);
        });
        ctx.globalAlpha = 1; ctx.shadowBlur = 0;
        return;
      }
      projected.forEach((point, index) => {
        const x = centerX + point.u * scale, y = centerY + point.v * scale;
        ctx.fillStyle = panel?.color ?? '#ff4f87'; ctx.shadowColor = panel?.color ?? '#ff4f87'; ctx.shadowBlur = interactive ? 7 : 4; ctx.globalAlpha = .62 + .38 * index / projected.length;
        const size = Math.max(2.4, Math.min(7, ledSize / (interactive ? 1.5 : 2.5)));
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      });
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    };
    render(); const observer = new ResizeObserver(render); observer.observe(canvas); return () => observer.disconnect();
  }, [panel, points, ledSize, interactive, showOutputGrid]);

  const pointerAngle = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.atan2(event.clientY - rect.top - rect.height / 2, event.clientX - rect.left - rect.width / 2);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!interactive || !panel || !onTransform) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { angle: pointerAngle(event), rotation: panel.transform.rotation };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !panel || !onTransform) return;
    const delta = (pointerAngle(event) - drag.current.angle) * 180 / Math.PI;
    onTransform({ ...panel.transform, rotation: normalizeDegrees(drag.current.rotation + delta) });
  };
  const pointerUp = () => { drag.current = null; };
  const wheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!interactive || !panel || !onTransform) return;
    event.preventDefault();
    onTransform({ ...panel.transform, scale: Math.max(.25, Math.min(4, panel.transform.scale * Math.exp(-event.deltaY * .001))) });
  };

  return <canvas ref={ref} className={`fixture-canvas ${interactive ? 'interactive' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onWheel={wheel} aria-label={interactive ? translated(language, 'Interactive 2D alignment: drag to rotate, use the wheel to scale', 'Interaktive 2D-Ausrichtung: ziehen dreht, Mausrad skaliert') : translated(language, '2D projection as shown in MadMapper', '2D-Projektion wie in MadMapper')} />;
}

function ModulePreview({ modules, activeId, channels, showNumbers, onSelect, onChange, language }: { modules: PixelModule[]; activeId: string; channels: number; showNumbers: boolean; onSelect: (id: string) => void; onChange: (module: PixelModule) => void; language: Language }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const hitAreas = useRef<{ id: string; x: number; y: number; radius: number }[]>([]);
  const pixelsPerCell = useRef(12);

  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
      const grid = moduleGrid(modules, channels);
      const scale = Math.max(5, Math.min(24, Math.min((rect.width - 60) / Math.max(grid.width, 1), (rect.height - 60) / Math.max(grid.height, 1))));
      pixelsPerCell.current = scale;
      const originX = rect.width / 2 - (grid.width - 1) * scale / 2;
      const originY = rect.height / 2 - (grid.height - 1) * scale / 2;
      const collisionKeys = new Set<string>();
      const seen = new Set<string>();
      grid.cells.forEach(cell => { const key = `${cell.gridX}:${cell.gridY}`; if (seen.has(key)) collisionKeys.add(key); seen.add(key); });

      ctx.lineWidth = 1;
      for (let row = 0; row < grid.height; row++) for (let column = 0; column < grid.width; column++) {
        const x = originX + column * scale, y = originY + row * scale;
        ctx.strokeStyle = 'rgba(140,151,178,.14)';
        ctx.strokeRect(x - scale * .43, y - scale * .43, scale * .86, scale * .86);
      }

      hitAreas.current = [];
      grid.cells.forEach(cell => {
        const module = modules.find(item => item.id === cell.moduleId); if (!module) return;
        const x = originX + cell.gridX * scale, y = originY + cell.gridY * scale;
        const active = module.id === activeId, collision = collisionKeys.has(`${cell.gridX}:${cell.gridY}`);
        hitAreas.current.push({ id: module.id, x, y, radius: Math.max(scale * .65, 9) });
        ctx.globalAlpha = cell.hidden ? .42 : 1;
        ctx.fillStyle = collision ? '#ff704d' : cell.hidden ? '#202838' : module.color;
        ctx.strokeStyle = active ? '#ffffff' : collision ? '#ffb454' : module.color;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath(); ctx.roundRect(x - scale * .34, y - scale * .34, scale * .68, scale * .68, Math.max(1, scale * .12)); ctx.fill(); ctx.stroke();
        if (cell.hidden) {
          ctx.strokeStyle = '#8c96a9'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - scale * .2, y - scale * .2); ctx.lineTo(x + scale * .2, y + scale * .2); ctx.moveTo(x + scale * .2, y - scale * .2); ctx.lineTo(x - scale * .2, y + scale * .2); ctx.stroke();
        }
        if (showNumbers && scale >= 10) {
          ctx.globalAlpha = 1; ctx.fillStyle = '#f4f7fb'; ctx.font = `${Math.max(7, Math.min(11, scale * .45))}px ui-monospace, monospace`; ctx.fillText(String(cell.sourceIndex + 1), x + scale * .38, y - scale * .38);
        }
      });
      ctx.globalAlpha = 1;
      if (!modules.length) {
        ctx.fillStyle = '#7e899e'; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(translated(language, 'Add a matrix or strip to begin.', 'Füge zuerst eine Matrix oder einen Streifen hinzu.'), rect.width / 2, rect.height / 2);
        ctx.textAlign = 'start';
      }
    };
    render(); const observer = new ResizeObserver(render); observer.observe(canvas); return () => observer.disconnect();
  }, [modules, activeId, channels, showNumbers, language]);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const hit = [...hitAreas.current].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)).find(area => Math.hypot(area.x - x, area.y - y) <= area.radius);
    if (!hit) return;
    const module = modules.find(item => item.id === hit.id); if (!module) return;
    event.currentTarget.setPointerCapture(event.pointerId); onSelect(module.id);
    drag.current = { id: module.id, clientX: event.clientX, clientY: event.clientY, x: module.x, y: module.y };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const module = modules.find(item => item.id === drag.current!.id); if (!module) return;
    const scale = Math.max(pixelsPerCell.current, 1);
    onChange({ ...module, x: Math.round((drag.current.x + (event.clientX - drag.current.clientX) / scale) * 10) / 10, y: Math.round((drag.current.y + (event.clientY - drag.current.clientY) / scale) * 10) / 10 });
  };
  const pointerUp = () => { drag.current = null; };
  return <canvas ref={ref} className="module-canvas interactive" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} aria-label={translated(language, 'Interactive modular MMFL layout; drag a module to move it', 'Interaktiver modularer MMFL-Aufbau; Modul zum Verschieben ziehen')} />;
}

function RepairPreview({ panel, points, suggestions, zoom, onZoomChange, language }: { panel?: Panel; points: MapPoint[]; suggestions: RepairSuggestion[]; zoom: number; onZoomChange: (zoom: number) => void; language: Language }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !panel) return;
    const ctx = canvas.getContext('2d'), basis = getPanelBasis(panel, points); if (!ctx || !basis) return;
    const base = adjustedPanelProjection(panel, points);
    const projectRepair = (xyz: Vec3, sourceIndex: number) => transformProjection([{ sourceIndex, ...projectXyz(xyz, basis) }], panel.transform)[0];
    const proposed = suggestions.map(suggestion => ({ suggestion, before: projectRepair(suggestion.before, suggestion.sourceIndex), after: projectRepair(suggestion.after, suggestion.sourceIndex) }));
    const render = () => {
      const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
      const fitPoints = [...base, ...proposed.map(item => item.after)];
      const span = Math.max(...fitPoints.flatMap(point => [Math.abs(point.u), Math.abs(point.v)]), .001);
      const scale = Math.min(rect.width, rect.height) * .4 / span * zoom, centerX = rect.width / 2 + pan.x, centerY = rect.height / 2 + pan.y;
      const screen = (point: Projection) => ({ x: centerX + point.u * scale, y: centerY + point.v * scale });
      ctx.strokeStyle = 'rgba(137,151,178,.11)';
      for (let x = centerX % 30; x < rect.width; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke(); }
      for (let y = centerY % 30; y < rect.height; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke(); }
      base.forEach(point => { const p = screen(point); ctx.fillStyle = panel.color; ctx.globalAlpha = .42; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 1;
      proposed.forEach(({ suggestion, before, after }) => {
        const oldPoint = screen(before), newPoint = screen(after), active = suggestion.selected;
        const oldClamped = { x: Math.max(10, Math.min(rect.width - 10, oldPoint.x)), y: Math.max(10, Math.min(rect.height - 10, oldPoint.y)) };
        ctx.strokeStyle = active ? '#49dcb3' : '#667085'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(oldClamped.x, oldClamped.y); ctx.lineTo(newPoint.x, newPoint.y); ctx.stroke(); ctx.setLineDash([]);
        ctx.strokeStyle = '#ffb454'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(oldClamped.x - 4, oldClamped.y - 4); ctx.lineTo(oldClamped.x + 4, oldClamped.y + 4); ctx.moveTo(oldClamped.x + 4, oldClamped.y - 4); ctx.lineTo(oldClamped.x - 4, oldClamped.y + 4); ctx.stroke();
        ctx.fillStyle = active ? '#49dcb3' : '#667085'; ctx.beginPath(); ctx.arc(newPoint.x, newPoint.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#dce4f2'; ctx.font = '10px Arial'; ctx.fillText(`#${suggestion.sourceIndex + 1}`, newPoint.x + 7, newPoint.y - 7);
      });
    };
    render(); const observer = new ResizeObserver(render); observer.observe(canvas); return () => observer.disconnect();
  }, [panel, points, suggestions, zoom, pan]);
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (!drag.current) return; setPan({ x: drag.current.panX + event.clientX - drag.current.x, y: drag.current.panY + event.clientY - drag.current.y }); };
  const pointerUp = () => { drag.current = null; };
  const wheel = (event: React.WheelEvent<HTMLCanvasElement>) => { event.preventDefault(); onZoomChange(Math.max(1, Math.min(8, zoom * Math.exp(-event.deltaY * .0015)))); };
  return <canvas ref={ref} className="repair-canvas interactive" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onDoubleClick={() => setPan({ x: 0, y: 0 })} onWheel={wheel} aria-label={translated(language, 'Zoomable before-and-after preview: drag to pan, use the wheel to zoom', 'Zoombare Vorher-Nachher-Vorschau: ziehen verschiebt, Mausrad zoomt')} />;
}

export default function Home() {
  const initial = useMemo(() => analyze(makeDemo()), []);
  const initialModules = useMemo(() => initial.panels.map((panel, index) => ({
    ...makeModule(`Demo Matrix ${index + 1}`, 'matrix', panel.indices[0], 8, 12, index),
    x: index * 15,
  })), [initial]);
  const [language, setLanguage] = useState<Language>('en');
  const [points, setPoints] = useState(initial.points);
  const [panels, setPanels] = useState(initial.panels);
  const [modules, setModules] = useState<PixelModule[]>(initialModules);
  const [activeModuleId, setActiveModuleId] = useState(initialModules[0]?.id ?? '');
  const [moduleKind, setModuleKind] = useState<PixelModuleKind>('matrix');
  const [moduleRows, setModuleRows] = useState(8);
  const [moduleColumns, setModuleColumns] = useState(8);
  const [moduleLength, setModuleLength] = useState(30);
  const [hiddenPixelInput, setHiddenPixelInput] = useState('');
  const [showModuleNumbers, setShowModuleNumbers] = useState(true);
  const [fileName, setFileName] = useState('Demo · 3 Panels');
  const [pitch, setPitch] = useState(initial.pitch);
  const [activeId, setActiveId] = useState(initial.panels[0]?.id ?? '');
  const [view, setView] = useState('3D');
  const [mapCamera, setMapCamera] = useState<Camera>({ yaw: -.5, pitch: -.28, zoom: 1 });
  const [stageMode, setStageMode] = useState<'3d' | 'builder'>('3d');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<number[]>([]);
  const [showPixelNumbers, setShowPixelNumbers] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [moveStep, setMoveStep] = useState(.1);
  const [pixelSearch, setPixelSearch] = useState('');
  const [insertAt, setInsertAt] = useState('');
  const [showOutputGrid, setShowOutputGrid] = useState(false);
  const [message, setMessage] = useState('Demo data is active — load a Pixelblaze JSON or Marimapper CSV file.');
  const [error, setError] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [showRepair, setShowRepair] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ parsed: ParsedMap; fileName: string } | null>(null);
  const [expectedLedCount, setExpectedLedCount] = useState('');
  const [preserveCsvOrigin, setPreserveCsvOrigin] = useState(false);
  const [repairSuggestions, setRepairSuggestions] = useState<RepairSuggestion[]>([]);
  const [repairThreshold, setRepairThreshold] = useState(1.25);
  const [lineRepairThreshold, setLineRepairThreshold] = useState(.35);
  const [includeMeasuredRepairs, setIncludeMeasuredRepairs] = useState(false);
  const [repairZoom, setRepairZoom] = useState(1);
  const [settings, setSettings] = useState<ExportSettings>({ universe: 0, channel: 1, channels: 3, ledSize: 6, definition: 'Generic - Pixel RGB' });
  const inputRef = useRef<HTMLInputElement>(null);
  const t = (english: string, german: string) => translated(language, english, german);
  const numberFormat = useMemo(() => new Intl.NumberFormat(language === 'en' ? 'en-US' : 'de-DE'), [language]);
  const active = panels.find(panel => panel.id === activeId) ?? panels[0];
  const activeModule = modules.find(module => module.id === activeModuleId) ?? modules[0];
  const enabledPanels = panels.filter(panel => panel.enabled);
  const freeRanges = useMemo(() => unassignedRanges(modules, points.length), [modules, points.length]);
  const unassignedCount = freeRanges.reduce((sum, range) => sum + range.last - range.first + 1, 0);
  const modularGrid = useMemo(() => moduleGrid(modules, settings.channels), [modules, settings.channels]);
  const hiddenIndices = useMemo(() => modules.flatMap(module => module.hiddenIndices), [modules]);
  const largestFreeRun = freeRanges.reduce((largest, range) => Math.max(largest, range.last - range.first + 1), 0);
  const draftModuleCount = moduleKind === 'matrix' ? Math.max(1, moduleRows) * Math.max(1, moduleColumns) : moduleKind === 'strip' ? Math.max(1, moduleLength) : 1;
  const selectionStart = selection.length ? Math.min(...selection) : -1;
  const selectionFreeCapacity = selectionStart < 0 ? 0 : (() => {
    const range = freeRanges.find(item => selectionStart >= item.first && selectionStart <= item.last);
    return range ? range.last - selectionStart + 1 : 0;
  })();
  const assignedCount = points.length - unassignedCount;
  const draftFitsNext = draftModuleCount <= largestFreeRun;
  const draftFitsSelection = selectionStart >= 0 && draftModuleCount <= selectionFreeCapacity;
  const placeholders = points.filter(point => point.status === 'placeholder').length;
  const inferred = points.filter(point => point.status === 'inferred').length;
  const outliers = points.filter(point => point.status === 'outlier').length;
  const reviewWarnings = placeholders + (includeMeasuredRepairs ? outliers : 0);
  const selectedRepairCount = repairSuggestions.filter(suggestion => suggestion.selected).length;
  const selectedPoint = selection.length === 1 ? points[selection[0]] : undefined;
  const repairModel = useMemo(() => active ? buildMatrixModel(active, points, pitch) : null, [active, points, pitch]);
  const viewLabel = view === 'Top' ? t('Top', 'Oben') : view === 'Side' ? t('Side', 'Seite') : view;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const moveWithKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!editMode || !selection.length || target?.matches('input, select, textarea, [contenteditable="true"]')) return;
      const amount = moveStep * (event.shiftKey ? 10 : 1);
      const delta: Vec3 | undefined = event.key === 'ArrowLeft' ? [-amount, 0, 0] : event.key === 'ArrowRight' ? [amount, 0, 0] : event.key === 'ArrowUp' ? [0, amount, 0] : event.key === 'ArrowDown' ? [0, -amount, 0] : event.key === 'PageUp' ? [0, 0, amount] : event.key === 'PageDown' ? [0, 0, -amount] : undefined;
      if (!delta) return;
      event.preventDefault();
      const selected = new Set(selection);
      setPoints(items => items.map(point => selected.has(point.sourceIndex) ? { ...point, xyz: add(point.xyz, delta), status: 'manual' } : point));
      setRepairSuggestions([]);
      setMessage(translated(language, `${selection.length} pixel${selection.length === 1 ? '' : 's'} moved.`, `${selection.length} Pixel verschoben.`));
    };
    window.addEventListener('keydown', moveWithKeyboard);
    return () => window.removeEventListener('keydown', moveWithKeyboard);
  }, [editMode, language, moveStep, selection]);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    setError('');
    setMessage(next === 'en' ? 'Language changed to English.' : 'Sprache auf Deutsch umgestellt.');
  };

  const applyParsedMap = (parsed: ParsedMap, importedFileName: string, requestedCount = parsed.coords.length, includeLeadingIndices = false) => {
    const count = Math.trunc(requestedCount);
    const leadingCount = includeLeadingIndices && parsed.sourceRange ? parsed.sourceRange[0] : 0;
    const minimumCount = parsed.coords.length + leadingCount;
    if (!Number.isInteger(count) || count < minimumCount || count > 20000) throw new Error(t(`Choose an LED count between ${minimumCount} and 20,000.`, `Wähle eine LED-Anzahl zwischen ${minimumCount} und 20.000.`));
    const coords = Array.from({ length: count }, (_, index) => index < leadingCount ? [0, 0, 0] as Vec3 : parsed.coords[index - leadingCount] ?? [0, 0, 0] as Vec3);
    const missingIndices = new Set<number>([
      ...Array.from({ length: leadingCount }, (_, index) => index),
      ...[...parsed.missingIndices].map(index => index + leadingCount),
    ]);
    for (let index = minimumCount; index < count; index++) missingIndices.add(index);
    const analyzed = analyze(coords, missingIndices);
    if (!analyzed.panels.length) throw new Error(t('No connected LED regions were detected. Use a clean scan or select points manually.', 'Keine zusammenhängenden LED-Bereiche erkannt. Nutze eine sauber gescannte Map oder wähle Punkte manuell.'));
    const recovered = missingIndices.size ? placeMissingCoordinates(analyzed.points, analyzed.panels, analyzed.pitch, missingIndices) : { points: analyzed.points, panels: analyzed.panels, placed: 0, unresolved: 0 };
    setPoints(recovered.points);
    setPanels(recovered.panels);
    const suggestions = suggestModulesFromScan(recovered.points, recovered.panels, analyzed.pitch, mapCamera);
    setModules(suggestions);
    setActiveModuleId(suggestions[0]?.id ?? '');
    setActiveId(recovered.panels[0].id);
    setPitch(analyzed.pitch);
    setFileName(importedFileName);
    setSelection([]);
    setPixelSearch('');
    setInsertAt('');
    setRepairSuggestions([]);
    setRepairZoom(1);
    setShowRepair(false);
    setShowAdjust(false);
    setStageMode(suggestions.length ? 'builder' : '3d');
    setIncludeMeasuredRepairs(false);
    setPendingImport(null);
    setError('');
    const gapInfo = missingIndices.size ? t(` · ${recovered.placed} missing indices positioned automatically${recovered.unresolved ? ` · ${recovered.unresolved} unresolved` : ''}`, ` · ${recovered.placed} fehlende Indizes automatisch positioniert${recovered.unresolved ? ` · ${recovered.unresolved} ungelöst` : ''}`) : '';
    setMessage(t(
      `${parsed.sourceLabel}: ${numberFormat.format(coords.length)} slots loaded · ${suggestions.length} editable module suggestions created${gapInfo}.`,
      `${parsed.sourceLabel}: ${numberFormat.format(coords.length)} Slots geladen · ${suggestions.length} bearbeitbare Modulvorschläge erstellt${gapInfo}.`,
    ));
  };

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const isCsv = file.name.toLowerCase().endsWith('.csv') || /^\s*index\s*,/i.test(text);
      const parsed: ParsedMap = isCsv
        ? parseMarimapperCsv(text, language)
        : { coords: extractCoordinates(JSON.parse(text), language), missingIndices: new Set<number>(), sourceLabel: 'Pixelblaze JSON', measuredCount: 0 };
      if (parsed.coords.length > 20000) throw new Error(t('The interactive preview supports up to 20,000 LEDs.', 'Für die interaktive Vorschau sind maximal 20.000 LEDs vorgesehen.'));
      if (isCsv) {
        setPendingImport({ parsed, fileName: file.name });
        const likelyLeadingGap = Boolean(parsed.sourceRange && parsed.sourceRange[0] > 0 && parsed.sourceRange[0] <= 16);
        setPreserveCsvOrigin(likelyLeadingGap);
        setExpectedLedCount(String(parsed.coords.length + (likelyLeadingGap ? parsed.sourceRange![0] : 0)));
        setError('');
      } else applyParsedMap(parsed, file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('The file could not be read.', 'Die Datei konnte nicht gelesen werden.'));
    }
    event.target.value = '';
  };

  const confirmCsvImport = () => {
    if (!pendingImport) return;
    try { applyParsedMap(pendingImport.parsed, pendingImport.fileName, Number(expectedLedCount), preserveCsvOrigin); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('The CSV could not be imported.', 'Die CSV konnte nicht importiert werden.')); }
  };

  const togglePanel = (id: string) => setPanels(items => items.map(item => item.id === id ? { ...item, enabled: !item.enabled } : item));
  const updateModule = (next: PixelModule) => {
    setModules(items => items.map(item => item.id === next.id ? {
      ...next,
      startIndex: next.sourceCells ? next.startIndex : Math.max(0, Math.min(points.length - modulePixelCount(next), Math.trunc(next.startIndex))),
      rows: Math.max(1, Math.trunc(next.rows)),
      columns: Math.max(1, Math.trunc(next.columns)),
      width: Math.max(0, next.width),
      height: Math.max(0, next.height),
      rotation: normalizeDegrees(next.rotation),
    } : item));
  };
  const addModule = (fromSelection = false) => {
    const rows = moduleKind === 'matrix' ? Math.max(1, Math.trunc(moduleRows)) : 1;
    const columns = moduleKind === 'matrix' ? Math.max(1, Math.trunc(moduleColumns)) : moduleKind === 'strip' ? Math.max(1, Math.trunc(moduleLength)) : 1;
    const count = rows * columns;
    const startIndex = fromSelection && selection.length ? Math.min(...selection) : firstFreeRange(modules, points.length, count);
    if (startIndex < 0 || startIndex + count > points.length) {
      setError(t(`No free run of ${count} LED slots is available.`, `Es ist kein freier Bereich mit ${count} LED-Slots verfügbar.`));
      return;
    }
    const occupied = new Set(modules.flatMap(moduleIndices));
    if (Array.from({ length: count }, (_, offset) => startIndex + offset).some(index => occupied.has(index))) {
      setError(t('The selected index range is already assigned to another module.', 'Der ausgewählte Indexbereich gehört bereits zu einem anderen Modul.'));
      return;
    }
    const label = moduleKind === 'matrix' ? `${rows}×${columns} Matrix` : moduleKind === 'strip' ? `${columns} LED Strip` : t('Single LED', 'Einzelpixel');
    let module = makeModule(`${label} ${modules.length + 1}`, moduleKind, startIndex, rows, columns, modules.length);
    const existingCells = modules.flatMap(item => moduleCells(item, settings.channels));
    module = { ...module, x: existingCells.length ? Math.max(...existingCells.map(cell => cell.x)) + 4 : 0, y: existingCells.length ? Math.min(...existingCells.map(cell => cell.y)) : 0 };
    module = detectModuleWiring(module, points, panels, pitch);
    setModules(items => [...items, module]);
    setActiveModuleId(module.id);
    setStageMode('builder');
    setSelection([]);
    setError('');
    setMessage(t(`${module.name} assigned to pixels ${startIndex + 1}–${startIndex + count}.`, `${module.name} den Pixeln ${startIndex + 1}–${startIndex + count} zugeordnet.`));
  };
  const removeModule = (id: string) => {
    setModules(items => items.filter(item => item.id !== id));
    if (activeModuleId === id) setActiveModuleId(modules.find(item => item.id !== id)?.id ?? '');
    setMessage(t('Module removed; its LED slots are free again.', 'Modul entfernt; seine LED-Slots sind wieder frei.'));
  };
  const fillFreeAsStrips = () => {
    if (!freeRanges.length) return;
    const existingCells = modules.flatMap(item => moduleCells(item, settings.channels));
    const firstY = existingCells.length ? Math.max(...existingCells.map(cell => cell.y)) + 3 : 0;
    const additions = freeRanges.map((range, index) => ({
      ...makeModule(`${t('Remaining strip', 'Reststreifen')} ${modules.length + index + 1}`, 'strip', range.first, 1, range.last - range.first + 1, modules.length + index),
      x: 0,
      y: firstY + index * 3,
    }));
    setModules(items => [...items, ...additions]);
    setActiveModuleId(additions[0].id);
    setStageMode('builder');
    setMessage(t(`${additions.length} strip module${additions.length === 1 ? '' : 's'} filled all remaining LED slots.`, `${additions.length} Streifenmodul${additions.length === 1 ? '' : 'e'} füllt alle freien LED-Slots.`));
  };
  const rebuildModuleSuggestions = () => {
    const suggestions = suggestModulesFromScan(points, panels, pitch, mapCamera);
    setModules(suggestions);
    setActiveModuleId(suggestions[0]?.id ?? '');
    setStageMode('builder');
    setSelection([]);
    setError('');
    const scanPaths = suggestions.filter(module => module.sourceCells).length;
    setMessage(t(
      `${suggestions.length} module suggestions rebuilt${scanPaths ? ` · ${scanPaths} crossed/multi-strip scan paths preserved` : ''}.`,
      `${suggestions.length} Modulvorschläge neu erstellt${scanPaths ? ` · ${scanPaths} gekreuzte/mehrteilige Scan-Pfade beibehalten` : ''}.`,
    ));
  };
  const alignModulesToCurrentScanView = () => {
    const aligned = alignModulesToScanView(modules, points, mapCamera, pitch);
    setModules(aligned);
    setStageMode('builder');
    setError('');
    setMessage(t('Module position, rotation and projected size matched to the current 3D scan view.', 'Modulposition, Rotation und projizierte Größe wurden an die aktuelle 3D-Scanansicht angepasst.'));
  };
  const redetectWiring = () => {
    if (!activeModule) return;
    const detected = detectModuleWiring(activeModule, points, panels, pitch);
    updateModule(detected);
    setMessage(detected.wiringDetected ? t('Wiring direction detected from the assigned scan range.', 'Verdrahtungsrichtung aus dem zugeordneten Scanbereich erkannt.') : t('No stable wiring pattern detected; manual settings remain available.', 'Kein stabiles Verdrahtungsmuster erkannt; die manuellen Einstellungen bleiben verfügbar.'));
  };
  const toggleHiddenPixel = (sourceIndex: number) => {
    if (!activeModule || !moduleIndices(activeModule).includes(sourceIndex)) {
      setError(t('Choose a pixel number inside the active module.', 'Wähle eine Pixelnummer innerhalb des aktiven Moduls.'));
      return;
    }
    const hidden = new Set(activeModule.hiddenIndices);
    if (hidden.has(sourceIndex)) hidden.delete(sourceIndex); else hidden.add(sourceIndex);
    updateModule({ ...activeModule, hiddenIndices: [...hidden].sort((a, b) => a - b) });
    setHiddenPixelInput('');
    setError('');
    setMessage(t(`Pixel ${sourceIndex + 1} ${hidden.has(sourceIndex) ? 'is now reserved but hidden' : 'is visible again'}.`, `Pixel ${sourceIndex + 1} ${hidden.has(sourceIndex) ? 'ist nun reserviert, aber ausgeblendet' : 'ist wieder sichtbar'}.`));
  };
  const selectPixels = (indices: number[], additive = false) => {
    const valid = indices.filter(index => points[index]);
    setSelection(current => {
      if (!additive) return [...new Set(valid)].sort((a, b) => a - b);
      if (valid.length === 1) return current.includes(valid[0]) ? current.filter(index => index !== valid[0]) : [...current, valid[0]].sort((a, b) => a - b);
      return [...new Set([...current, ...valid])].sort((a, b) => a - b);
    });
    const owner = panels.find(panel => valid.some(index => panel.indices.includes(index)));
    if (owner) setActiveId(owner.id);
    setMessage(t(valid.length ? `${valid.length} pixel${valid.length === 1 ? '' : 's'} selected.` : 'Selection cleared.', valid.length ? `${valid.length} Pixel ausgewählt.` : 'Auswahl aufgehoben.'));
  };
  const moveSelected = (delta: Vec3) => {
    if (!selection.length) return;
    const selected = new Set(selection);
    setPoints(items => items.map(point => selected.has(point.sourceIndex) ? { ...point, xyz: add(point.xyz, delta), status: 'manual' } : point));
    setRepairSuggestions([]);
    setMessage(t(`${selection.length} pixel${selection.length === 1 ? '' : 's'} moved.`, `${selection.length} Pixel verschoben.`));
  };
  const updateCoordinate = (axis: 0 | 1 | 2, value: number) => {
    if (!selectedPoint || !Number.isFinite(value)) return;
    setPoints(items => items.map(point => point.sourceIndex === selectedPoint.sourceIndex ? { ...point, xyz: point.xyz.map((coordinate, index) => index === axis ? value : coordinate) as Vec3, status: 'manual' } : point));
    setRepairSuggestions([]);
  };
  const searchForPixel = () => {
    const index = Math.trunc(Number(pixelSearch)) - 1;
    if (!Number.isInteger(index) || !points[index]) { setError(t('Enter an existing pixel number.', 'Gib eine vorhandene Pixelnummer ein.')); return; }
    setError(''); selectPixels([index]);
  };
  const insertPixel = () => {
    if (!active) return;
    const fallbackIndex = selectedPoint ? selectedPoint.sourceIndex + 2 : points.length + 1;
    const requested = insertAt.trim() ? Math.trunc(Number(insertAt)) : fallbackIndex;
    if (!Number.isInteger(requested) || requested < 1 || requested > points.length + 1) { setError(t(`Choose a position between 1 and ${points.length + 1}.`, `Wähle eine Position zwischen 1 und ${points.length + 1}.`)); return; }
    const index = requested - 1;
    const shiftedPoints = points.map(point => ({ ...point, sourceIndex: point.sourceIndex >= index ? point.sourceIndex + 1 : point.sourceIndex }));
    const fallbackBefore = shiftedPoints[index - 1], fallbackAfter = shiftedPoints[index];
    const fallbackPosition: Vec3 = fallbackBefore && fallbackAfter ? averageVec([fallbackBefore.xyz, fallbackAfter.xyz]) : fallbackBefore ? fallbackBefore.xyz : fallbackAfter?.xyz ?? [0, 0, 0];
    const withPlaceholder: MapPoint[] = [...shiftedPoints.slice(0, index), { sourceIndex: index, xyz: fallbackPosition, status: 'manual' }, ...shiftedPoints.slice(index)];
    const shiftedPanels = panels.map(panel => {
      const shifted = panel.indices.map(pixelIndex => pixelIndex >= index ? pixelIndex + 1 : pixelIndex);
      return panel.id === active.id ? { ...panel, indices: [...new Set([...shifted, index])].sort((a, b) => a - b) } : { ...panel, indices: shifted };
    });
    const shiftedActive = shiftedPanels.find(panel => panel.id === active.id)!;
    const model = buildMatrixModel(shiftedActive, withPlaceholder, pitch);
    const estimate = estimateExpectedPosition(index, shiftedActive, withPlaceholder, pitch, model);
    const serpentine = estimateSerpentinePosition(index, shiftedActive, withPlaceholder, pitch);
    const basis = getPanelBasis(shiftedActive, withPlaceholder);
    const candidate = serpentine ?? estimate?.position ?? model?.positionAt(index) ?? fallbackPosition;
    const projectedCandidate = basis ? projectXyz(candidate, basis) : null;
    const xyz = basis && projectedCandidate ? add(basis.center, add(scaleVec(basis.e1, projectedCandidate.u), scaleVec(basis.e2, -projectedCandidate.v))) : candidate;
    const nextPoints = withPlaceholder.map(point => point.sourceIndex === index ? { ...point, xyz } : point);
    setPoints(nextPoints);
    setPanels(shiftedPanels);
    setSelection([index]); setPixelSearch(String(requested)); setInsertAt(''); setRepairSuggestions([]); setError('');
    setMessage(t(`Pixel ${requested} inserted into ${active.name}; following numbers were shifted.`, `Pixel ${requested} wurde in ${active.name} eingefügt; folgende Nummern wurden verschoben.`));
  };
  const selectView = (nextView: string) => {
    setView(nextView);
    setMapCamera(current => nextView === 'Top' ? { yaw: 0, pitch: -Math.PI / 2, zoom: current.zoom } : nextView === 'Front' ? { yaw: 0, pitch: 0, zoom: current.zoom } : nextView === 'Side' ? { yaw: -Math.PI / 2, pitch: 0, zoom: current.zoom } : { yaw: -.5, pitch: -.28, zoom: current.zoom });
  };
  const addSelection = () => {
    if (!selection.length) {
      setMessage(t('First draw a box around LEDs while selection mode is active.', 'Ziehe zuerst im Auswahlmodus einen Rahmen um LEDs.'));
      return;
    }
    const id = `manual-${Date.now()}`;
    const newPanel: Panel = { id, name: `${t('Selection', 'Auswahl')} ${panels.length + 1}`, indices: [...selection].sort((a, b) => a - b), color: COLORS[panels.length % COLORS.length], enabled: true, transform: { rotation: 0, scale: 1, flipX: false, flipY: false } };
    setPanels(items => [...items, newPanel]);
    setActiveId(id);
    setSelection([]);
    setSelectionMode(false);
    setMessage(t(`${numberFormat.format(newPanel.indices.length)} LEDs added as a new region.`, `${numberFormat.format(newPanel.indices.length)} LEDs als neuer Bereich angelegt.`));
  };
  const updatePanelTransform = (transform: PanelTransform) => {
    if (!active) return;
    setPanels(items => items.map(item => item.id === active.id ? { ...item, transform: { rotation: normalizeDegrees(transform.rotation), scale: Math.max(.25, Math.min(4, transform.scale)), flipX: transform.flipX, flipY: transform.flipY } } : item));
  };
  const snapActive = (axis: 'horizontal' | 'vertical') => {
    if (!active) return;
    const rotation = axis === 'horizontal' ? Math.round(active.transform.rotation / 180) * 180 : 90 + Math.round((active.transform.rotation - 90) / 180) * 180;
    updatePanelTransform({ ...active.transform, rotation: normalizeDegrees(rotation) });
  };
  const flipActive = (axis: 'horizontal' | 'vertical') => {
    if (!active) return;
    updatePanelTransform({ ...active.transform, [axis === 'horizontal' ? 'flipX' : 'flipY']: axis === 'horizontal' ? !active.transform.flipX : !active.transform.flipY });
  };
  const openRepairReview = () => {
    if (!active) return;
    const suggestions = findRepairSuggestions(active, points, pitch, repairThreshold, lineRepairThreshold, includeMeasuredRepairs);
    setRepairSuggestions(suggestions);
    setRepairZoom(1);
    setShowRepair(true);
    setMessage(suggestions.length
      ? t(`${suggestions.length} conservative repair suggestion${suggestions.length === 1 ? '' : 's'} found in ${active.name} — no data has been changed.`, `${suggestions.length} konservative Reparaturvorschläge in ${active.name} gefunden — noch nichts verändert.`)
      : includeMeasuredRepairs ? t(`${active.name}: no generated pixel or clear measured outlier exceeds the thresholds.`, `${active.name}: Kein erzeugtes Pixel und kein eindeutiger gemessener Ausreißer überschreitet die Schwellwerte.`) : t(`${active.name}: no generated pixel needs correction. Measured coordinates remain protected.`, `${active.name}: Kein erzeugtes Pixel benötigt eine Korrektur. Gemessene Koordinaten bleiben geschützt.`));
  };
  const changeRepairThreshold = (next: number) => {
    setRepairThreshold(next);
    if (!active) return;
    const suggestions = findRepairSuggestions(active, points, pitch, next, lineRepairThreshold, includeMeasuredRepairs);
    setRepairSuggestions(suggestions);
    setMessage(t(`${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} above ${next.toFixed(2)} × spacing.`, `${suggestions.length} Vorschlag${suggestions.length === 1 ? '' : 'e'} über ${next.toFixed(2)} × Abstand.`));
  };
  const changeLineRepairThreshold = (next: number) => {
    setLineRepairThreshold(next);
    if (!active) return;
    const suggestions = findRepairSuggestions(active, points, pitch, repairThreshold, next, includeMeasuredRepairs);
    setRepairSuggestions(suggestions);
    setMessage(t(`${suggestions.length} local or matrix-based repair suggestions.`, `${suggestions.length} lokale oder matrixbasierte Reparaturvorschläge.`));
  };
  const changeMeasuredRepairMode = (next: boolean) => {
    setIncludeMeasuredRepairs(next);
    if (!active) return;
    const suggestions = findRepairSuggestions(active, points, pitch, repairThreshold, lineRepairThreshold, next);
    setRepairSuggestions(suggestions);
    setMessage(next ? t('Strict measured-outlier review enabled. Normal scan noise and row turns remain protected.', 'Strenge Prüfung gemessener Ausreißer aktiviert. Normales Scanrauschen und Zeilenwechsel bleiben geschützt.') : t('Measured coordinates protected; only inferred or manually added pixels are reviewed.', 'Gemessene Koordinaten geschützt; geprüft werden nur berechnete oder manuell hinzugefügte Pixel.'));
  };
  const applyRepairs = () => {
    if (!active) return;
    const accepted = repairSuggestions.filter(suggestion => suggestion.selected);
    if (!accepted.length) return;
    const replacements = new Map(accepted.map(suggestion => [suggestion.sourceIndex, suggestion.after]));
    setPoints(items => items.map(point => replacements.has(point.sourceIndex) ? { ...point, xyz: replacements.get(point.sourceIndex)!, status: 'ok' } : point));
    setPanels(items => items.map(item => item.id === active.id ? { ...item, indices: [...new Set([...item.indices, ...accepted.map(suggestion => suggestion.sourceIndex)])].sort((a, b) => a - b) } : item));
    setShowRepair(false);
    setRepairSuggestions([]);
    setMessage(t(`${accepted.length} confirmed pixel position${accepted.length === 1 ? '' : 's'} repaired.`, `${accepted.length} bestätigte Pixelposition${accepted.length === 1 ? '' : 'en'} repariert.`));
  };
  const exportFile = (format: 'svg' | 'csv' | 'mmfl') => {
    if (format !== 'mmfl' && !enabledPanels.length) {
      setError(t('Enable at least one panel for export.', 'Aktiviere mindestens ein Panel für den Export.'));
      return;
    }
    if (format === 'mmfl' && !modules.length) {
      setError(t('Add at least one module before MMFL export.', 'Füge vor dem MMFL-Export mindestens ein Modul hinzu.'));
      return;
    }
    try {
      // The Fixture Definition is the user's canonical export name.
      const base = safeName(settings.definition);
      const mime = format === 'svg' ? 'image/svg+xml' : format === 'csv' ? 'text/csv' : 'application/xml';
      const content = format === 'svg' ? buildSvg(enabledPanels, points, settings) : format === 'csv' ? buildCsv(enabledPanels, points, settings) : buildModuleMmfl(modules, points.length, settings);
      download(`${base}.${format}`, content, mime);
      setError('');
      setMessage(format === 'mmfl'
        ? t(`MMFL created from ${modules.length} modules with ${hiddenIndices.length} reserved hidden pixels.`, `MMFL aus ${modules.length} Modulen mit ${hiddenIndices.length} reservierten, ausgeblendeten Pixeln erstellt.`)
        : t(`${format.toUpperCase()} created for ${enabledPanels.length} panel${enabledPanels.length === 1 ? '' : 's'}.`, `${format.toUpperCase()} für ${enabledPanels.length} Panel${enabledPanels.length === 1 ? '' : 's'} erstellt.`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('The fixture could not be exported.', 'Die Fixture konnte nicht exportiert werden.'));
    }
  };
  const repairReason = (reason: RepairSuggestion['reason']) => ({
    'missing-reading': t('Missing reading', 'Fehlender Messwert'),
    'generated-position': t('Generated or manually edited pixel', 'Erzeugtes oder manuell bearbeitetes Pixel'),
    'threshold-deviation': t('Deviation above threshold', 'Abweichung über Schwellwert'),
    'local-line-deviation': t('Local row/line deviation', 'Lokale Zeilen-/Linienabweichung'),
  }[reason]);
  const confidenceLabel = (confidence: RepairSuggestion['confidence']) => ({ high: t('high', 'hoch'), medium: t('medium', 'mittel'), low: t('low', 'niedrig') }[confidence]);

  return (
    <main className="app-shell">
      <input ref={inputRef} type="file" accept=".json,.csv,application/json,text/csv" hidden onChange={loadFile} />
      <header className="topbar">
        <div className="brand-mark">PX</div>
        <div className="brand-copy"><strong>Pixel Fixture Studio</strong><span>Pixelblaze · Marimapper → MadMapper 6.1</span></div>
        <div className="top-actions">
          <span className="status-dot" /><span className="status-label">{t('Local in your browser', 'Lokal im Browser')}</span>
          <div className="language-switch" aria-label={t('Language', 'Sprache')}>
            <button className={language === 'en' ? 'selected' : ''} onClick={() => changeLanguage('en')} aria-pressed={language === 'en'}>EN</button>
            <button className={language === 'de' ? 'selected' : ''} onClick={() => changeLanguage('de')} aria-pressed={language === 'de'}>DE</button>
          </div>
          <button className="ghost-button" onClick={() => setShowHelp(true)}>{t('Format help', 'Format-Hilfe')}</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="rail left-rail">
          <div className="eyebrow">{t('WORKFLOW', 'ABLAUF')}</div>
          <ol className="steps">
            <li className="done"><span>✓</span><div><strong>{t('Load mapping', 'Mapping laden')}</strong><small>{numberFormat.format(points.length)} {t('coordinates', 'Koordinaten')}</small></div></li>
            <li className={selectionMode ? 'active' : ''}><span>2</span><div><strong>{t('Select region', 'Bereich wählen')}</strong><small>{t('Box or panel', 'Rahmen oder Panel')}</small></div></li>
            <li className={stageMode === 'builder' ? 'active' : ''}><span>3</span><div><strong>{t('Build modules', 'Module bauen')}</strong><small>{t('Matrix · strip · single', 'Matrix · Streifen · Einzelpixel')}</small></div></li>
            <li className={showExport ? 'active' : ''}><span>4</span><div><strong>{t('Export', 'Exportieren')}</strong><small>SVG · CSV · MMFL</small></div></li>
          </ol>
          <button className="load-button" onClick={() => inputRef.current?.click()}>＋ {t('Load JSON / CSV map', 'JSON / CSV Map laden')}</button>
          <div className="tool-group">
            <button className={selectionMode ? 'tool active' : 'tool'} onClick={() => setSelectionMode(value => !value)}>▧ {t('Box selection', 'Rahmenauswahl')}</button>
            <button className="tool" onClick={() => setStageMode('builder')}>▦ {t('Module builder', 'Modul-Baukasten')}</button>
          </div>
          <div className="tool-group">
            <button className={showPixelNumbers ? 'tool active' : 'tool'} aria-pressed={showPixelNumbers} onClick={() => setShowPixelNumbers(value => !value)}># {t('Show pixel numbers', 'Pixelnummern anzeigen')}</button>
            <button className={showModuleNumbers ? 'tool active' : 'tool'} aria-pressed={showModuleNumbers} onClick={() => setShowModuleNumbers(value => !value)}># {t('Builder numbers', 'Baukasten-Nummern')}</button>
          </div>
          <div className="data-card"><span>{t('Module coverage', 'Modulbelegung')}</span><strong>{assignedCount}/{points.length}</strong><small>{unassignedCount ? t(`${unassignedCount} slots still free`, `${unassignedCount} Slots noch frei`) : t('Complete · ready for MMFL', 'Vollständig · bereit für MMFL')}</small></div>
          <p className="privacy-note">{t('Your mapping file stays on this device and is never uploaded.', 'Deine Mapping-Datei bleibt auf diesem Gerät und wird nicht hochgeladen.')}</p>
        </aside>

        <section className="stage-card">
          <div className="stage-toolbar">
            <div><span className="eyebrow">{stageMode === '3d' ? '3D MAP' : t('MODULAR MMFL BUILDER', 'MODULARER MMFL-BAUKASTEN')}</span><h1>{stageMode === '3d' ? fileName : activeModule?.name ?? t('No module selected', 'Kein Modul ausgewählt')}</h1></div>
            <div className="stage-actions"><button className="swap-button" onClick={() => setStageMode(mode => mode === '3d' ? 'builder' : '3d')}>⇄ {stageMode === '3d' ? t('Open builder', 'Baukasten öffnen') : t('Show 3D scan', '3D-Scan zeigen')}</button>{stageMode === 'builder' && <button onClick={alignModulesToCurrentScanView}>⌁ {t('Match 3D view', 'An 3D-Ansicht anpassen')}</button>}</div>
            {stageMode === '3d' && <div className="view-switch">{[
              { id: '3D', label: '3D' }, { id: 'Top', label: t('Top', 'Oben') }, { id: 'Front', label: 'Front' }, { id: 'Side', label: t('Side', 'Seite') },
            ].map(item => <button key={item.id} className={view === item.id ? 'selected' : ''} onClick={() => selectView(item.id)}>{item.label}</button>)}</div>}
          </div>
          <div className={`viewport ${stageMode === 'builder' ? 'viewport-builder' : ''}`}>
            {stageMode === '3d' ? <>
              <MapCanvas language={language} points={points} panels={panels} selectionMode={selectionMode} showPixelNumbers={showPixelNumbers} hiddenIndices={hiddenIndices} selectedIndices={selection} onSelection={selectPixels} camera={mapCamera} onCameraChange={setMapCamera} />
              <div className="axis-chip"><i className="x" /> X <i className="y" /> Y <i className="z" /> Z</div>
              <div className="canvas-help">{selectionMode ? t('Drag a box to choose the first free LED range for a module', 'Rahmen ziehen, um den ersten freien LED-Bereich eines Moduls zu wählen') : t('Click: select · Drag: rotate · Wheel: zoom · crossed pixels are reserved/hidden', 'Klick: auswählen · Ziehen: drehen · Mausrad: zoomen · gekreuzte Pixel sind reserviert/ausgeblendet')}</div>
            </> : <>
              <ModulePreview language={language} modules={modules} activeId={activeModule?.id ?? ''} channels={settings.channels} showNumbers={showModuleNumbers} onSelect={setActiveModuleId} onChange={updateModule} />
              <div className="builder-overlay">
                <span><b>{modules.length}</b> {t('modules', 'Module')}</span>
                <span><b>{modularGrid.width}×{modularGrid.height}</b> {t('output cells', 'Ausgabezellen')}</span>
                <span className={unassignedCount ? 'open' : 'complete'}><b>{unassignedCount}</b> {t('free slots', 'freie Slots')}</span>
                <span className={modularGrid.collisions.length ? 'collision' : ''}><b>{modularGrid.collisions.length}</b> {t('collisions', 'Kollisionen')}</span>
              </div>
              <div className="canvas-help">{t('Click: select module · Drag: move module · edit exact size and rotation on the right', 'Klick: Modul wählen · Ziehen: Modul verschieben · exakte Größe und Rotation rechts bearbeiten')}</div>
            </>}
          </div>
          <div className="stage-footer"><span><b>{numberFormat.format(points.length)}</b> Slots</span><span><b>{assignedCount}</b> {t('assigned', 'zugewiesen')}</span><span className={unassignedCount ? 'warning-text' : 'inferred-count'}><b>{unassignedCount}</b> {t('open', 'offen')}</span><span><b>{hiddenIndices.length}</b> {t('reserved/hidden', 'reserviert/ausgeblendet')}</span><span className="status-message">{message}</span></div>
        </section>

        <aside className="rail right-rail">
          <div className="panel-heading"><div><span className="eyebrow">{t('SCAN REGIONS', 'SCAN-BEREICHE')}</span><h2>{t('Module builder', 'Modul-Baukasten')}</h2></div><span className="count-chip">{modules.length}</span></div>
          <div className="panel-list">{panels.map(panel => <div className={`panel-row ${panel.id === active?.id ? 'chosen' : ''}`} key={panel.id}><button className="panel-main" onClick={() => setActiveId(panel.id)}><span className="color-dot" style={{ background: panel.color }} /><span><strong>{panel.name}</strong><small>{numberFormat.format(panel.indices.length)} LEDs · #{panel.indices[0]}–{panel.indices.at(-1)}</small></span></button><label className="switch" title={t('Enabled for export', 'Für Export aktiv')}><input type="checkbox" checked={panel.enabled} onChange={() => togglePanel(panel.id)} /><i /></label></div>)}</div>
          <section className="module-builder">
            <div className="coverage-card">
              <div><span>{t('Assigned', 'Zugewiesen')}</span><strong>{assignedCount}/{points.length}</strong></div>
              <div className="coverage-bar"><i style={{ width: `${points.length ? assignedCount / points.length * 100 : 0}%` }} /></div>
              <small>{unassignedCount ? t(`${unassignedCount} LED slots still need a module.`, `${unassignedCount} LED-Slots benötigen noch ein Modul.`) : t('Every physical LED slot is assigned exactly once.', 'Jeder physische LED-Slot ist genau einmal zugewiesen.')}</small>
            </div>
            <button className="auto-draft-button" onClick={rebuildModuleSuggestions}>◇ <span><strong>{t('Suggest modules from scan', 'Module aus Scan vorschlagen')}</strong><small>{t('Detect matrices and strip changes; preserve crossed or differently oriented scan paths.', 'Matrizen und Strangwechsel erkennen; gekreuzte oder unterschiedlich ausgerichtete Scan-Pfade beibehalten.')}</small></span></button>
            <button className="auto-draft-button scan-layout-button" disabled={!modules.length} onClick={alignModulesToCurrentScanView}>⌁ <span><strong>{t('Match current 3D arrangement', 'Aktuelle 3D-Anordnung übernehmen')}</strong><small>{t('Keep the modules and copy their relative position, rotation and projected size from the retained 3D camera.', 'Module beibehalten und relative Position, Rotation sowie projizierte Größe aus der gespeicherten 3D-Kamera übernehmen.')}</small></span></button>
            <div className="free-ranges"><span>{t('Free contiguous ranges', 'Freie zusammenhängende Bereiche')}</span><div>{freeRanges.length ? freeRanges.map(range => <button key={range.first} onClick={() => { setSelection([range.first]); setStageMode('3d'); }}>{`#${range.first + 1}–${range.last + 1}`} <b>{range.last - range.first + 1}</b></button>) : <em>{t('none', 'keine')}</em>}</div></div>
            <div className="module-create">
              <div className="kind-tabs">{([
                ['matrix', t('Matrix', 'Matrix')], ['strip', t('Strip', 'Streifen')], ['single', t('Single', 'Einzelpixel')],
              ] as [PixelModuleKind, string][]).map(([kind, label]) => <button key={kind} className={moduleKind === kind ? 'active' : ''} onClick={() => setModuleKind(kind)}>{label}</button>)}</div>
              {moduleKind === 'matrix' && <div className="module-size-fields"><label>{t('Rows', 'Zeilen')}<input type="number" min="1" max={Math.max(1, Math.min(128, Math.floor(largestFreeRun / Math.max(moduleColumns, 1))))} value={moduleRows} onChange={event => { const rows = Math.max(1, Math.min(128, Number(event.target.value) || 1)); setModuleRows(rows); setModuleColumns(columns => Math.max(1, Math.min(columns, Math.floor(Math.max(largestFreeRun, 1) / rows)))); }} /></label><span>×</span><label>{t('Columns', 'Spalten')}<input type="number" min="1" max={Math.max(1, Math.min(128, Math.floor(largestFreeRun / Math.max(moduleRows, 1))))} value={moduleColumns} onChange={event => setModuleColumns(Math.max(1, Math.min(128, Math.floor(Math.max(largestFreeRun, 1) / Math.max(moduleRows, 1)), Number(event.target.value) || 1)))} /></label></div>}
              {moduleKind === 'strip' && <label className="module-length">{t('Strip length', 'Streifenlänge')}<input type="number" min="1" max={Math.max(1, largestFreeRun)} value={moduleLength} onChange={event => setModuleLength(Math.max(1, Math.min(Math.max(largestFreeRun, 1), Number(event.target.value) || 1)))} /></label>}
              {moduleKind === 'single' && <p className="single-note">{t('Uses the next single free LED slot.', 'Verwendet den nächsten einzelnen freien LED-Slot.')}</p>}
              <div className={`fit-note ${draftFitsNext ? 'valid' : 'invalid'}`}><b>{draftModuleCount}</b> {t('LED slots requested', 'LED-Slots benötigt')} · {t('largest free run', 'größter freier Bereich')}: <b>{largestFreeRun}</b></div>
              <div className="create-actions"><button disabled={!draftFitsNext} onClick={() => addModule(false)}>＋ {t('Add next free', 'Nächsten freien hinzufügen')}</button><button disabled={!draftFitsSelection} onClick={() => addModule(true)}>▧ {t('From selection', 'Ab Auswahl')}</button></div>
              {selectionStart >= 0 && <small className="selection-capacity">#{selectionStart + 1}: {selectionFreeCapacity} {t('consecutive free slots available', 'aufeinanderfolgende freie Slots verfügbar')}</small>}
              <button className="fill-free" disabled={!freeRanges.length} onClick={fillFreeAsStrips}>{t('Fill every remaining range as a strip', 'Alle restlichen Bereiche als Streifen füllen')}</button>
            </div>
            <div className="module-list">{modules.map(module => <button className={module.id === activeModule?.id ? 'active' : ''} key={module.id} onClick={() => { setActiveModuleId(module.id); setStageMode('builder'); }}><i style={{ background: module.color }} /><span><strong>{module.name}</strong><small>#{module.startIndex + 1}–{module.startIndex + modulePixelCount(module)} · {module.sourceCells ? t(`${module.rows}×${module.columns} scan footprint · spacing ${module.sourceGridStep ?? 3} grid cells (relative ×${module.sourceStep ?? 1})`, `${module.rows}×${module.columns} Scan-Grundfläche · Abstand ${module.sourceGridStep ?? 3} Rasterzellen (relativ ×${module.sourceStep ?? 1})`) : `${module.rows}×${module.columns}`}{module.hiddenIndices.length ? ` · ${module.hiddenIndices.length} ${t('hidden', 'ausgeblendet')}` : ''}</small></span></button>)}</div>
            {activeModule && <div className="module-editor">
              <div className="module-editor-title"><span>{t('Active module', 'Aktives Modul')}</span><button onClick={() => removeModule(activeModule.id)}>{t('Remove', 'Entfernen')}</button></div>
              <label>{t('Name', 'Name')}<input value={activeModule.name} onChange={event => updateModule({ ...activeModule, name: event.target.value })} /></label>
              <div className="module-meta"><span>{t('Assigned range', 'Zugewiesener Bereich')} <b>#{activeModule.startIndex + 1}–{activeModule.startIndex + modulePixelCount(activeModule)}</b></span><span>{activeModule.sourceCells ? t('measured scan path', 'gemessener Scan-Pfad') : activeModule.wiringDetected ? t('scan-assisted', 'scan-unterstützt') : t('manual wiring', 'manuelle Verdrahtung')}</span></div>
              {activeModule.sourceCells ? <p className="single-note">{activeModule.sourceStep === 1
                ? t('Dense-strip LEDs occupy adjacent grid cells. Horizontal rows use every second grid row, leaving exactly one symmetric intermediate row for the crossing strip.', 'Die LEDs des dichten Strangs belegen direkt benachbarte Rasterzellen. Horizontale Reihen nutzen jede zweite Rasterzeile; dazwischen bleibt genau eine symmetrische Zeile für den kreuzenden Strang.')
                : t(`This crossing strand uses a constant interval of ${activeModule.sourceGridStep ?? 2} grid cells and is snapped to the intermediate rows of the dense strip.`, `Dieser kreuzende Strang verwendet konstant ${activeModule.sourceGridStep ?? 2} Rasterzellen Abstand und wird auf die Zwischenzeilen des dichten Strangs eingerastet.`)}</p> : <>
                <div className="module-grid-fields"><label>{t('Flow', 'Verlauf')}<select value={activeModule.order} onChange={event => updateModule({ ...activeModule, order: event.target.value as ModuleOrder, wiringDetected: false })}><option value="rows">{t('Rows first', 'Zeilen zuerst')}</option><option value="columns">{t('Columns first', 'Spalten zuerst')}</option></select></label><label>{t('Start corner', 'Startecke')}<select value={activeModule.startCorner} onChange={event => updateModule({ ...activeModule, startCorner: event.target.value as ModuleCorner, wiringDetected: false })}><option value="tl">↖ TL</option><option value="tr">↗ TR</option><option value="bl">↙ BL</option><option value="br">↘ BR</option></select></label></div>
                <label className="check-row"><input type="checkbox" checked={activeModule.zigzag} onChange={event => updateModule({ ...activeModule, zigzag: event.target.checked, wiringDetected: false })} /> {t('Zigzag / serpentine wiring', 'Zickzack-/Serpentinen-Verdrahtung')}</label>
                <button className="detect-wiring" onClick={redetectWiring}>◇ {t('Detect wiring from scan', 'Verdrahtung aus Scan erkennen')}</button>
              </>}
              <div className="geometry-title">{t('Physical placement before MMFL grid', 'Physische Platzierung vor dem MMFL-Raster')}</div>
              <div className="geometry-grid">{([
                ['X', 'x', .1], ['Y', 'y', .1], [t('Width', 'Breite'), 'width', .1], [t('Height', 'Höhe'), 'height', .1], [t('Rotation', 'Rotation'), 'rotation', 1],
              ] as [string, 'x' | 'y' | 'width' | 'height' | 'rotation', number][]).map(([label, key, step]) => <label key={key}>{label}<input type="number" step={step} min={key === 'width' || key === 'height' ? 0 : undefined} value={activeModule[key]} onChange={event => updateModule({ ...activeModule, [key]: Number(event.target.value) || 0 })} /></label>)}</div>
              <div className="hidden-editor"><div><span>{t('Physically present but unused', 'Physisch vorhanden, aber unbenutzt')}</span><small>{t('Hidden cells reserve their source/DMX address; later LEDs keep their original address.', 'Ausgeblendete Zellen reservieren ihre Quell-/DMX-Adresse; spätere LEDs behalten ihre Originaladresse.')}</small></div><div className="hidden-input"><input type="number" min={activeModule.startIndex + 1} max={activeModule.startIndex + modulePixelCount(activeModule)} placeholder={t('Pixel #', 'Pixel #')} value={hiddenPixelInput} onChange={event => setHiddenPixelInput(event.target.value)} /><button onClick={() => toggleHiddenPixel(Number(hiddenPixelInput) - 1)}>{t('Toggle', 'Umschalten')}</button></div>{activeModule.hiddenIndices.length > 0 && <div className="hidden-chips">{activeModule.hiddenIndices.map(index => <button key={index} onClick={() => toggleHiddenPixel(index)}>#{index + 1} ×</button>)}</div>}</div>
            </div>}
          </section>
          <button className="export-button" disabled={!modules.length} onClick={() => setShowExport(true)}>{t('Create fixture', 'Fixture erstellen')} <span>→</span></button>
        </aside>
      </section>

      {error && <div className="toast error" role="alert"><span>!</span>{error}<button aria-label={t('Close error', 'Fehler schließen')} onClick={() => setError('')}>×</button></div>}

      {pendingImport && <div className="modal-backdrop" onMouseDown={() => setPendingImport(null)}><section className="modal import-modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="import-title">
        <button className="modal-close" aria-label={t('Cancel import', 'Import abbrechen')} onClick={() => setPendingImport(null)}>×</button><span className="eyebrow">{t('MARIMAPPER CSV IMPORT', 'MARIMAPPER-CSV-IMPORT')}</span><h2 id="import-title">{t('How many LEDs should this scan contain?', 'Wie viele LEDs soll dieser Scan enthalten?')}</h2>
        <p className="modal-lead">{t('Internal gaps are preserved. If the file starts above index 0, you can keep that original leading index space instead of shifting every measured LED forward. After import, editable matrix and strip suggestions are generated immediately.', 'Interne Lücken bleiben erhalten. Beginnt die Datei oberhalb von Index 0, kannst du diesen ursprünglichen führenden Indexraum beibehalten, statt alle gemessenen LEDs nach vorne zu verschieben. Nach dem Import werden sofort bearbeitbare Matrix- und Streifenvorschläge erzeugt.')}</p>
        <div className="import-summary"><span>{t('CSV index range', 'CSV-Indexbereich')}<strong>{pendingImport.parsed.sourceRange ? `${pendingImport.parsed.sourceRange[0]}–${pendingImport.parsed.sourceRange[1]}` : '—'}</strong></span><span>{t('Measured LEDs', 'Gemessene LEDs')}<strong>{pendingImport.parsed.measuredCount}</strong></span><span>{t('Missing indices', 'Fehlende Indizes')}<strong>{pendingImport.parsed.missingIndices.size ? [...pendingImport.parsed.missingIndices].slice(0, 6).map(index => `#${index + (pendingImport.parsed.sourceRange?.[0] ?? 0)}`).join(', ') : '—'}</strong></span></div>
        {pendingImport.parsed.sourceRange && pendingImport.parsed.sourceRange[0] > 0 && <label className="leading-index-option"><input type="checkbox" checked={preserveCsvOrigin} onChange={event => { const checked = event.target.checked; setPreserveCsvOrigin(checked); setExpectedLedCount(String(pendingImport.parsed.coords.length + (checked ? pendingImport.parsed.sourceRange![0] : 0))); }} /><span><strong>{t(`Keep leading indices 0–${pendingImport.parsed.sourceRange[0] - 1}`, `Führende Indizes 0–${pendingImport.parsed.sourceRange[0] - 1} beibehalten`)}</strong><small>{t('Recommended when a matrix pattern starts with an incomplete first row. These slots are imported as missing LEDs, not as measured points.', 'Empfohlen, wenn ein Matrixmuster mit einer unvollständigen ersten Zeile beginnt. Diese Slots werden als fehlende LEDs importiert, nicht als gemessene Punkte.')}</small></span></label>}
        <div className="import-options"><label className="expected-count"><span>{t('Total physical LED slots', 'Gesamtzahl physischer LED-Slots')}</span><input autoFocus type="number" min={pendingImport.parsed.coords.length + (preserveCsvOrigin && pendingImport.parsed.sourceRange ? pendingImport.parsed.sourceRange[0] : 0)} max="20000" step="1" value={expectedLedCount} onChange={event => setExpectedLedCount(event.target.value)} onKeyDown={event => event.key === 'Enter' && confirmCsvImport()} /><small>{t(`Current minimum: ${pendingImport.parsed.coords.length + (preserveCsvOrigin && pendingImport.parsed.sourceRange ? pendingImport.parsed.sourceRange[0] : 0)} slots.`, `Aktuelles Minimum: ${pendingImport.parsed.coords.length + (preserveCsvOrigin && pendingImport.parsed.sourceRange ? pendingImport.parsed.sourceRange[0] : 0)} Slots.`)}</small></label><div className="local-pattern-note"><strong>{t('Automatic module draft', 'Automatischer Modul-Entwurf')}</strong><small>{t('Repeated row returns and zigzag reversals become editable matrices. Remaining runs become strips. The complete MMFL preview opens directly after import.', 'Wiederholte Zeilenrücksprünge und Zickzack-Wenden werden zu bearbeitbaren Matrizen. Verbleibende Läufe werden zu Streifen. Die vollständige MMFL-Vorschau öffnet sich direkt nach dem Import.')}</small></div></div>
        <div className="import-safety">{t('The entered number is authoritative. The app will never create a pixel outside that count.', 'Die eingegebene Anzahl ist verbindlich. Die App erzeugt niemals ein Pixel außerhalb dieser Anzahl.')}</div>
        <div className="modal-actions"><button className="secondary-button" onClick={() => setPendingImport(null)}>{t('Cancel', 'Abbrechen')}</button><button className="primary-button" onClick={confirmCsvImport}>{t('Import and build module preview', 'Importieren und Modulvorschau erstellen')}</button></div>
      </section></div>}

      {showAdjust && active && <div className="modal-backdrop" onMouseDown={() => setShowAdjust(false)}><section className="modal adjust-modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="adjust-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowAdjust(false)}>×</button><span className="eyebrow">{t('2D ALIGNMENT', '2D-AUSRICHTUNG')}</span><h2 id="adjust-title">{t(`Adjust ${active.name}`, `${active.name} justieren`)}</h2><p className="modal-lead">{t('Drag the panel freely around its centre. Use the mouse wheel to change its export size.', 'Ziehe das Panel frei um seinen Mittelpunkt. Mit dem Mausrad veränderst du seine Exportgröße.')}</p>
        <div className="adjust-layout"><div className="adjust-preview"><FixturePreview language={language} panel={active} points={points} ledSize={settings.ledSize} interactive showOutputGrid={showOutputGrid} onTransform={updatePanelTransform} /><div className="adjust-hint">{t('Drag: rotate · Wheel: scale', 'Ziehen: drehen · Mausrad: skalieren')}</div></div><div className="adjust-controls">
          <div className="control-block"><div className="control-title"><span>{t('Rotation', 'Rotation')}</span><output>{active.transform.rotation.toFixed(1)}°</output></div><input type="range" min="-180" max="180" step="0.1" value={active.transform.rotation} onChange={event => updatePanelTransform({ ...active.transform, rotation: Number(event.target.value) })} /><div className="snap-buttons"><button onClick={() => snapActive('horizontal')}>↔ {t('Horizontal', 'Horizontal')}</button><button onClick={() => snapActive('vertical')}>↕ {t('Vertical', 'Vertikal')}</button></div></div>
          <div className="control-block"><div className="control-title"><span>{t('Flip', 'Spiegeln')}</span><output>{active.transform.flipX || active.transform.flipY ? [active.transform.flipX && 'H', active.transform.flipY && 'V'].filter(Boolean).join(' + ') : t('Off', 'Aus')}</output></div><div className="snap-buttons flip-buttons"><button className={active.transform.flipX ? 'active' : ''} onClick={() => flipActive('horizontal')}>⇋ {t('Flip horizontal', 'Horizontal flippen')}</button><button className={active.transform.flipY ? 'active' : ''} onClick={() => flipActive('vertical')}>⇵ {t('Flip vertical', 'Vertikal flippen')}</button></div></div>
          <div className="control-block"><div className="control-title"><span>{t('Export size', 'Exportgröße')}</span><output>{Math.round(active.transform.scale * 100)} %</output></div><div className="scale-control"><button aria-label={t('Decrease size', 'Verkleinern')} onClick={() => updatePanelTransform({ ...active.transform, scale: active.transform.scale - .05 })}>−</button><input type="range" min="0.25" max="4" step="0.01" value={active.transform.scale} onChange={event => updatePanelTransform({ ...active.transform, scale: Number(event.target.value) })} /><button aria-label={t('Increase size', 'Vergrößern')} onClick={() => updatePanelTransform({ ...active.transform, scale: active.transform.scale + .05 })}>＋</button></div><small>{t('Affects preview and exported pixel spacing.', 'Wirkt auf Vorschau und Exportabstände.')}</small></div>
          <button className="reset-button" onClick={() => updatePanelTransform({ rotation: 0, scale: 1, flipX: false, flipY: false })}>{t('Reset alignment', 'Ausrichtung zurücksetzen')}</button>
        </div></div>
        <div className="modal-actions"><button className="secondary-button" onClick={() => setShowAdjust(false)}>{t('Close', 'Schließen')}</button><button className="primary-button" onClick={() => { setShowAdjust(false); setMessage(`${active.name}: ${active.transform.rotation.toFixed(1)}° · ${Math.round(active.transform.scale * 100)} %${active.transform.flipX ? ' · Flip H' : ''}${active.transform.flipY ? ' · Flip V' : ''}.`); }}>{t('Apply alignment', 'Ausrichtung übernehmen')}</button></div>
      </section></div>}

      {showRepair && active && <div className="modal-backdrop" onMouseDown={() => setShowRepair(false)}><section className="modal repair-modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="repair-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowRepair(false)}>×</button><span className="eyebrow">{t('AUTO REPAIR · REVIEW', 'AUTO-REPAIR · VORSCHAU')}</span><h2 id="repair-title">{t('Review generated pixels and clear outliers', 'Erzeugte Pixel und eindeutige Ausreißer prüfen')}</h2><p className="modal-lead">{t('Inferred and manually inserted pixels are checked first. Measured coordinates stay protected unless you explicitly enable the strict outlier check below.', 'Berechnete und manuell hinzugefügte Pixel werden zuerst geprüft. Gemessene Koordinaten bleiben geschützt, solange du die strenge Ausreißerprüfung unten nicht ausdrücklich aktivierst.')}</p>
        <div className="repair-protection"><label><input type="checkbox" checked={includeMeasuredRepairs} onChange={event => changeMeasuredRepairMode(event.target.checked)} /><span><strong>{t('Include clear measured outliers', 'Eindeutige gemessene Ausreißer einbeziehen')}</strong><small>{t('Off by default. A measured LED is suggested only when both the local line and the wider neighbourhood identify it as an outlier. Nothing is preselected.', 'Standardmäßig aus. Eine gemessene LED wird nur vorgeschlagen, wenn sowohl die lokale Linie als auch die weitere Nachbarschaft sie als Ausreißer erkennen. Nichts wird vorausgewählt.')}</small></span></label></div>
        <div className="repair-toolbar"><div className="repair-thresholds"><label className={!includeMeasuredRepairs ? 'disabled-control' : ''}>{t('Wider-neighbour deviation', 'Abweichung zur weiteren Nachbarschaft')}<div className="threshold-control"><input disabled={!includeMeasuredRepairs} aria-label={t('Deviation threshold in average pixel spacings', 'Abweichungsschwellwert in mittleren Pixelabständen')} type="range" min="0.75" max="6" step="0.05" value={repairThreshold} onChange={event => changeRepairThreshold(Number(event.target.value))} /><output>{repairThreshold.toFixed(2)} ×</output></div></label><label className={!includeMeasuredRepairs ? 'disabled-control' : ''}>{t('Local outlier deviation', 'Lokale Ausreißerabweichung')}<div className="threshold-control"><input disabled={!includeMeasuredRepairs} aria-label={t('Local outlier threshold as part of average spacing', 'Lokaler Ausreißerschwellwert als Anteil des mittleren Abstands')} type="range" min="0.15" max="2" step="0.05" value={lineRepairThreshold} onChange={event => changeLineRepairThreshold(Number(event.target.value))} /><output>{(lineRepairThreshold * 100).toFixed(0)} %</output></div><small>{t('Conservative default: normal scan noise, curves and row turns are ignored.', 'Konservative Voreinstellung: Normales Scanrauschen, Kurven und Zeilenwechsel werden ignoriert.')}</small></label></div><div className="repair-zoom"><button aria-label={t('Zoom out', 'Verkleinern')} onClick={() => setRepairZoom(value => Math.max(1, value - .5))}>−</button><input aria-label={t('Repair preview zoom', 'Zoom der Reparaturvorschau')} type="range" min="1" max="8" step="0.1" value={repairZoom} onChange={event => setRepairZoom(Number(event.target.value))} /><output>{Math.round(repairZoom * 100)} %</output><button aria-label={t('Zoom in', 'Vergrößern')} onClick={() => setRepairZoom(value => Math.min(8, value + .5))}>＋</button></div></div>
        {repairModel && <div className="matrix-summary"><span>{t('Local pattern detection', 'Lokale Mustererkennung')}: <b>{t('active', 'aktiv')}</b></span><span>{t('Mixed matrices and straight strips', 'Gemischte Matrizen und gerade Streifen')}</span><span>{t('Average spacing', 'Mittlerer Abstand')}: <b>{repairModel.averagePitch.toFixed(3)}</b></span></div>}
        <RepairPreview language={language} key={active.id} panel={active} points={points} suggestions={repairSuggestions} zoom={repairZoom} onZoomChange={setRepairZoom} />
        <div className="repair-pan-hint">{t('Drag: pan · Wheel: zoom · Double-click: centre', 'Ziehen: Ausschnitt verschieben · Mausrad: zoomen · Doppelklick: zentrieren')}</div>
        <div className="repair-legend"><span><i className="original" /> {t('Original', 'Original')}</span><span><i className="proposed" /> {t('Proposed', 'Vorschlag')}</span><span>{selectedRepairCount}/{repairSuggestions.length} {t('selected', 'ausgewählt')}</span></div>
        <div className="repair-list">{repairSuggestions.length ? repairSuggestions.map(suggestion => <label className={`repair-row ${suggestion.selected ? 'selected' : ''}`} key={suggestion.id}><input type="checkbox" checked={suggestion.selected} onChange={() => setRepairSuggestions(items => items.map(item => item.id === suggestion.id ? { ...item, selected: !item.selected } : item))} /><span className="repair-index">#{suggestion.sourceIndex + 1}</span><span className="repair-copy"><strong>{repairReason(suggestion.reason)}</strong><small>{suggestion.before.map(value => value.toFixed(2)).join(' / ')} → {suggestion.after.map(value => value.toFixed(2)).join(' / ')} · {Number.isFinite(suggestion.deviationRatio) ? `${suggestion.deviationRatio.toFixed(3)} ×` : '∞'} · {suggestion.supportCount} {t('neighbours', 'Nachbarn')}</small></span><span className={`confidence ${suggestion.confidence}`}>{confidenceLabel(suggestion.confidence)}</span></label>) : <div className="repair-empty">{includeMeasuredRepairs ? t('No measured pixel exceeds the selected local or matrix threshold.', 'Kein gemessenes Pixel überschreitet den lokalen oder Matrix-Schwellwert.') : t('All missing CSV pixels that could be calculated were already positioned automatically. Measured coordinates remain unchanged.', 'Alle berechenbaren fehlenden CSV-Pixel wurden bereits automatisch positioniert. Gemessene Koordinaten bleiben unverändert.')}</div>}</div>
        <div className="repair-note">{t('Generated pixels use the nearest supported matrix or zigzag pattern. Measured LEDs require agreement between four intact line neighbours and the wider neighbourhood; bends and row turns are rejected. Every change must be selected manually.', 'Erzeugte Pixel nutzen das nächste ausreichend belegte Matrix- oder Zickzack-Muster. Gemessene LEDs benötigen Übereinstimmung zwischen vier intakten Liniennachbarn und der weiteren Nachbarschaft; Kurven und Zeilenwechsel werden verworfen. Jede Änderung muss manuell ausgewählt werden.')}</div>
        <div className="modal-actions"><button className="secondary-button" onClick={() => { setShowRepair(false); setRepairSuggestions([]); setMessage(t('Repair suggestions discarded — original data unchanged.', 'Reparaturvorschläge verworfen — Originaldaten unverändert.')); }}>{t('Cancel', 'Abbrechen')}</button><button className="primary-button repair-apply" disabled={!selectedRepairCount} onClick={applyRepairs}>{t(`Apply ${selectedRepairCount} selected`, `${selectedRepairCount} ausgewählte anwenden`)}</button></div>
      </section></div>}

      {showExport && <div className="modal-backdrop" onMouseDown={() => setShowExport(false)}><section className="modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="export-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowExport(false)}>×</button><span className="eyebrow">EXPORT</span><h2 id="export-title">{t('Create MadMapper fixture', 'MadMapper Fixture erstellen')}</h2><p className="modal-lead">{t('MMFL uses the modular output grid. SVG and CSV continue to use the enabled scan regions.', 'MMFL verwendet das modulare Ausgaberaster. SVG und CSV verwenden weiterhin die aktivierten Scan-Bereiche.')}</p>
        <div className="export-summary"><span>{t('Modules', 'Module')}<b>{modules.length}</b></span><span>{t('Assigned', 'Zugewiesen')}<b>{assignedCount}/{points.length}</b></span><span>{t('Hidden', 'Ausgeblendet')}<b>{hiddenIndices.length}</b></span><span>{t('Grid', 'Raster')}<b>{modularGrid.width}×{modularGrid.height}</b></span><span className={modularGrid.collisions.length ? 'bad' : ''}>{t('Collisions', 'Kollisionen')}<b>{modularGrid.collisions.length}</b></span></div>
        <div className="form-grid"><label>Fixture Definition<input value={settings.definition} onChange={event => setSettings(current => ({ ...current, definition: event.target.value }))} /></label><label>{t('Channels per pixel', 'Kanäle pro Pixel')}<select value={settings.channels} onChange={event => setSettings(current => ({ ...current, channels: Number(event.target.value), definition: Number(event.target.value) === 4 ? 'Generic - Pixel RGBW' : 'Generic - Pixel RGB' }))}><option value={3}>RGB · 3</option><option value={4}>RGBW · 4</option></select></label><label>{t('Start universe', 'Start Universe')}<input type="number" min="0" max="32767" value={settings.universe} onChange={event => setSettings(current => ({ ...current, universe: Math.max(0, Number(event.target.value)) }))} /></label><label>{t('Start channel', 'Start Channel')}<input type="number" min="1" max="512" value={settings.channel} onChange={event => setSettings(current => ({ ...current, channel: Math.max(1, Math.min(512, Number(event.target.value))) }))} /></label><label>{t('Pixel size in MadMapper', 'Pixelgröße in MadMapper')}<input type="number" min="1" max="64" value={settings.ledSize} onChange={event => setSettings(current => ({ ...current, ledSize: Math.max(1, Number(event.target.value)) }))} /></label></div>
        <p className="file-name-preview">{t('Saved as', 'Wird gespeichert als')}: <strong>{safeName(settings.definition)}.[svg/csv/mmfl]</strong></p>
        <div className="format-cards"><button onClick={() => exportFile('svg')}><b>SVG 6.1</b><span>{t('Freeform', 'Freiform')}</span><small>{t('Exact projected positions and DMX patch from enabled scan regions.', 'Exakte projizierte Positionen und DMX-Patch aus aktivierten Scan-Bereichen.')}</small></button><button onClick={() => exportFile('csv')}><b>CSV</b><span>{t('Table', 'Tabelle')}</span><small>{t('Individual fixtures with position, definition and patch.', 'Einzel-Fixtures mit Position, Definition und Patch.')}</small></button><button disabled={unassignedCount > 0 || modularGrid.collisions.length > 0} onClick={() => exportFile('mmfl')}><b>MMFL</b><span>{t('Modular grid', 'Modulraster')}</span><small>{unassignedCount ? t(`Assign ${unassignedCount} remaining LED slots first.`, `Weise zuerst die ${unassignedCount} übrigen LED-Slots zu.`) : modularGrid.collisions.length ? t(`Resolve ${modularGrid.collisions.length} grid collisions first.`, `Löse zuerst ${modularGrid.collisions.length} Rasterkollisionen.`) : t('Ready: hidden pixels remain empty while reserving their original channel offsets.', 'Bereit: ausgeblendete Pixel bleiben leer und reservieren ihre ursprünglichen Kanalabstände.')}</small></button></div>
        <div className="format-note"><strong>{t('Hidden LED compatibility', 'Kompatibilität ausgeblendeter LEDs')}</strong> {t('MMFL has no publicly documented hidden-pixel flag. Pixel Fixture Studio therefore writes the cell as empty (0) but calculates every later address from the original source index. This preserves physical wiring and DMX offsets.', 'MMFL besitzt kein öffentlich dokumentiertes Kennzeichen für ausgeblendete Pixel. Pixel Fixture Studio schreibt die Zelle deshalb leer (0), berechnet aber jede spätere Adresse aus dem ursprünglichen Quellindex. So bleiben physische Verdrahtung und DMX-Abstände erhalten.')}</div>
      </section></div>}

      {showHelp && <div className="modal-backdrop" onMouseDown={() => setShowHelp(false)}><section className="modal help-modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="help-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowHelp(false)}>×</button><span className="eyebrow">{t('FORMAT HELP', 'FORMAT-HILFE')}</span><h2 id="help-title">{t('Which format should I use?', 'Welches Format wofür?')}</h2>
        <div className="help-row"><b>Import</b><p>{t('Pixelblaze JSON, Marimapper 3D CSV ', 'Pixelblaze-JSON sowie Marimapper-3D-CSV ')}(<code>index,x,y,z,xn,yn,zn,error</code>) {t('and 2D CSV ', 'und 2D-CSV ')}(<code>index,u,v</code>). {t('For CSV files, the app asks for the expected LED count. Only internal gaps are automatic; extra trailing LEDs require an explicitly larger count. Missing entries are positioned from locally detected zigzag rows, allowing multiple matrix sizes in one scan, then marked as inferred and included in export.', 'Bei CSV-Dateien fragt die App nach der erwarteten LED-Anzahl. Nur interne Lücken werden automatisch ergänzt; zusätzliche Endpixel erfordern eine ausdrücklich größere Anzahl. Fehlende Einträge werden aus lokal erkannten Zickzack-Zeilen positioniert, sodass mehrere Matrixgrößen in einem Scan möglich sind; anschließend werden sie als berechnet markiert und exportiert.')}</p></div>
        <div className="help-row"><b>SVG 6.1</b><p>{t('Use File → Import Fixtures. Each LED becomes its own fixture with current ', 'Für File → Import Fixtures. Jede LED wird als eigenes Fixture mit aktuellen ')}<code>universe</code>, <code>channel</code> {t('and', 'und')} <code>fixture_definition</code> {t('attributes.', 'Attributen angelegt.')}</p></div>
        <div className="help-row"><b>CSV</b><p>{t('A robust table alternative for fixture instances, semicolon-delimited and grouped by panel path.', 'Robuste Tabellenalternative für Fixture-Instanzen. Semikolon-getrennt und mit Gruppenpfaden pro Panel.')}</p></div>
        <div className="help-row"><b>{t('Builder', 'Baukasten')}</b><p>{t('Assign every imported LED exactly once to a matrix, strip or single-pixel module. Automatic suggestions copy the relative position, projected orientation and size from the retained 3D camera. Rotate the 3D view and use Match current 3D arrangement whenever you want a different projection; then fine-tune individual modules.', 'Ordne jede importierte LED genau einmal einem Matrix-, Streifen- oder Einzelpixel-Modul zu. Automatische Vorschläge übernehmen relative Position, projizierte Ausrichtung und Größe aus der gespeicherten 3D-Kamera. Drehe die 3D-Ansicht und nutze Aktuelle 3D-Anordnung übernehmen, wenn du eine andere Projektion möchtest; anschließend kannst du einzelne Module fein einstellen.')}</p></div>
        <div className="help-row"><b>MMFL</b><p>{t('For import in the Fixture Editor. The product name comes from Fixture Definition. A physically present but unused LED is stored as an empty grid cell; later LED addresses still derive from their original source indices, so the unused LED continues to reserve its wiring/DMX position.', 'Für den Import im Fixture Editor. Der Produktname stammt aus Fixture Definition. Eine physisch vorhandene, aber unbenutzte LED wird als leere Rasterzelle gespeichert; spätere LED-Adressen werden weiterhin aus ihren ursprünglichen Quellindizes berechnet, sodass die unbenutzte LED ihre Verdrahtungs-/DMX-Position reserviert.')}</p></div>
        <div className="help-warning">{t('Legacy MadMapper 5 SVG attributes are intentionally omitted. The export follows the current 6.1 documentation.', 'Alte MadMapper-5-SVG-Attribute werden bewusst nicht verwendet. Der Export folgt der aktuellen 6.1-Dokumentation.')}</div>
      </section></div>}
    </main>
  );
}
