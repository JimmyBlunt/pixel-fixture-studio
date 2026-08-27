'use client';

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';

type Vec3 = [number, number, number];
type Language = 'en' | 'de';
type MapPoint = { sourceIndex: number; xyz: Vec3; status: 'ok' | 'placeholder' | 'outlier' };
type PanelTransform = { rotation: number; scale: number; flipX: boolean; flipY: boolean };
type Panel = { id: string; name: string; indices: number[]; color: string; enabled: boolean; transform: PanelTransform };
type Camera = { yaw: number; pitch: number; zoom: number };
type Projection = { sourceIndex: number; u: number; v: number };
type PanelBasis = { center: Vec3; e1: Vec3; e2: Vec3 };
type RepairSuggestion = {
  id: string;
  sourceIndex: number;
  before: Vec3;
  after: Vec3;
  reason: 'missing-reading' | 'index-gap' | 'position-outlier' | 'local-outlier';
  confidence: 'high' | 'medium' | 'low';
  selected: boolean;
};
type RepairSensitivity = 'conservative' | 'balanced' | 'sensitive';
type ParsedMap = { coords: Vec3[]; missingIndices: Set<number>; sourceLabel: string; measuredCount: number };

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
  lines.slice(1).forEach((line, rowIndex) => {
    const values = line.split(',').map(value => value.trim());
    const index = Number(values[column('index')]);
    const xyz = is3d ? [Number(values[column('x')]), Number(values[column('y')]), Number(values[column('z')])] : [Number(values[column('u')]), Number(values[column('v')]), 0];
    if (!Number.isInteger(index) || index < 0 || !xyz.every(Number.isFinite)) throw new Error(translated(language, `Marimapper row ${rowIndex + 2} contains an invalid index or coordinates.`, `Marimapper-Zeile ${rowIndex + 2} enthält ungültige Index- oder Koordinatenwerte.`));
    if (measured.has(index)) throw new Error(translated(language, `Marimapper index ${index} occurs more than once.`, `Der Marimapper-Index ${index} kommt mehrfach vor.`));
    measured.set(index, xyz as Vec3);
  });
  if (!measured.size) throw new Error(translated(language, 'The Marimapper CSV does not contain valid LEDs.', 'Die Marimapper-CSV enthält keine gültigen LEDs.'));
  const maxIndex = Math.max(...measured.keys());
  if (maxIndex >= 20000) throw new Error(translated(language, 'The interactive preview supports up to 20,000 LED slots.', 'Für die interaktive Vorschau sind maximal 20.000 LED-Slots vorgesehen.'));
  const coords = Array.from({ length: maxIndex + 1 }, (_, index) => measured.get(index) ?? [0, 0, 0] as Vec3);
  const missingIndices = new Set(coords.map((_, index) => index).filter(index => !measured.has(index)));
  return { coords, missingIndices, sourceLabel: is3d ? 'Marimapper 3D-CSV' : 'Marimapper 2D-CSV', measuredCount: measured.size };
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

function estimatePosition(sourceIndex: number, valid: MapPoint[], pitch: number) {
  const before = valid.filter(point => point.sourceIndex < sourceIndex).sort((a, b) => b.sourceIndex - a.sourceIndex);
  const after = valid.filter(point => point.sourceIndex > sourceIndex).sort((a, b) => a.sourceIndex - b.sourceIndex);
  const candidates: Vec3[] = [];

  if (before[0] && after[0]) {
    const span = after[0].sourceIndex - before[0].sourceIndex;
    const t = (sourceIndex - before[0].sourceIndex) / Math.max(span, 1);
    candidates.push(add(before[0].xyz, scaleVec(sub(after[0].xyz, before[0].xyz), t)));
  }
  if (before[0] && before[1]) {
    const step = scaleVec(sub(before[0].xyz, before[1].xyz), 1 / Math.max(before[0].sourceIndex - before[1].sourceIndex, 1));
    candidates.push(add(before[0].xyz, scaleVec(step, sourceIndex - before[0].sourceIndex)));
  }
  if (after[0] && after[1]) {
    const step = scaleVec(sub(after[1].xyz, after[0].xyz), 1 / Math.max(after[1].sourceIndex - after[0].sourceIndex, 1));
    candidates.push(sub(after[0].xyz, scaleVec(step, after[0].sourceIndex - sourceIndex)));
  }
  if (!candidates.length) return null;

  const position = averageVec(candidates);
  const disagreement = Math.max(...candidates.map(candidate => dist(candidate, position)), 0);
  const support = Math.min(before.length, 2) + Math.min(after.length, 2);
  const confidence: RepairSuggestion['confidence'] = support >= 4 && disagreement <= pitch * .7 ? 'high' : support >= 2 && disagreement <= pitch * 1.6 ? 'medium' : 'low';
  return { position, confidence };
}

/** Suggest repairs from index-neighbour interpolation without mutating source data. */
function findRepairSuggestions(panel: Panel, points: MapPoint[], pitch: number, sensitivity: RepairSensitivity = 'conservative'): RepairSuggestion[] {
  if (!panel.indices.length) return [];
  const sortedPanel = [...panel.indices].sort((a, b) => a - b);
  const minIndex = sortedPanel[0], maxIndex = sortedPanel[sortedPanel.length - 1];
  const panelSet = new Set(sortedPanel);
  const suspectReasons = new Map<number, RepairSuggestion['reason']>();
  const profile = sensitivity === 'sensitive' ? { gap: 2, localShift: 1.8, neighborSpan: 3.2, repairShift: 1.1, allowLow: true } : sensitivity === 'balanced' ? { gap: 1, localShift: 2.4, neighborSpan: 2.9, repairShift: 1.7, allowLow: false } : { gap: 1, localShift: 3.2, neighborSpan: 2.6, repairShift: 2.4, allowLow: false };
  const isBracketed = (index: number) => {
    let before = false, after = false;
    for (let step = 1; step <= profile.gap; step++) { before ||= panelSet.has(index - step); after ||= panelSet.has(index + step); }
    return before && after;
  };

  for (let index = minIndex; index <= maxIndex; index++) {
    const point = points[index];
    if (!point || !isBracketed(index)) continue;
    if (point.status === 'placeholder') suspectReasons.set(index, 'missing-reading');
    else if (point.status === 'outlier') suspectReasons.set(index, 'position-outlier');
    else if (!panelSet.has(index) && sensitivity !== 'conservative') suspectReasons.set(index, 'index-gap');
  }

  sortedPanel.forEach((index, rank) => {
    if (rank === 0 || rank === sortedPanel.length - 1 || suspectReasons.has(index)) return;
    const current = points[index], previous = points[sortedPanel[rank - 1]], next = points[sortedPanel[rank + 1]];
    if (!current || !previous || !next || previous.status !== 'ok' || next.status !== 'ok' || index - previous.sourceIndex > profile.gap || next.sourceIndex - index > profile.gap) return;
    const midpoint = averageVec([previous.xyz, next.xyz]);
    const neighborSpan = dist(previous.xyz, next.xyz);
    if (neighborSpan <= pitch * profile.neighborSpan && dist(current.xyz, midpoint) > pitch * profile.localShift) suspectReasons.set(index, 'local-outlier');
  });

  const suspects = new Set(suspectReasons.keys());
  const valid = points.filter(point => point.sourceIndex >= minIndex && point.sourceIndex <= maxIndex && panelSet.has(point.sourceIndex) && point.status === 'ok' && !suspects.has(point.sourceIndex));
  return [...suspectReasons.entries()].sort((a, b) => a[0] - b[0]).flatMap(([sourceIndex, reason]) => {
    const estimate = estimatePosition(sourceIndex, valid, pitch);
    const point = points[sourceIndex];
    if (!estimate || !point) return [];
    if (!profile.allowLow && estimate.confidence === 'low') return [];
    if ((reason === 'position-outlier' || reason === 'local-outlier') && dist(point.xyz, estimate.position) < pitch * profile.repairShift) return [];
    return [{ id: `repair-${sourceIndex}`, sourceIndex, before: point.xyz, after: estimate.position, reason, confidence: estimate.confidence, selected: estimate.confidence !== 'low' }];
  });
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

/** Generate an experimental MMFL fixture library using a quantised LED grid. */
function buildMmfl(panels: Panel[], points: MapPoint[], settings: ExportSettings) {
  const fixtures = panels.map(panel => {
    const baseProjected = projectPanel(panel, points);
    const projected = transformProjection(baseProjected, panel.transform);
    const nearest2d = baseProjected.map((p, i) => Math.min(...baseProjected.filter((_, j) => i !== j).map(q => Math.hypot(p.u - q.u, p.v - q.v)))).filter(Number.isFinite);
    const pitch = Math.max(median(nearest2d), .001);
    const uMin = Math.min(...projected.map(p => p.u)), vMin = Math.min(...projected.map(p => p.v));
    const cells = projected.map((p, rank) => ({ x: Math.round((p.u - uMin) / pitch), y: Math.round((p.v - vMin) / pitch), value: 1 + rank * settings.channels }));
    const width = Math.max(...cells.map(c => c.x)) + 1, height = Math.max(...cells.map(c => c.y)) + 1;
    const grid = Array.from({ length: width * height }, () => 0);
    cells.forEach(cell => { if (!grid[cell.y * width + cell.x]) grid[cell.y * width + cell.x] = cell.value; });
    return `  <LEDFixture favorite="1" group="Pixel Fixture Studio" product="${xmlEscape(panel.name)}">\n    <PixelMapping avoidCrossUniversePixels="1" type="${settings.channels === 4 ? 'RGBW' : 'RGB'}" height="${height}" width="${width}">${grid.join(' ')}</PixelMapping>\n  </LEDFixture>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<LEDFixtureLibrary>\n${fixtures.join('\n')}\n</LEDFixtureLibrary>\n`;
}

type ExportSettings = { universe: number; channel: number; channels: number; ledSize: number; definition: string };

function download(name: string, content: string, type: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type })); link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function MapCanvas({ points, panels, selectionMode, onSelection, camera, onCameraChange, language }: { points: MapPoint[]; panels: Panel[]; selectionMode: boolean; onSelection: (indices: number[]) => void; camera: Camera; onCameraChange: (camera: Camera) => void; language: Language }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number; selecting: boolean } | null>(null);
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
      const visible = panels.filter(p => p.enabled).flatMap(panel => panel.indices.map(index => ({ index, color: panel.color })));
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
      rotated.forEach((p, i) => { const screen = projectedRef.current[i]; ctx.shadowColor = p.color; ctx.shadowBlur = 8; ctx.fillStyle = p.color; ctx.globalAlpha = .66 + i / Math.max(rotated.length, 1) * .34; ctx.beginPath(); ctx.arc(screen.x, screen.y, Math.max(2, Math.min(4.2, 2.3 * camera.zoom)), 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      points.filter(p => p.status !== 'ok').forEach(p => {
        const visiblePoint = projectedRef.current.find(q => q.index === p.sourceIndex); if (!visiblePoint) return;
        ctx.strokeStyle = p.status === 'outlier' ? '#ffb454' : '#5f6a80'; ctx.strokeRect(visiblePoint.x - 3, visiblePoint.y - 3, 6, 6);
      });
      if (box) { ctx.fillStyle = 'rgba(255,79,135,.12)'; ctx.strokeStyle = '#ff4f87'; ctx.setLineDash([5, 4]); ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.setLineDash([]); }
    };
    render(); const observer = new ResizeObserver(render); observer.observe(canvas); return () => observer.disconnect();
  }, [points, panels, box, revision, camera]);

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const r = event.currentTarget.getBoundingClientRect(); const x = event.clientX - r.left, y = event.clientY - r.top;
    const selecting = selectionMode || event.shiftKey;
    drag.current = { x, y, yaw: camera.yaw, pitch: camera.pitch, selecting };
    if (selecting) setBox({ x1: x, y1: y, x2: x, y2: y });
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return; const r = event.currentTarget.getBoundingClientRect(); const x = event.clientX - r.left, y = event.clientY - r.top;
    if (drag.current.selecting) setBox(old => old ? { ...old, x2: x, y2: y } : null);
    else { onCameraChange({ ...camera, yaw: drag.current.yaw + (x - drag.current.x) * .008, pitch: Math.max(-1.5, Math.min(1.5, drag.current.pitch + (y - drag.current.y) * .008)) }); setRevision(v => v + 1); }
  };
  const pointerUp = () => {
    if (drag.current?.selecting && box) {
      const minX = Math.min(box.x1, box.x2), maxX = Math.max(box.x1, box.x2), minY = Math.min(box.y1, box.y2), maxY = Math.max(box.y1, box.y2);
      onSelection(projectedRef.current.filter(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY).map(p => p.index));
      setBox(null);
    }
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

function FixturePreview({ panel, points, ledSize, interactive = false, onTransform, language }: { panel?: Panel; points: MapPoint[]; ledSize: number; interactive?: boolean; onTransform?: (transform: PanelTransform) => void; language: Language }) {
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
      projected.forEach((point, index) => {
        const x = centerX + point.u * scale, y = centerY + point.v * scale;
        ctx.fillStyle = panel?.color ?? '#ff4f87'; ctx.shadowColor = panel?.color ?? '#ff4f87'; ctx.shadowBlur = interactive ? 7 : 4; ctx.globalAlpha = .62 + .38 * index / projected.length;
        const size = Math.max(2.4, Math.min(7, ledSize / (interactive ? 1.5 : 2.5)));
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      });
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    };
    render(); const observer = new ResizeObserver(render); observer.observe(canvas); return () => observer.disconnect();
  }, [panel, points, ledSize, interactive]);

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
  const [language, setLanguage] = useState<Language>('en');
  const [points, setPoints] = useState(initial.points);
  const [panels, setPanels] = useState(initial.panels);
  const [fileName, setFileName] = useState('Demo · 3 Panels');
  const [pitch, setPitch] = useState(initial.pitch);
  const [activeId, setActiveId] = useState(initial.panels[0]?.id ?? '');
  const [view, setView] = useState('3D');
  const [mapCamera, setMapCamera] = useState<Camera>({ yaw: -.5, pitch: -.28, zoom: 1 });
  const [stageMode, setStageMode] = useState<'3d' | '2d'>('3d');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<number[]>([]);
  const [message, setMessage] = useState('Demo data is active — load a Pixelblaze JSON or Marimapper CSV file.');
  const [error, setError] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [showRepair, setShowRepair] = useState(false);
  const [repairSuggestions, setRepairSuggestions] = useState<RepairSuggestion[]>([]);
  const [repairSensitivity, setRepairSensitivity] = useState<RepairSensitivity>('conservative');
  const [repairZoom, setRepairZoom] = useState(1);
  const [settings, setSettings] = useState<ExportSettings>({ universe: 0, channel: 1, channels: 3, ledSize: 6, definition: 'Generic - Pixel RGB' });
  const inputRef = useRef<HTMLInputElement>(null);
  const t = (english: string, german: string) => translated(language, english, german);
  const numberFormat = useMemo(() => new Intl.NumberFormat(language === 'en' ? 'en-US' : 'de-DE'), [language]);
  const active = panels.find(panel => panel.id === activeId) ?? panels[0];
  const enabledPanels = panels.filter(panel => panel.enabled);
  const placeholders = points.filter(point => point.status === 'placeholder').length;
  const outliers = points.filter(point => point.status === 'outlier').length;
  const selectedRepairCount = repairSuggestions.filter(suggestion => suggestion.selected).length;
  const viewLabel = view === 'Top' ? t('Top', 'Oben') : view === 'Side' ? t('Side', 'Seite') : view;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    setError('');
    setMessage(next === 'en' ? 'Language changed to English.' : 'Sprache auf Deutsch umgestellt.');
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
      const coords = parsed.coords;
      if (coords.length > 20000) throw new Error(t('The interactive preview supports up to 20,000 LEDs.', 'Für die interaktive Vorschau sind maximal 20.000 LEDs vorgesehen.'));
      const result = analyze(coords, parsed.missingIndices);
      if (!result.panels.length) throw new Error(t('No connected LED regions were detected. Use a clean scan or select points manually.', 'Keine zusammenhängenden LED-Bereiche erkannt. Nutze eine sauber gescannte Map oder wähle Punkte manuell.'));
      setPoints(result.points);
      setPanels(result.panels);
      setActiveId(result.panels[0].id);
      setPitch(result.pitch);
      setFileName(file.name);
      setSelection([]);
      setRepairSuggestions([]);
      setRepairZoom(1);
      setShowRepair(false);
      setShowAdjust(false);
      setStageMode('3d');
      setError('');
      const gapInfo = parsed.missingIndices.size ? t(` · ${parsed.missingIndices.size} missing indices preserved as placeholders`, ` · ${parsed.missingIndices.size} fehlende Indizes als Platzhalter`) : '';
      setMessage(t(
        `${parsed.sourceLabel}: ${numberFormat.format(coords.length)} slots loaded · ${result.panels.length} panels detected${gapInfo}.`,
        `${parsed.sourceLabel}: ${numberFormat.format(coords.length)} Slots geladen · ${result.panels.length} Panels erkannt${gapInfo}.`,
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('The file could not be read.', 'Die Datei konnte nicht gelesen werden.'));
    }
    event.target.value = '';
  };

  const togglePanel = (id: string) => setPanels(items => items.map(item => item.id === id ? { ...item, enabled: !item.enabled } : item));
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
    const suggestions = findRepairSuggestions(active, points, pitch, repairSensitivity);
    setRepairSuggestions(suggestions);
    setRepairZoom(1);
    setShowRepair(true);
    setMessage(suggestions.length
      ? t(`${suggestions.length} possible measurement errors found in ${active.name} — no data has been changed.`, `${suggestions.length} mögliche Messfehler in ${active.name} gefunden — noch nichts verändert.`)
      : t(`${active.name}: the conservative scan found no clear issues. You can raise the sensitivity in the review.`, `${active.name}: konservative Prüfung ohne eindeutige Treffer. Im Fenster kannst du die Prüfstufe erhöhen.`));
  };
  const changeRepairSensitivity = (next: RepairSensitivity) => {
    setRepairSensitivity(next);
    if (!active) return;
    const suggestions = findRepairSuggestions(active, points, pitch, next);
    setRepairSuggestions(suggestions);
    setMessage(t(`${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} at the selected sensitivity.`, `${suggestions.length} Vorschlag${suggestions.length === 1 ? '' : 'e'} mit der gewählten Prüfstufe.`));
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
    if (!enabledPanels.length) {
      setError(t('Enable at least one panel for export.', 'Aktiviere mindestens ein Panel für den Export.'));
      return;
    }
    // The Fixture Definition is the user's canonical export name.
    const base = safeName(settings.definition);
    const mime = format === 'svg' ? 'image/svg+xml' : format === 'csv' ? 'text/csv' : 'application/xml';
    const content = format === 'svg' ? buildSvg(enabledPanels, points, settings) : format === 'csv' ? buildCsv(enabledPanels, points, settings) : buildMmfl(enabledPanels, points, settings);
    download(`${base}.${format}`, content, mime);
    setMessage(t(`${format.toUpperCase()} created for ${enabledPanels.length} panel${enabledPanels.length === 1 ? '' : 's'}.`, `${format.toUpperCase()} für ${enabledPanels.length} Panel${enabledPanels.length === 1 ? '' : 's'} erstellt.`));
  };
  const repairReason = (reason: RepairSuggestion['reason']) => ({
    'missing-reading': t('Missing reading', 'Fehlender Messwert'),
    'index-gap': t('Index gap', 'Index-Lücke'),
    'position-outlier': t('Position outlier', 'Positionsausreißer'),
    'local-outlier': t('Local outlier', 'Lokaler Ausreißer'),
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
            <li className={showAdjust || showRepair ? 'active' : ''}><span>3</span><div><strong>{t('Review & align', 'Prüfen & ausrichten')}</strong><small>{t('Repair · rotation · size', 'Repair · Rotation · Größe')}</small></div></li>
            <li className={showExport ? 'active' : ''}><span>4</span><div><strong>{t('Export', 'Exportieren')}</strong><small>SVG · CSV · MMFL</small></div></li>
          </ol>
          <button className="load-button" onClick={() => inputRef.current?.click()}>＋ {t('Load JSON / CSV map', 'JSON / CSV Map laden')}</button>
          <div className="tool-group">
            <button className={selectionMode ? 'tool active' : 'tool'} onClick={() => setSelectionMode(value => !value)}>▧ {t('Box selection', 'Rahmenauswahl')}</button>
            <button className="tool" disabled={!selection.length} onClick={addSelection}>＋ {t('Selection as panel', 'Auswahl als Panel')}</button>
          </div>
          <div className="tool-group">
            <button className="tool" disabled={!active} onClick={() => setShowAdjust(true)}>↻ {t('Align active panel', 'Aktives Panel ausrichten')}</button>
            <button className="tool repair-tool" disabled={!active} onClick={openRepairReview}>◇ {t('Review measurements', 'Messfehler prüfen')}</button>
          </div>
          <div className="data-card"><span>{t('Detected LED spacing', 'Erkannter LED-Abstand')}</span><strong>{pitch.toFixed(3)}</strong><small>{t('Cluster radius', 'Cluster-Radius')}: {(pitch * 3).toFixed(3)}</small></div>
          <p className="privacy-note">{t('Your mapping file stays on this device and is never uploaded.', 'Deine Mapping-Datei bleibt auf diesem Gerät und wird nicht hochgeladen.')}</p>
        </aside>

        <section className="stage-card">
          <div className="stage-toolbar">
            <div><span className="eyebrow">{stageMode === '3d' ? '3D MAP' : t('MADMAPPER 2D · LARGE VIEW', 'MADMAPPER 2D · GROSSANSICHT')}</span><h1>{stageMode === '3d' ? fileName : active?.name ?? t('No panel selected', 'Kein Panel ausgewählt')}</h1></div>
            <div className="stage-actions"><button className="swap-button" onClick={() => setStageMode(mode => mode === '3d' ? '2d' : '3d')}>⇄ {stageMode === '3d' ? t('Large 2D', '2D groß') : t('Large 3D', '3D groß')}</button><button disabled={!active} onClick={openRepairReview}>Auto Repair</button></div>
            {stageMode === '3d' && <div className="view-switch">{[
              { id: '3D', label: '3D' }, { id: 'Top', label: t('Top', 'Oben') }, { id: 'Front', label: 'Front' }, { id: 'Side', label: t('Side', 'Seite') },
            ].map(item => <button key={item.id} className={view === item.id ? 'selected' : ''} onClick={() => selectView(item.id)}>{item.label}</button>)}</div>}
          </div>
          <div className={`viewport ${stageMode === '2d' ? 'viewport-2d' : ''}`}>
            {stageMode === '3d' ? <>
              <MapCanvas language={language} points={points} panels={panels} selectionMode={selectionMode} onSelection={indices => { setSelection(indices); setMessage(t(`${numberFormat.format(indices.length)} LEDs selected inside the box.`, `${numberFormat.format(indices.length)} LEDs im Rahmen markiert.`)); }} camera={mapCamera} onCameraChange={setMapCamera} />
              <div className="axis-chip"><i className="x" /> X <i className="y" /> Y <i className="z" /> Z</div>
              <div className="canvas-help">{selectionMode ? t('Drag a box to select LEDs', 'Rahmen ziehen, um LEDs zu markieren') : t('Drag: rotate · Wheel: zoom · Shift: select', 'Ziehen: drehen · Mausrad: zoomen · Shift: auswählen')}</div>
            </> : <>
              <FixturePreview language={language} panel={active} points={points} ledSize={settings.ledSize} interactive onTransform={updatePanelTransform} />
              <div className="stage-2d-controls">
                <label><span>{t('Rotation', 'Rotation')}</span><input type="range" min="-180" max="180" step="0.1" value={active?.transform.rotation ?? 0} onChange={event => active && updatePanelTransform({ ...active.transform, rotation: Number(event.target.value) })} /><output>{active?.transform.rotation.toFixed(1) ?? '0.0'}°</output></label>
                <div className="stage-snap-buttons"><button onClick={() => snapActive('horizontal')}>↔ Snap H</button><button onClick={() => snapActive('vertical')}>↕ Snap V</button><button className={active?.transform.flipX ? 'active' : ''} onClick={() => flipActive('horizontal')}>⇋ Flip H</button><button className={active?.transform.flipY ? 'active' : ''} onClick={() => flipActive('vertical')}>⇵ Flip V</button></div>
                <label><span>{t('Export size', 'Exportgröße')}</span><input type="range" min="0.25" max="4" step="0.01" value={active?.transform.scale ?? 1} onChange={event => active && updatePanelTransform({ ...active.transform, scale: Number(event.target.value) })} /><output>{Math.round((active?.transform.scale ?? 1) * 100)} %</output></label>
                <button className="stage-reset" onClick={() => updatePanelTransform({ rotation: 0, scale: 1, flipX: false, flipY: false })}>{t('Reset', 'Zurücksetzen')}</button>
              </div>
              <div className="canvas-help">{t('Drag: rotate · Wheel: export size', 'Ziehen: drehen · Mausrad: Exportgröße')}</div>
            </>}
          </div>
          <div className="stage-footer"><span><b>{numberFormat.format(points.length)}</b> Slots</span><span><b>{panels.length}</b> {t('regions', 'Bereiche')}</span><button className={`warning-button ${placeholders + outliers ? 'warning' : ''}`} onClick={openRepairReview}><b>{placeholders + outliers}</b> {t('review warnings', 'Warnungen prüfen')}</button><span className="status-message">{message}</span></div>
        </section>

        <aside className="rail right-rail">
          <div className="panel-heading"><div><span className="eyebrow">{t('REGIONS', 'BEREICHE')}</span><h2>{t('Panels & export', 'Panels & Export')}</h2></div><span className="count-chip">{enabledPanels.length}/{panels.length}</span></div>
          <div className="panel-list">{panels.map(panel => <div className={`panel-row ${panel.id === active?.id ? 'chosen' : ''}`} key={panel.id}><button className="panel-main" onClick={() => setActiveId(panel.id)}><span className="color-dot" style={{ background: panel.color }} /><span><strong>{panel.name}</strong><small>{numberFormat.format(panel.indices.length)} LEDs · #{panel.indices[0]}–{panel.indices.at(-1)}</small></span></button><label className="switch" title={t('Enabled for export', 'Für Export aktiv')}><input type="checkbox" checked={panel.enabled} onChange={() => togglePanel(panel.id)} /><i /></label></div>)}</div>
          {stageMode === '3d' ? <div className="fixture-preview">
            <div className="preview-title"><span className="eyebrow">{t('MADMAPPER 2D PREVIEW', 'MADMAPPER 2D-VORSCHAU')}</span><span>{active?.name ?? '—'}</span></div>
            <FixturePreview language={language} panel={active} points={points} ledSize={settings.ledSize} />
            <div className="preview-metrics"><span>{active ? `${active.transform.rotation.toFixed(1)}°` : '—'}</span><span>{active ? `${Math.round(active.transform.scale * 100)} %` : '—'}</span>{active?.transform.flipX && <span>Flip H</span>}{active?.transform.flipY && <span>Flip V</span>}</div>
            <div className="preview-actions"><button onClick={() => setStageMode('2d')}>⇄ {t('Show large', 'Groß anzeigen')}</button><button onClick={openRepairReview}>◇ Auto Repair</button></div>
            <p>{t('Best-fit plane · source order is preserved', 'Best-Fit-Ebene · Quellreihenfolge bleibt erhalten')}</p>
          </div> : <div className="fixture-preview swapped-preview">
            <div className="preview-title"><span className="eyebrow">{t('3D ORIENTATION', '3D-ORIENTIERUNG')}</span><span>{viewLabel}</span></div>
            <div className="mini-map-viewport"><MapCanvas language={language} points={points} panels={panels} selectionMode={false} onSelection={() => undefined} camera={mapCamera} onCameraChange={setMapCamera} /></div>
            <div className="preview-actions one"><button onClick={() => setStageMode('3d')}>⇄ {t('Show large 3D', '3D groß anzeigen')}</button></div>
            <p>{t('The camera position is retained when switching views.', 'Die Kameraposition bleibt beim Wechsel erhalten.')}</p>
          </div>}
          <button className="export-button" onClick={() => setShowExport(true)}>{t('Create fixture', 'Fixture erstellen')} <span>→</span></button>
        </aside>
      </section>

      {error && <div className="toast error" role="alert"><span>!</span>{error}<button aria-label={t('Close error', 'Fehler schließen')} onClick={() => setError('')}>×</button></div>}

      {showAdjust && active && <div className="modal-backdrop" onMouseDown={() => setShowAdjust(false)}><section className="modal adjust-modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="adjust-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowAdjust(false)}>×</button><span className="eyebrow">{t('2D ALIGNMENT', '2D-AUSRICHTUNG')}</span><h2 id="adjust-title">{t(`Adjust ${active.name}`, `${active.name} justieren`)}</h2><p className="modal-lead">{t('Drag the panel freely around its centre. Use the mouse wheel to change its export size.', 'Ziehe das Panel frei um seinen Mittelpunkt. Mit dem Mausrad veränderst du seine Exportgröße.')}</p>
        <div className="adjust-layout"><div className="adjust-preview"><FixturePreview language={language} panel={active} points={points} ledSize={settings.ledSize} interactive onTransform={updatePanelTransform} /><div className="adjust-hint">{t('Drag: rotate · Wheel: scale', 'Ziehen: drehen · Mausrad: skalieren')}</div></div><div className="adjust-controls">
          <div className="control-block"><div className="control-title"><span>{t('Rotation', 'Rotation')}</span><output>{active.transform.rotation.toFixed(1)}°</output></div><input type="range" min="-180" max="180" step="0.1" value={active.transform.rotation} onChange={event => updatePanelTransform({ ...active.transform, rotation: Number(event.target.value) })} /><div className="snap-buttons"><button onClick={() => snapActive('horizontal')}>↔ {t('Horizontal', 'Horizontal')}</button><button onClick={() => snapActive('vertical')}>↕ {t('Vertical', 'Vertikal')}</button></div></div>
          <div className="control-block"><div className="control-title"><span>{t('Flip', 'Spiegeln')}</span><output>{active.transform.flipX || active.transform.flipY ? [active.transform.flipX && 'H', active.transform.flipY && 'V'].filter(Boolean).join(' + ') : t('Off', 'Aus')}</output></div><div className="snap-buttons flip-buttons"><button className={active.transform.flipX ? 'active' : ''} onClick={() => flipActive('horizontal')}>⇋ {t('Flip horizontal', 'Horizontal flippen')}</button><button className={active.transform.flipY ? 'active' : ''} onClick={() => flipActive('vertical')}>⇵ {t('Flip vertical', 'Vertikal flippen')}</button></div></div>
          <div className="control-block"><div className="control-title"><span>{t('Export size', 'Exportgröße')}</span><output>{Math.round(active.transform.scale * 100)} %</output></div><div className="scale-control"><button aria-label={t('Decrease size', 'Verkleinern')} onClick={() => updatePanelTransform({ ...active.transform, scale: active.transform.scale - .05 })}>−</button><input type="range" min="0.25" max="4" step="0.01" value={active.transform.scale} onChange={event => updatePanelTransform({ ...active.transform, scale: Number(event.target.value) })} /><button aria-label={t('Increase size', 'Vergrößern')} onClick={() => updatePanelTransform({ ...active.transform, scale: active.transform.scale + .05 })}>＋</button></div><small>{t('Affects preview and exported pixel spacing.', 'Wirkt auf Vorschau und Exportabstände.')}</small></div>
          <button className="reset-button" onClick={() => updatePanelTransform({ rotation: 0, scale: 1, flipX: false, flipY: false })}>{t('Reset alignment', 'Ausrichtung zurücksetzen')}</button>
        </div></div>
        <div className="modal-actions"><button className="secondary-button" onClick={() => setShowAdjust(false)}>{t('Close', 'Schließen')}</button><button className="primary-button" onClick={() => { setShowAdjust(false); setMessage(`${active.name}: ${active.transform.rotation.toFixed(1)}° · ${Math.round(active.transform.scale * 100)} %${active.transform.flipX ? ' · Flip H' : ''}${active.transform.flipY ? ' · Flip V' : ''}.`); }}>{t('Apply alignment', 'Ausrichtung übernehmen')}</button></div>
      </section></div>}

      {showRepair && active && <div className="modal-backdrop" onMouseDown={() => setShowRepair(false)}><section className="modal repair-modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="repair-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowRepair(false)}>×</button><span className="eyebrow">{t('AUTO REPAIR · REVIEW', 'AUTO-REPAIR · VORSCHAU')}</span><h2 id="repair-title">{t('Review measurement errors', 'Messfehler kontrollieren')}</h2><p className="modal-lead">{t('Orange shows the current measurement and green shows the proposed position. Your map changes only after you apply the selected repairs.', 'Orange markiert die bisherige Messung, Grün die vorgeschlagene Position. Erst „Ausgewählte anwenden“ verändert deine Map.')}</p>
        <div className="repair-toolbar"><label>{t('Sensitivity', 'Prüfstufe')}<select value={repairSensitivity} onChange={event => changeRepairSensitivity(event.target.value as RepairSensitivity)}><option value="conservative">{t('Conservative · recommended', 'Konservativ · empfohlen')}</option><option value="balanced">{t('Balanced', 'Ausgewogen')}</option><option value="sensitive">{t('Sensitive', 'Empfindlich')}</option></select></label><div className="repair-zoom"><button aria-label={t('Zoom out', 'Verkleinern')} onClick={() => setRepairZoom(value => Math.max(1, value - .5))}>−</button><input aria-label={t('Repair preview zoom', 'Zoom der Reparaturvorschau')} type="range" min="1" max="8" step="0.1" value={repairZoom} onChange={event => setRepairZoom(Number(event.target.value))} /><output>{Math.round(repairZoom * 100)} %</output><button aria-label={t('Zoom in', 'Vergrößern')} onClick={() => setRepairZoom(value => Math.min(8, value + .5))}>＋</button></div></div>
        <RepairPreview language={language} key={active.id} panel={active} points={points} suggestions={repairSuggestions} zoom={repairZoom} onZoomChange={setRepairZoom} />
        <div className="repair-pan-hint">{t('Drag: pan · Wheel: zoom · Double-click: centre', 'Ziehen: Ausschnitt verschieben · Mausrad: zoomen · Doppelklick: zentrieren')}</div>
        <div className="repair-legend"><span><i className="original" /> {t('Original', 'Original')}</span><span><i className="proposed" /> {t('Proposed', 'Vorschlag')}</span><span>{selectedRepairCount}/{repairSuggestions.length} {t('selected', 'ausgewählt')}</span></div>
        <div className="repair-list">{repairSuggestions.length ? repairSuggestions.map(suggestion => <label className={`repair-row ${suggestion.selected ? 'selected' : ''}`} key={suggestion.id}><input type="checkbox" checked={suggestion.selected} onChange={() => setRepairSuggestions(items => items.map(item => item.id === suggestion.id ? { ...item, selected: !item.selected } : item))} /><span className="repair-index">#{suggestion.sourceIndex + 1}</span><span className="repair-copy"><strong>{repairReason(suggestion.reason)}</strong><small>{suggestion.before.map(value => value.toFixed(2)).join(' / ')} → {suggestion.after.map(value => value.toFixed(2)).join(' / ')}</small></span><span className={`confidence ${suggestion.confidence}`}>{confidenceLabel(suggestion.confidence)}</span></label>) : <div className="repair-empty">{t('No clear measurement errors were found at this sensitivity.', 'Mit dieser Prüfstufe wurden keine eindeutigen Messfehler gefunden.')}</div>}</div>
        <div className="repair-note">{t('“Conservative” only considers clearly bracketed gaps and strong deviations with enough supporting data. Use “Balanced” for borderline cases.', '„Konservativ“ berücksichtigt nur klar eingerahmte Lücken und starke Abweichungen mit ausreichender Sicherheit. Für Grenzfälle kannst du gezielt auf „Ausgewogen“ wechseln.')}</div>
        <div className="modal-actions"><button className="secondary-button" onClick={() => { setShowRepair(false); setRepairSuggestions([]); setMessage(t('Repair suggestions discarded — original data unchanged.', 'Reparaturvorschläge verworfen — Originaldaten unverändert.')); }}>{t('Cancel', 'Abbrechen')}</button><button className="primary-button repair-apply" disabled={!selectedRepairCount} onClick={applyRepairs}>{t(`Apply ${selectedRepairCount} selected`, `${selectedRepairCount} ausgewählte anwenden`)}</button></div>
      </section></div>}

      {showExport && <div className="modal-backdrop" onMouseDown={() => setShowExport(false)}><section className="modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="export-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowExport(false)}>×</button><span className="eyebrow">EXPORT</span><h2 id="export-title">{t('Create MadMapper fixture', 'MadMapper Fixture erstellen')}</h2><p className="modal-lead">{enabledPanels.length} {t(enabledPanels.length === 1 ? 'panel' : 'panels', enabledPanels.length === 1 ? 'Panel' : 'Panels')} · {numberFormat.format(enabledPanels.reduce((sum, panel) => sum + panel.indices.length, 0))} LEDs · {t('original order preserved', 'in Originalreihenfolge')}</p>
        <div className="form-grid"><label>Fixture Definition<input value={settings.definition} onChange={event => setSettings(current => ({ ...current, definition: event.target.value }))} /></label><label>{t('Channels per pixel', 'Kanäle pro Pixel')}<select value={settings.channels} onChange={event => setSettings(current => ({ ...current, channels: Number(event.target.value), definition: Number(event.target.value) === 4 ? 'Generic - Pixel RGBW' : 'Generic - Pixel RGB' }))}><option value={3}>RGB · 3</option><option value={4}>RGBW · 4</option></select></label><label>{t('Start universe', 'Start Universe')}<input type="number" min="0" max="32767" value={settings.universe} onChange={event => setSettings(current => ({ ...current, universe: Math.max(0, Number(event.target.value)) }))} /></label><label>{t('Start channel', 'Start Channel')}<input type="number" min="1" max="512" value={settings.channel} onChange={event => setSettings(current => ({ ...current, channel: Math.max(1, Math.min(512, Number(event.target.value))) }))} /></label><label>{t('Pixel size in MadMapper', 'Pixelgröße in MadMapper')}<input type="number" min="1" max="64" value={settings.ledSize} onChange={event => setSettings(current => ({ ...current, ledSize: Math.max(1, Number(event.target.value)) }))} /></label></div>
        <p className="file-name-preview">{t('Saved as', 'Wird gespeichert als')}: <strong>{safeName(settings.definition)}.[svg/csv/mmfl]</strong></p>
        <div className="format-cards"><button onClick={() => exportFile('svg')}><b>SVG 6.1</b><span>{t('Recommended', 'Empfohlen')}</span><small>{t('Exact freeform 2D positions, groups and DMX patch.', 'Exakte freie 2D-Positionen, Gruppen und DMX-Patch.')}</small></button><button onClick={() => exportFile('csv')}><b>CSV</b><span>{t('Alternative', 'Alternative')}</span><small>{t('Individual pixels with position, definition and patch.', 'Einzelpixel mit Position, Definition und Patch.')}</small></button><button onClick={() => exportFile('mmfl')}><b>MMFL</b><span>{t('Experimental', 'Experimentell')}</span><small>{t('Fixture Editor definition on a quantised grid.', 'Fixture-Editor-Definition auf quantisiertem Raster.')}</small></button></div>
        <div className="format-note"><strong>{t('Why 2D?', 'Warum 2D?')}</strong> {t('MadMapper does not import true XYZ fixture coordinates. The app projects every selected panel onto its local plane without altering the 3D map.', 'MadMapper importiert keine echten XYZ-Fixture-Koordinaten. Die App projiziert jedes gewählte Panel verlustarm auf seine lokale Ebene; die 3D-Map bleibt unverändert.')}</div>
      </section></div>}

      {showHelp && <div className="modal-backdrop" onMouseDown={() => setShowHelp(false)}><section className="modal help-modal" onMouseDown={event => event.stopPropagation()} aria-modal="true" role="dialog" aria-labelledby="help-title">
        <button className="modal-close" aria-label={t('Close', 'Schließen')} onClick={() => setShowHelp(false)}>×</button><span className="eyebrow">{t('FORMAT HELP', 'FORMAT-HILFE')}</span><h2 id="help-title">{t('Which format should I use?', 'Welches Format wofür?')}</h2>
        <div className="help-row"><b>Import</b><p>{t('Pixelblaze JSON, Marimapper 3D CSV ', 'Pixelblaze-JSON sowie Marimapper-3D-CSV ')}(<code>index,x,y,z,xn,yn,zn,error</code>) {t('and 2D CSV ', 'und 2D-CSV ')}(<code>index,u,v</code>). {t('Missing Marimapper indices remain available as repairable slots.', 'Fehlende Marimapper-Indizes bleiben als reparierbare Slots erhalten.')}</p></div>
        <div className="help-row"><b>SVG 6.1</b><p>{t('Use File → Import Fixtures. Each LED becomes its own fixture with current ', 'Für File → Import Fixtures. Jede LED wird als eigenes Fixture mit aktuellen ')}<code>universe</code>, <code>channel</code> {t('and', 'und')} <code>fixture_definition</code> {t('attributes.', 'Attributen angelegt.')}</p></div>
        <div className="help-row"><b>CSV</b><p>{t('A robust table alternative for fixture instances, semicolon-delimited and grouped by panel path.', 'Robuste Tabellenalternative für Fixture-Instanzen. Semikolon-getrennt und mit Gruppenpfaden pro Panel.')}</p></div>
        <div className="help-row"><b>MMFL</b><p>{t('For import in the Fixture Editor. It describes a 2D pixel grid and channel layout; internal details are not fully documented publicly.', 'Für den Import im Fixture Editor. Das Format beschreibt nur ein 2D-Pixelraster und Kanalbelegung; seine internen Details sind nicht vollständig öffentlich dokumentiert.')}</p></div>
        <div className="help-warning">{t('Legacy MadMapper 5 SVG attributes are intentionally omitted. The export follows the current 6.1 documentation.', 'Alte MadMapper-5-SVG-Attribute werden bewusst nicht verwendet. Der Export folgt der aktuellen 6.1-Dokumentation.')}</div>
      </section></div>}
    </main>
  );
}
